#!/usr/bin/env python3
"""
epub2gh — NAS(nas220)上のEPUB/PDFを章ごとのMarkdownに変換し、
age で暗号化して GitHub private リポジトリへ push する。

  ~/epub2gh/plain/   … 平文Markdown（Macローカルのみ。GitHubには上げない）
  ~/epub2gh/repo/    … 暗号化ファイルだけを置くgitリポジトリ

使い方:
  python epub2gh.py            # 新規ファイルだけ処理して push
  python epub2gh.py --dry-run  # 対象ファイルの確認のみ
  python epub2gh.py --force    # 変換済みも作り直す
  python epub2gh.py --no-push  # commitまで（pushしない）
  python epub2gh.py --auto     # 定期実行用（launchd）。新規がなければ何も出さずに終わる
  python epub2gh.py --file "/Volumes/data/calibre/books/著者/書名 (1)/本.epub" --no-push
                               # 指定した1ファイルだけ試す（ドラッグ&ドロップでパス入力可）
  python epub2gh.py --file ~/Desktop/写真集 --no-push
                               # 画像・PDF のフォルダか zip を 1 冊として試す

画像・PDF から作る本（img2book.py）
  calibre/books/_images/<書名>/ に画像・PDF・zip を置くと 1 冊として登録する。
  同じフォルダに足せば、その本の後ろに追加する。iPhone の登録画面（upload.html）から
  送ったものは、毎回の実行の最初に inbox.py がこのフォルダへ受け取る。
"""
import argparse, fcntl, hashlib, json, os, posixpath, re, shutil, subprocess, sys, tempfile, time, unicodedata, warnings, zipfile
from urllib.parse import unquote
from datetime import datetime
from pathlib import Path

VENV_PY = Path.home() / "epub2gh/.venv/bin/python"
try:
    import fitz  # PyMuPDF
    from bs4 import BeautifulSoup
    from ebooklib import epub, ITEM_DOCUMENT
    from markdownify import markdownify
except ImportError:
    # 部品の入っていない Python で起動された → setup.sh で作った専用環境で起動し直す
    if VENV_PY.exists() and not os.environ.get("EPUB2GH_REEXEC"):
        os.environ["EPUB2GH_REEXEC"] = "1"     # 起動し直しの繰り返しを防ぐ
        os.execv(str(VENV_PY), [str(VENV_PY), os.path.abspath(__file__)] + sys.argv[1:])
    sys.exit("必要な部品が入っていません。先に ./setup.sh を実行してください"
             f"（{VENV_PY} が作られます）")

warnings.filterwarnings("ignore")

# ---------- 外部コマンドの場所 ----------
# 自動実行（launchd）は PATH が狭く、/sbin（mount）や Homebrew（git・age・tesseract・ocrmypdf）の
# 場所が入っていないことがある。起動時に標準の場所を足す。os.environ を直すので、
# pytesseract や ocrmypdf が中で呼ぶ tesseract などにも効く
STD_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin"]


def fix_path():
    cur = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    for d in [str(Path(sys.executable).parent)] + STD_DIRS:
        if d not in cur and os.path.isdir(d):
            cur.append(d)
    os.environ["PATH"] = os.pathsep.join(cur)


fix_path()


def sys_cmd(name, fixed):
    """macOS 標準のコマンドは決まった場所にあるのでフルパスで呼ぶ（なければ PATH から探す）"""
    return fixed if os.path.exists(fixed) else (shutil.which(name) or name)


MOUNT = sys_cmd("mount", "/sbin/mount")
OSASCRIPT = sys_cmd("osascript", "/usr/bin/osascript")
SIPS = sys_cmd("sips", "/usr/bin/sips")
OPEN = sys_cmd("open", "/usr/bin/open")


def check_tools(need=("git", "age", "tesseract")):
    """必要なコマンドがそろっているか。足りなければ、どれがないのかを示して止める"""
    missing = [t for t in need if not shutil.which(t)]
    if missing:
        sys.exit(f"必要なコマンドが見つかりません: {', '.join(missing)}\n"
                 f"  探した場所: {os.environ['PATH']}\n"
                 "  Homebrew で入れてあるか（brew install " + " ".join(missing) + "）を確かめてください")


sys.path.insert(0, str(Path(__file__).resolve().parent))
import img2book, inbox   # 同じフォルダに置く（画像・PDF からの本、iPhone からの受け取り）

CONF_PATH = Path.home() / ".config/epub2gh/config.json"
DEFAULT_CONF = {
    "nas_host": "nas220",
    "nas_share": "data",           # SMB共有フォルダ名（smb://nas220/data）
    "src_subdirs": ["calibre/books"],  # 共有内の対象フォルダ。配下のサブフォルダはすべて対象
    "settle_seconds": 120,         # 更新から この秒数たっていないファイルはコピー中とみなして次回へ
    "prefer_epub": True,           # Calibreの同じ本のフォルダにEPUBとPDFがあればEPUBだけ処理
    "daily_limit": 20,             # 1日に変換する冊数の上限（手動と自動の合計。0=無制限）
    "convert_mode": "queue",       # "queue"=ビューアで「変換待ち」にした本だけ / "all"=未変換を全部
    "repo_dir": str(Path.home() / "epub2gh/repo"),
    "plain_dir": str(Path.home() / "epub2gh/plain"),
    "age_recipients": str(Path.home() / ".config/epub2gh/recipients.txt"),
    "age_identity": str(Path.home() / ".config/epub2gh/key.txt"),
    "ocr_langs": "jpn+jpn_vert+eng",
    "pdf_chunk_pages": 20,         # PDFに目次（しおり）がない場合の分割ページ数
    "keep_ruby": False,            # True: ルビを「漢字（かんじ）」形式で残す
    "viewer_url": "",              # 要約ビューア（claude.aiのページ）のURL。設定すると処理後に開く
    "images_dir": "calibre/books/_images",  # 画像・PDF から作る本の置き場（共有内）。1 フォルダ = 1 冊
    "images_auto": True,           # True: 画像の本は「変換待ち」にしなくても処理する（1日の上限には数える）
    "pdf_figures": True,           # True: Calibre の PDF からも図を切り出す（本文は変えない）
}
EXTS = {".epub", ".pdf"}
SKIP_PARTS = {"@eaDir", "#recycle", ".Trash", "#snapshot"}
CJK = r"\u3000-\u30ff\u3400-\u9fff\uff00-\uffef"


# ---------- 共通 ----------
def load_conf():
    c = dict(DEFAULT_CONF)
    if CONF_PATH.exists():
        c.update(json.loads(CONF_PATH.read_text(encoding="utf-8")))
    return c


def run(cmd, cwd=None, check=True):
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def find_mount(c):
    """smb://nas220/data がどこにマウントされているか（/Volumes/data とは限らない）"""
    out = run([MOUNT], check=False).stdout
    pat = re.compile(rf"//(?:[^@\s]*@)?{re.escape(c['nas_host'])}(?:[.:][^/\s]*)?/{re.escape(c['nas_share'])} on (.+?) \(smbfs",
                     re.I)
    for line in out.splitlines():
        m = pat.search(line)
        if m:
            return Path(m.group(1))
    return None


def ensure_mount(c, quiet=False):
    vol = find_mount(c)
    if not vol:
        url = f"smb://{c['nas_host']}/{c['nas_share']}"
        if not quiet:
            print(f"NASをマウント中: {url}")
        # 認証はmacOSキーチェーンを使用（初回はFinderで接続してパスワード保存）
        subprocess.run([OSASCRIPT, "-e", f'mount volume "{url}"'], capture_output=True)
        vol = find_mount(c)
    return vol


def check_nas_access(vol, c, auto=False, limit=60):
    """NAS のフォルダの中身が読めるか。macOS のプライバシー保護で止められていると、
       本の一覧が黙って 0 冊になるので、先に確かめて止める。
       cron などから初めて読むときは、許可の確認の返事を待ったまま止まることがあるので、
       limit 秒で返ってこなければ、理由を書いて終わる"""
    import threading
    res = {}
    th = threading.Thread(target=lambda: res.update(r=_nas_access(vol, c)), daemon=True)
    th.start()
    th.join(limit)
    if th.is_alive():
        msg = (f"NAS が {limit} 秒たっても応答しません: {vol}\n"
               "  macOS の許可の確認（「ネットワークボリューム上のファイルにアクセスしようとしています」）が\n"
               "  返事待ちになっているか、NAS が止まっている可能性があります。\n"
               "  システム設定 > プライバシーとセキュリティ > フルディスクアクセス で、実行しているもの\n"
               "  （cron なら /usr/sbin/cron）を許可してください")
        print(msg, file=sys.stderr, flush=True)
        if auto:
            notify("NAS が応答しません。ログを見てください")
        sys.stdout.flush(); sys.stderr.flush()
        os._exit(2)                              # 待ったままの読み取りがあっても終わる
    d = res.get("r")
    if d is not None:
        py = os.path.realpath(sys.executable)
        app = py.split("/Versions/")[0] + "/Versions/" + py.split("/Versions/")[1].split("/")[0] \
            + "/Resources/Python.app" if "/Versions/" in py else py
        msg = (f"NAS のフォルダを読む許可がありません: {d}\n"
               "  システム設定 > プライバシーとセキュリティ > フルディスクアクセス で、実行しているものを許可してください。\n"
               "    cron から動かしているとき: /usr/sbin/cron\n"
               f"    launchd から動かしているとき: {app}")
        if auto:
            notify("NAS を読む許可がありません。ログを見てください")
        sys.exit(msg)


def _nas_access(vol, c):
    """読めないフォルダを返す（すべて読めれば None）"""
    for sub in list(c["src_subdirs"]) + [c["images_dir"]]:
        d = vol / sub
        if not d.is_dir():
            continue
        try:
            with os.scandir(d) as it:
                next(it, None)
        except PermissionError:
            return d
    return None


def notify(msg):
    msg = msg.replace("\\", "").replace('"', "”")
    try:
        subprocess.run([OSASCRIPT, "-e", f'display notification "{msg}" with title "epub2gh"'],
                       capture_output=True)
    except OSError:
        pass                                     # 通知が出せなくても処理は続ける


def calibre_meta(p):
    """Calibreが本ごとのフォルダに置く metadata.opf から書名と著者を読む"""
    opf = p.parent / "metadata.opf"
    if not opf.exists():
        return {}
    try:
        soup = BeautifulSoup(opf.read_bytes(), "xml")
        t = soup.find("dc:title") or soup.find("title")
        authors = [a.get_text(strip=True) for a in (soup.find_all("dc:creator") or soup.find_all("creator"))]
        return {"title": t.get_text(strip=True) if t else None, "authors": [a for a in authors if a]}
    except Exception:
        return {}


def epub_meta(p):
    """EPUB内のOPFから書名と著者を読む（中身は変換しない）"""
    try:
        with zipfile.ZipFile(p) as z:
            cont = BeautifulSoup(z.read("META-INF/container.xml"), "xml")
            soup = BeautifulSoup(z.read(cont.find("rootfile")["full-path"]), "xml")
        t = soup.find("dc:title") or soup.find("title")
        cr = soup.find_all("dc:creator") or soup.find_all("creator")
        return {"title": t.get_text(strip=True) if t else None,
                "authors": [a.get_text(strip=True) for a in cr if a.get_text(strip=True)]}
    except Exception:
        return {}


def book_info(p):
    """一覧用の書名・著者（Calibre → EPUB内 → ファイル名の順に探す）"""
    m = calibre_meta(p)
    if not m.get("title") and p.suffix.lower() == ".epub":
        e = epub_meta(p)
        m = {"title": e.get("title"), "authors": m.get("authors") or e.get("authors", [])}
    return {"title": m.get("title") or p.stem, "authors": m.get("authors") or []}


def load_queue(c):
    """ビューアで「変換待ち」にした本（暗号化された queue.json.age）を順番どおりに返す"""
    q = Path(c["repo_dir"]) / "queue.json.age"
    if not q.exists():
        return []
    r = run(["age", "-d", "-i", c["age_identity"], str(q)], check=False)
    if r.returncode:
        print(f"変換待ち一覧を読めませんでした: {r.stderr.strip()}", file=sys.stderr)
        return []
    try:
        return [str(i["bid"]) for i in json.loads(r.stdout).get("items", []) if i.get("bid")]
    except Exception:
        return []


def load_settings(c):
    """書庫の「夜間処理の状況」で変えた設定（暗号化された settings.json.age）。なければ {}"""
    f = Path(c["repo_dir"]) / "settings.json.age"
    if not f.exists():
        return {}
    r = run(["age", "-d", "-i", c["age_identity"], str(f)], check=False)
    try:
        return json.loads(r.stdout) if r.returncode == 0 else {}
    except Exception:
        return {}


# ---------- 重複している本 ----------
# 同じ本が NAS に複数ある（別のフォルダに入れ直した・形式違い・版の表記違い）とき、1 冊だけを残して
# ほかに「重複」の印（dup_of＝残す本の bid）を付ける。書庫はこの印を見て「重複」と表示し、変換待ちにできなくする
EDITION_RE = re.compile(r"[(\[【〔][^)\]】〕]*(?:文庫|新書|kindle|電子|版|edition|コミックス|ノベルス|ブックス|books)[^)\]】〕]*[)\]】〕]", re.I)
NOISE_RE = re.compile(r"[\s・･、。,.:;!?\-‐－—―~〜「」『』\"'`]")


def norm_title(t):
    """書名を比べるための形にする。空白・記号・版の表記（(角川文庫)・Kindle版 など）の違いは無視し、
       上下巻（上・下・1・2）などの違いは残す"""
    t = unicodedata.normalize("NFKC", t or "").lower()
    t = EDITION_RE.sub("", t)
    t = re.sub(r"kindle版|電子書籍版|電子版", "", t)
    return NOISE_RE.sub("", t)


def mark_dups(inv, catalog, queue, not_dup):
    """inv の各本に dup_of を付け直す。戻り値: 重複の bid の集合"""
    qpos = {b: i for i, b in enumerate(queue)}
    groups = {}
    for b in inv:
        b.pop("dup_of", None)
        if b.get("type") == "image" or b["bid"] in not_dup:
            continue
        t = norm_title(b.get("title"))
        if not t:
            continue
        au = NOISE_RE.sub("", unicodedata.normalize("NFKC", (b.get("authors") or [""])[0]).lower())
        groups.setdefault((t, au), []).append(b)
    dups = set()
    for g in groups.values():
        if len(g) < 2:
            continue
        # 残す 1 冊：変換済み → 先に変換待ちにしたもの → EPUB → 大きいファイル → パスの順
        g.sort(key=lambda b: (b["bid"] not in catalog, qpos.get(b["bid"], 1e9),
                              b.get("type") != "epub", -(b.get("size") or 0), b.get("path", "")))
        keep = g[0]
        for b in g[1:]:
            if b["bid"] in catalog:
                continue                         # すでに変換した本は重複にしない（そのまま読める）
            b["dup_of"] = keep["bid"]
            dups.add(b["bid"])
    return dups


def save_inventory(inv, c, plain_root):
    """NAS上の本の一覧を、変わったときだけ暗号化して置く。変わったら True"""
    ipath = plain_root / "inventory.json"
    data = json.dumps({"books": sorted(inv, key=lambda x: x["path"])}, ensure_ascii=False, indent=1)
    dst = Path(c["repo_dir"]) / "inventory.json.age"
    if ipath.exists() and ipath.read_text(encoding="utf-8") == data and dst.exists():
        return False
    ipath.write_text(data, encoding="utf-8")
    encrypt(ipath, dst, c)
    return True


def file_sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def safe(s, n=50):
    s = re.sub(r'[\\/:*?"<>|\s]+', "_", s or "").strip("_.")
    return s[:n] or "untitled"


def encrypt(src, dst, c):
    run(["age", "-R", c["age_recipients"], "-o", str(dst), str(src)])


# ---------- EPUB ----------
IMG_TOKEN_RE = re.compile(r"ZQXIMG(\d+)ZQX")   # 挿絵の位置の目印（本文には残らない）


def html_to_md(html, keep_ruby, on_img=None):
    """on_img を渡すと、挿絵を消す代わりに目印に置き換えた Markdown も返す（本文の段落は変わらない）"""
    soup = BeautifulSoup(html, "lxml")
    for t in soup(["script", "style", "rp"]):
        t.decompose()
    if not on_img:
        for t in soup(["img", "image", "svg"]):
            t.decompose()
    else:
        # 画像だけを包んでいる文字のないリンクや飾り（<a><img></a> など）は、元の変換では丸ごと消えていた。
        # 同じ結果になるよう、その外側ごと目印に置き換える
        INLINE = {"a", "span", "strong", "b", "em", "i", "u", "small", "big", "sup", "sub", "font", "s",
                  "del", "ins", "mark", "q", "cite", "abbr", "dfn", "label", "code"}
        for t in list(soup(["svg", "img", "image"])):
            if t.parent is None or (t.name in ("img", "image") and t.find_parent("svg")):
                continue                                   # すでに置き換えた / svg の中は svg ごと扱う
            target = t
            while target.parent is not None and target.parent.name in INLINE and not target.parent.get_text(strip=True) \
                    and len([x for x in target.parent.contents if not (isinstance(x, str) and not x.strip())]) == 1:
                target = target.parent
            ims = [t] if t.name in ("img", "image") else t.find_all(["image", "img"])
            toks = "".join(filter(None, (on_img(im) for im in ims)))
            if toks:
                target.replace_with(toks)
            else:
                target.decompose()
    for r in soup.find_all("ruby"):
        rts = [rt.extract().get_text() for rt in r.find_all("rt")]
        if keep_ruby and rts:
            r.append(f"（{''.join(rts)}）")
        r.unwrap()
    head = soup.find(["h1", "h2", "h3"]) or soup.title
    title = IMG_TOKEN_RE.sub("", head.get_text(strip=True)).strip() if head else ""
    raw = markdownify(str(soup.body or soup), heading_style="ATX")
    md = IMG_TOKEN_RE.sub("", raw)
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    return (title, md, raw) if on_img else (title, md)


def convert_epub(src, c, images=None):
    """images に dict を渡すと、章番号ごとに挿絵の情報（どの段落のあとか）を入れて返す"""
    book = epub.read_epub(str(src))
    meta = book.get_metadata("DC", "title")
    book_title = meta[0][0] if meta else src.stem

    toc = {}
    def walk(items):
        for it in items:
            node, kids = (it if isinstance(it, tuple) else (it, []))
            href = getattr(node, "href", None)
            if href:
                toc.setdefault(href.split("#")[0], getattr(node, "title", ""))
            walk(kids)
    walk(book.toc)

    chapters = []
    pending = []                         # 文字のないページ（扉絵など）の挿絵 → 次の章の頭に置く
    for idref, _ in book.spine:
        item = book.get_item_with_id(idref)
        if not item or item.get_type() != ITEM_DOCUMENT:
            continue
        found = []
        def on_img(tag, item=item, found=found):
            ref = tag.get("src") or tag.get("xlink:href") or tag.get("href")
            if not ref or ref.startswith(("data:", "http:", "https:")):
                return None
            path = posixpath.normpath(posixpath.join(posixpath.dirname(item.get_name()), unquote(ref.split("#")[0])))
            it = book.get_item_with_href(path)
            if not it:
                return None
            found.append({"href": path, "alt": tag.get("alt", "") or "", "data": it.get_content(),
                          "media": getattr(it, "media_type", "") or ""})
            return f"ZQXIMG{len(found) - 1}ZQX"
        if images is None:
            h, md = html_to_md(item.get_content(), c["keep_ruby"])
        else:
            h, md, raw = html_to_md(item.get_content(), c["keep_ruby"], on_img)
        if len(md) < 20:  # 表紙・空ページなど
            if images is not None:
                pending += found
            continue
        title = toc.get(item.get_name()) or h or f"part{len(chapters) + 1}"
        chapters.append((title, md))
        if images is not None:
            images[len(chapters)] = {"raw": raw, "found": found, "pending": pending}
            pending = []
    return book_title, chapters


# ---------- 挿絵と図 ----------
IMG_MAX = 1400       # 長い辺のピクセル数の上限
IMG_MIN = 48         # これより小さい画像（飾り・記号）は省く


def place_images(no, raw, found, pending, blocks):
    """目印の前にある文字数（空白を除く）から、どの段落のあとに置くかを決める。段落の番号は変えない"""
    cum, total = [], 0
    for b in blocks:
        total += len(re.sub(r"\s", "", b["text"]))
        cum.append(total)
    out = [(f"c{no}-b-1", im) for im in pending]      # 扉絵など：章の見出しより前に置く
    for m in IMG_TOKEN_RE.finditer(raw):
        before = len(re.sub(r"\s", "", IMG_TOKEN_RE.sub("", raw[:m.start()])))
        i = next((k for k, v in enumerate(cum) if v >= before), len(cum) - 1) if before else -1
        out.append((blocks[i]["id"] if i >= 0 and blocks else f"c{no}-b0", found[int(m.group(1))]))
    return out


def image_file(data, media, tmp):
    """縮小して JPEG（透過のあるものは PNG）にする。小さすぎる画像は None"""
    if "svg" in media:
        return data, "svg", "image/svg+xml", 0, 0
    try:
        pix = fitz.Pixmap(data)
        w, h, alpha = pix.width, pix.height, bool(pix.alpha)
    except Exception:
        return None
    if min(w, h) < IMG_MIN:
        return None
    src = tmp / "in.bin"; src.write_bytes(data)
    png = alpha or "gif" in media or "png" in media and len(data) < 150_000
    out = tmp / ("out.png" if png else "out.jpg")
    cmd = [SIPS, "-s", "format", "png" if png else "jpeg"] + ([] if png else ["-s", "formatOptions", "78"])
    if max(w, h) > IMG_MAX:
        cmd += ["-Z", str(IMG_MAX)]
    r = subprocess.run(cmd + [str(src), "--out", str(out)], capture_output=True, text=True, timeout=60)
    if r.returncode or not out.exists():
        return None
    k = min(1.0, IMG_MAX / max(w, h))
    return out.read_bytes(), ("png" if png else "jpg"), ("image/png" if png else "image/jpeg"), round(w * k), round(h * k)


def hidden_figures(bid, c):
    """書庫で「この図を消す」を選んだ図のハッシュ（hidden/<bid>.json.age）"""
    f = Path(c["repo_dir"]) / "hidden" / f"{bid}.json.age"
    if not f.exists():
        return set()
    r = run(["age", "-d", "-i", c["age_identity"], str(f)], check=False)
    try:
        return {i["sha"] for i in json.loads(r.stdout).get("items", []) if i.get("sha")}
    except Exception:
        print(f"  消した図の一覧を読めませんでした: {r.stderr.strip()}", file=sys.stderr)
        return set()


def write_images(bid, chapters, images, c, bundle_chapters=None):
    """挿絵を暗号化して images/<bid>/ に置き、books/<bid>/images.json.age に位置の一覧を置く。
       bundle_chapters を渡すと、その段落（以前に変換した本文）と照らし合わせ、合わない章には付けない"""
    repo = Path(c["repo_dir"])
    idir = repo / "images" / bid
    shutil.rmtree(idir, ignore_errors=True)
    idir.mkdir(parents=True)
    items, seen, skipped = [], {}, 0
    hidden = hidden_figures(bid, c)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for no, (t, md) in enumerate(chapters, 1):
            info = images.get(no)
            if not info:
                continue
            blocks = to_blocks(no, md)
            if bundle_chapters is not None:
                old = bundle_chapters[no - 1]["blocks"] if no - 1 < len(bundle_chapters) else None
                if not old or [b["text"] for b in old] != [b["text"] for b in blocks]:
                    skipped += 1
                    continue
            for after, im in place_images(no, info["raw"], info["found"], info["pending"], blocks):
                key = im["href"]
                if key not in seen:
                    r = image_file(im["data"], im["media"], tmp)
                    if not r:
                        seen[key] = None
                        continue
                    data, ext, typ, w, h = r
                    sha = hashlib.sha256(data).hexdigest()[:16]   # 書庫が復号した中身と同じハッシュ
                    if sha in hidden:
                        seen[key] = None                 # 書庫で消した図
                        continue
                    k = len([v for v in seen.values() if v]) + 1
                    plain = tmp / f"{k}.{ext}"; plain.write_bytes(data)
                    encrypt(plain, idir / f"{k}.{ext}.age", c)
                    seen[key] = {"src": f"images/{bid}/{k}.{ext}.age", "type": typ, "w": w, "h": h, "sha": sha}
                if seen[key]:
                    items.append({"id": f"i{len(items) + 1}", "after": after, "alt": im["alt"][:120], **seen[key]})
        man = tmp / "images.json"
        man.write_text(json.dumps({"v": 1, "images": items}, ensure_ascii=False), encoding="utf-8")
        (repo / "books" / bid).mkdir(parents=True, exist_ok=True)
        encrypt(man, repo / "books" / bid / "images.json.age", c)
    if not any(idir.iterdir()):
        idir.rmdir()
    return len(items), skipped


# ---------- PDF ----------
def clean_pdf_text(t):
    t = re.sub(rf"(?<=[{CJK}]) +(?=[{CJK}])", "", t)  # OCRの和文間スペース除去
    out = []
    for line in (l.strip() for l in t.splitlines()):
        if not line:
            out.append("\n\n"); continue
        out.append(line)
        if re.search(r"[。！？」』）.!?:：]$", line):
            out.append("\n")
        elif not re.match(rf"[{CJK}]", line[-1]):
            out.append(" ")
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


def figure_raw(befores):
    """place_images に渡す目印つきの文字列を作る。目印の前に置く文字数＝図より前の本文の文字数"""
    raw, pos = "", 0
    for k, b in sorted(enumerate(befores), key=lambda x: x[1]):
        raw += "x" * max(0, b - pos) + f"ZQXIMG{k}ZQX"
        pos = max(pos, b)
    return raw


def nonws(t):
    return len(re.sub(r"\s", "", t))


def img_conf(c):
    return {"ocr_langs": c["ocr_langs"], "pages_per_chapter": c["pdf_chunk_pages"], "fig_max_edge": IMG_MAX}


def pdf_figures(doc, pages, ranges, scanned, c, images, log=print):
    """PDF の各ページから図を切り出し、write_images 用の情報を images に入れる。本文は変えない"""
    ic = {**img2book.DEFAULTS, **img_conf(c)}
    n_fig = 0
    for no, (t, s, e) in enumerate([r for r in ranges if any(pages[i] for i in range(r[1], r[2]))], 1):
        found, befores, done = [], [], 0
        for i in range(s, e):
            page = doc[i]
            try:
                figs = (img2book.scanned_pdf_figures if scanned else img2book.text_pdf_figures)(page, ic)
            except Exception as ex:
                log(f"  p.{i + 1} の図を切り出せませんでした: {ex}")
                figs = []
            if figs:
                words = page.get_text("words")
                for y, data in figs:
                    above = sum(nonws(w[4]) for w in words if w[1] < y)
                    befores.append(done + min(above, nonws(pages[i])))
                    found.append({"href": f"p{i + 1}-{len(found) + 1}", "alt": "", "data": data,
                                  "media": "image/jpeg"})
            done += nonws(pages[i])
        if found:
            images[no] = {"raw": figure_raw(befores), "found": found, "pending": []}
            n_fig += len(found)
    return n_fig


def convert_pdf(src, c, images=None):
    doc = fitz.open(src)
    chars = sum(len(p.get_text("text").strip()) for p in doc)
    tmpdir = None
    scanned = bool(doc.page_count and chars / doc.page_count < 30)
    if scanned:  # テキスト層なし＝スキャンPDF
        print("  OCR実行中（時間がかかります）…")
        tmpdir = tempfile.mkdtemp()
        ocr = Path(tmpdir) / "ocr.pdf"
        check_tools(("ocrmypdf",))
        run(["ocrmypdf", "-l", c["ocr_langs"], "--skip-text", "--output-type", "pdf",
             "--jobs", "4", "-q", str(src), str(ocr)])
        doc = fitz.open(ocr)

    title = (doc.metadata or {}).get("title") or src.stem
    pages = [clean_pdf_text(p.get_text("text")) for p in doc]
    n = len(pages)
    top = [(t, p) for lvl, t, p in doc.get_toc() if lvl == 1 and 1 <= p <= n]

    ranges = []
    if len(top) >= 2:
        if top[0][1] > 1:
            ranges.append(("前付け", 0, top[0][1] - 1))
        for i, (t, p) in enumerate(top):
            end = top[i + 1][1] - 1 if i + 1 < len(top) else n
            ranges.append((t, p - 1, max(end, p)))
    else:
        k = c["pdf_chunk_pages"]
        ranges = [(f"p{s + 1}-{min(s + k, n)}", s, min(s + k, n)) for s in range(0, n, k)]

    chapters = []
    for t, s, e in ranges:
        body = "\n\n".join(f"<!-- p.{i + 1} -->\n{pages[i]}" for i in range(s, e) if pages[i])
        if body.strip():
            chapters.append((t, body))
    if images is not None and c["pdf_figures"]:
        if scanned:
            print("  図を探しています…")
        pdf_figures(doc, pages, ranges, scanned, c, images)
    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return title, chapters


# ---------- 画像・PDF から作る本 ----------
FIG_MARK_RE = re.compile(r"!\[図\]\(fig/([^)]+)\)")
PAGE_MARK_RE = re.compile(r"<!-- p\.\d+ -->")


def is_image_book(p, c, vol=None):
    if p.is_dir() or p.suffix.lower() == ".zip":
        return True
    if vol:
        try:
            return str(p.relative_to(vol)).startswith(c["images_dir"].rstrip("/") + "/")
        except ValueError:
            pass
    return False


def image_sig(p):
    """フォルダの中身が変わったか（ファイル名・大きさ・更新日時）。変わっていたら追加分を処理する"""
    if p.is_file():
        st = p.stat()
        return hashlib.sha256(f"{p.name}:{st.st_size}:{int(st.st_mtime)}".encode()).hexdigest()[:16], st.st_mtime
    items, newest = [], 0
    for f in sorted(p.rglob("*")):
        rel = f.relative_to(p)
        if not f.is_file() or any(x in SKIP_PARTS or x.startswith(".") for x in rel.parts):
            continue
        if f.suffix.lower() not in img2book.DOC_EXT | {".zip"}:
            continue
        st = f.stat()
        items.append(f"{rel}:{st.st_size}:{int(st.st_mtime)}")
        newest = max(newest, st.st_mtime)
    return (hashlib.sha256("\n".join(items).encode()).hexdigest()[:16] if items else None), newest


def image_bid(rel):
    return hashlib.sha256(f"img:{rel}".encode()).hexdigest()[:12]   # フォルダごとに決まる（中身が増えても同じ）


def scan_images(vol, c, catalog, force, log=print, fresh=()):
    """_images の下のフォルダ（と直下の zip・PDF）を 1 冊ずつ調べる。
       fresh … 今回 iPhone から受け取ったフォルダ名。書き終わっているので待たずに処理する"""
    root = vol / c["images_dir"]
    if not root.is_dir():
        return [], [], 0
    now = time.time()
    targets, inv, waiting = [], [], 0
    for p in sorted(root.iterdir(), key=lambda x: img2book.natural_key(x.name)):
        if p.name.startswith((".", "@", "#")) or not (p.is_dir() or p.suffix.lower() in {".zip", ".pdf"}):
            continue
        rel = str(p.relative_to(vol))
        sig, newest = image_sig(p)
        if not sig:
            continue
        bid = image_bid(rel)
        title = img2book.book_title(p)
        inv.append({"bid": bid, "title": title, "authors": [], "type": "image", "path": rel, "size": 0,
                    "added": datetime.fromtimestamp(newest).strftime("%Y-%m-%d")})
        if now - newest < c["settle_seconds"] and p.name not in fresh:
            waiting += 1                         # まだ送っている途中かもしれない
            continue
        if not force and catalog.get(bid, {}).get("img_sig") == sig:
            continue
        targets.append((p, rel, bid))
    return targets, inv, waiting


def convert_images(src, bid, c, force=False, log=print):
    """画像・PDF のフォルダ（zip）を 1 冊にする。前回までのページは作り直さず、増えた分だけ文字起こしする"""
    work = Path(c["plain_dir"]) / "_images" / bid
    if force:
        shutil.rmtree(work, ignore_errors=True)
    ic = img_conf(c)
    added = img2book.update_book(src, work, ic, log=lambda m: log(m))
    log(f"  文字起こし: {added} ページ追加")
    chapters, images = [], {}
    for t, body in img2book.build_chapters(work, ic):
        found, befores = [], []
        for m in FIG_MARK_RE.finditer(body):
            before = PAGE_MARK_RE.sub("", FIG_MARK_RE.sub("", body[:m.start()]))
            befores.append(nonws(before))
            f = work / "fig" / m.group(1)
            if f.exists():
                found.append({"href": m.group(1), "alt": "", "data": f.read_bytes(), "media": "image/jpeg"})
            else:
                befores.pop()
        md = re.sub(r"\n{3,}", "\n\n", FIG_MARK_RE.sub("", body)).strip()
        if not to_blocks(1, md):                 # 図だけの章：図を付ける段落を 1 つ用意する
            pm = PAGE_MARK_RE.search(body)
            md = f"{pm.group(0) if pm else ''}\n（図のみのページ）".strip()
        chapters.append((t, md))
        if found:
            images[len(chapters)] = {"raw": figure_raw(befores), "found": found, "pending": []}
    return img2book.book_title(src), chapters, images


# ---------- 出力 ----------
def to_blocks(no, md):
    """章本文を段落ブロックに分割。各ブロックにIDと位置ラベル（PDF: p.N / EPUB: ¶N）を付ける"""
    blocks, page, n = [], None, 0
    for para in re.split(r"\n\s*\n", md):
        m = re.match(r"\s*<!-- p\.(\d+) -->\s*", para)
        if m:
            page = int(m.group(1))
            para = para[m.end():]
        para = para.strip()
        if not para:
            continue
        n += 1
        blocks.append({"id": f"c{no}-b{n}",
                       "label": f"p.{page}" if page else f"¶{n}",
                       "text": para})
    return blocks


def write_book(bid, title, src_rel, chapters, c, kind, authors=()):
    plain = Path(c["plain_dir"]) / f"{safe(title)}_{bid}"
    enc = Path(c["repo_dir"]) / "books" / bid
    for d in (plain, enc):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)

    entries = []
    bundle = {"id": bid, "title": title, "author": " / ".join(authors), "type": kind,
              "src": src_rel, "chapters": []}
    idx = [f"# {title}", ""] + ([f"- 著者: {' / '.join(authors)}"] if authors else []) + [
           f"- 元ファイル: {src_rel}",
           f"- 変換日時: {datetime.now():%Y-%m-%d %H:%M}", "", "## 目次"]
    for i, (t, md) in enumerate(chapters, 1):
        name = f"{i:03d}_{safe(t)}.md"
        (plain / name).write_text(f"# {t}\n\n{md}\n", encoding="utf-8")
        idx.append(f"- [{t}]({name})")
        encrypt(plain / name, enc / f"{i:03d}.md.age", c)  # GitHub上はタイトルが見えない名前
        entries.append({"no": i, "title": t, "path": str(plain / name),
                        "repo_path": f"books/{bid}/{i:03d}.md.age"})
        bundle["chapters"].append({"no": i, "title": t, "blocks": to_blocks(i, md)})
    (plain / "000_README.md").write_text("\n".join(idx) + "\n", encoding="utf-8")
    encrypt(plain / "000_README.md", enc / "000.md.age", c)

    # 要約ビューアに読み込ませる bundle.json（平文。Macローカルのみ）
    data = json.dumps(bundle, ensure_ascii=False)
    (plain / "bundle.json").write_text(data, encoding="utf-8")
    encrypt(plain / "bundle.json", enc / "bundle.json.age", c)   # GitHub版の本棚ビューア用（暗号化）
    up = Path(c["plain_dir"]) / "_upload"   # 未取り込み分をここに集める
    up.mkdir(exist_ok=True)
    (up / f"{safe(title, 40)}_{bid}.json").write_text(data, encoding="utf-8")
    return plain, entries


def save_catalog(cpath, catalog, c):
    tmp = cpath.with_suffix(".tmp")
    tmp.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(cpath)  # 途中で落ちても壊れないよう置き換え保存
    encrypt(cpath, Path(c["repo_dir"]) / "index.json.age", c)  # 書名一覧も暗号化して保存


def backfill_bundles(catalog, c):
    """以前に変換した本の bundle.json も、GitHub版ビューア用に暗号化して置く"""
    n = 0
    for bid, e in catalog.items():
        src = Path(e.get("bundle", ""))
        dst = Path(c["repo_dir"]) / "books" / bid / "bundle.json.age"
        if src.is_file() and not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            encrypt(src, dst, c)
            n += 1
    return n


def needs_push(repo):
    """未コミットの変更か、まだ送っていないコミットがあるか"""
    if run(["git", "status", "--porcelain"], cwd=repo, check=False).stdout.strip():
        return True
    r = run(["git", "rev-list", "--count", "@{u}..HEAD"], cwd=repo, check=False)
    return r.returncode != 0 or r.stdout.strip() not in ("", "0")


def git_push(repo, n):
    run(["git", "add", "-A"], cwd=repo)
    if not needs_push(repo):
        print("変更なし"); return
    if run(["git", "status", "--porcelain"], cwd=repo).stdout.strip():
        run(["git", "commit", "-m", f"update: {n} new books ({datetime.now():%Y-%m-%d})"], cwd=repo)
    for tries in range(3):
        r = run(["git", "push", "-u", "origin", "HEAD"], cwd=repo, check=False)
        if r.returncode == 0:
            break
        if tries == 2 or "rejected" not in r.stderr and "fetch first" not in r.stderr:
            raise subprocess.CalledProcessError(r.returncode, r.args, r.stdout, r.stderr)
        # 処理の間に書庫や iPhone が書き込んでいた → 最新を取り込んで送り直す
        print("GitHub に新しい変更があったので、取り込んでから送り直します")
        run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo)
    print("GitHubへpushしました")


def load_json(p, default):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except Exception:
        return default


def save_json(p, data):
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def scan(vol, c, catalog, cache, force, log=print, kpath=None):
    """NASを走査して処理対象を返す。ハッシュ計算はサイズか更新日時が変わったファイルだけ"""
    now = time.time()
    files = sorted(
        p for sub in c["src_subdirs"] if (vol / sub).is_dir() for p in (vol / sub).rglob("*")
        if p.is_file() and p.suffix.lower() in EXTS and not p.name.startswith("._")
        and not SKIP_PARTS & set(p.parts)
        and not str(p.relative_to(vol)).startswith(c["images_dir"].rstrip("/") + "/")   # 画像の本は別に扱う
    )
    targets, waiting, moved, seen, inv = [], 0, False, set(), []
    hashed = 0
    log(f"NAS上のファイル: {len(files)} 件。新しいファイルを照合しています…")
    for k, p in enumerate(files, 1):
        rel = str(p.relative_to(vol))
        seen.add(rel)
        st = p.stat()
        if now - st.st_mtime < c["settle_seconds"]:
            waiting += 1                       # まだコピー中かもしれない
            continue
        ent = cache.get(rel)
        if ent and ent["size"] == st.st_size and ent["mtime"] == int(st.st_mtime):
            bid = ent["bid"]
        else:
            bid = file_sha(p)[:12]
            cache[rel] = {"size": st.st_size, "mtime": int(st.st_mtime), "bid": bid}
            hashed += 1
            if hashed % 25 == 0:
                log(f"  照合中 {k}/{len(files)}")
                if kpath:
                    save_json(kpath, cache)      # 途中で止めても照合済みの分は次回に持ち越す
        ent = cache[rel]
        if "title" not in ent:                 # 一覧に出す書名（1回だけ調べて覚えておく）
            ent.update(book_info(p))
        skip_pdf = (c["prefer_epub"] and p.suffix.lower() == ".pdf"
                    and (p.parent / "metadata.opf").exists() and any(p.parent.glob("*.epub")))
        if not skip_pdf:
            inv.append({"bid": bid, "title": ent["title"], "authors": ent.get("authors", []),
                        "type": p.suffix.lower().lstrip("."), "path": rel, "size": st.st_size,
                        "added": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d")})
        if bid in catalog and not force:
            if catalog[bid].get("src_path") != str(p):   # 移動・改名されただけ → 場所だけ更新
                catalog[bid]["src_path"] = str(p)
                moved = True
            continue
        if skip_pdf:
            continue                           # 同じ本のEPUBがあるのでPDFは省く
        targets.append((p, rel, bid))
    for rel in set(cache) - seen:              # NASから消えたファイルはキャッシュからも外す
        cache.pop(rel)
    return files, targets, waiting, moved, inv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--auto", action="store_true", help="定期実行用。新規がなければ静かに終わる")
    ap.add_argument("--push-only", action="store_true", help="NASは見ずに、変換済みの分をGitHubへ送るだけ")
    ap.add_argument("--limit", type=int, default=0, help="今回変換する冊数の上限（1日の上限より少ない数だけ有効）")
    ap.add_argument("--no-limit", action="store_true", help="1日の上限を無視して全部変換する")
    ap.add_argument("--file", help="この1ファイルだけ処理する（フルパス、または calibre/books からの相対パス）")
    a = ap.parse_args()
    log = (lambda *x: None) if a.auto else print
    check_tools(("git", "age") if a.push_only else ("git", "age", "tesseract"))

    c = load_conf()
    plain_root = Path(c["plain_dir"]); plain_root.mkdir(parents=True, exist_ok=True)

    # 二重起動防止（前回の処理が長引いている間は何もしない）
    lock = open(plain_root / ".lock", "a+")          # "w" で開くと、先に動いている処理の記録が消える
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.seek(0)
        held = lock.read().strip()                 # 先に動いている処理の「PID 開始時刻（UNIX秒）」
        try:
            pid, since = held.split()[:2]
            age_h = (time.time() - float(since)) / 3600
            who = f"PID {pid}（{datetime.fromtimestamp(float(since)):%m/%d %H:%M} に開始、{age_h:.1f} 時間前）"
        except ValueError:
            pid, age_h, who = None, 0, "別の epub2gh.py"
        msg = f"{who} が実行中なので、今回は何もせずに終わります"
        if age_h >= 3:
            msg += (f"\n  3 時間以上前から動いているので、止まっている可能性があります（NAS の応答待ちなど）。\n"
                    f"  ps -p {pid} -o pid,stat,lstart,command で確かめ、止まっていれば kill -9 {pid}"
                    "（消えなければ Mac を再起動）")
        print(msg)
        if a.auto:                                  # 自動実行では log() が黙るので、必ずエラーログに残す
            print(f"[{datetime.now():%Y-%m-%d %H:%M}] {msg}", file=sys.stderr, flush=True)
            if age_h >= 3:
                notify("夜間処理が止まったままです。ログを見てください")
        return
    lock.seek(0); lock.truncate(); lock.write(f"{os.getpid()} {time.time():.0f}\n"); lock.flush()

    if a.push_only:
        repo = Path(c["repo_dir"])
        catalog = load_json(plain_root / "catalog.json", {})
        n = backfill_bundles(catalog, c)
        if n:
            print(f"GitHub版ビューア用データを追加: {n} 冊")
        git_push(repo, 0)
        return

    one = Path(a.file).expanduser() if a.file else None
    inv_changed = False
    vol = None if (one and one.exists()) else ensure_mount(c, quiet=a.auto)
    if one and not one.exists() and vol:        # 相対パス指定 → NAS上で探す
        cand = [vol / sub / a.file for sub in c["src_subdirs"]] + [vol / c["images_dir"] / a.file, vol / a.file]
        one = next((x for x in cand if x.exists()), None)
        if not one:
            sys.exit(f"ファイルが見つかりません: {a.file}")
    if not vol and not one:
        if a.auto:
            return                              # NASが見えないとき（外出中・NAS停止）は次回に回す
        sys.exit(f"マウント失敗: smb://{c['nas_host']}/{c['nas_share']}")
    if vol:
        check_nas_access(vol, c, a.auto)

    repo = Path(c["repo_dir"])
    # ビューアで変えた「変換待ち」を受け取るため、先に GitHub の最新を取り込む
    pr = run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo, check=False)
    pulled = pr.returncode == 0
    if not pulled:
        # cron から動かすと、GitHub のパスワードをキーチェーンから取り出せずに失敗することがある
        print(f"[{datetime.now():%Y-%m-%d %H:%M}] GitHub から最新を取り込めませんでした"
              f"（書庫で変えた「変換待ち」が届いていない可能性があります）:\n  {(pr.stderr or pr.stdout).strip()[:400]}",
              file=sys.stderr, flush=True)
    settings = load_settings(c)
    lim = settings.get("daily_limit")
    if isinstance(lim, int) and not isinstance(lim, bool) and 0 <= lim <= 500:
        c["daily_limit"] = lim                   # 書庫で変えた上限を config.json より優先する
        log(f"1日の上限: {lim or 'なし'}{' 冊' if lim else ''}（書庫の設定）")
    received = []
    if vol and not one:
        # iPhone の登録画面から届いたものを NAS の _images に受け取る（inbox/ は git rm して最後に push）
        try:
            received = inbox.receive(repo, c["age_identity"], vol / c["images_dir"], a.dry_run, log)
        except Exception as e:
            print(f"iPhone からの受け取りに失敗しました: {e}", file=sys.stderr)
    cpath = plain_root / "catalog.json"        # タイトルとパスの一覧
    catalog = load_json(cpath, {})
    kpath = plain_root / "scan_cache.json"     # パス→(サイズ, 更新日時, bid)。毎回の全ハッシュ計算を省く
    cache = load_json(kpath, {})

    if one:
        vol = vol or find_mount(c)
        if not is_image_book(one, c, vol) and one.suffix.lower() not in EXTS:
            sys.exit(f"EPUB、PDF、または画像・PDF のフォルダか zip を指定してください: {one}")
        try:
            rel = str(one.relative_to(vol)) if vol else one.name
        except ValueError:
            rel = one.name                       # NAS外（Macの中など）のファイル
        bid = image_bid(rel) if is_image_book(one, c, vol) else file_sha(one)[:12]
        moved = False
        if is_image_book(one, c, vol):
            targets = [(one, rel, bid)]          # 画像の本は増えた分だけ処理するので毎回対象にする
        elif bid in catalog and not a.force:
            print(f"変換済みです: {catalog[bid]['title']}（作り直すときは --force を付けてください）")
            targets = []
        else:
            targets = [(one, rel, bid)]
    else:
        files, targets, waiting, moved, inv = scan(vol, c, catalog, cache, a.force, log, kpath)
        save_json(kpath, cache)
        itargets, iinv, iwait = scan_images(vol, c, catalog, a.force, log,
                                            fresh={inbox.safe_dir(t) for t, _ in received})
        inv += iinv
        log(f"対象ファイル: {len(files)} 件 / 未変換: {len(targets)} 件" + (f" / コピー待ち: {waiting} 件" if waiting else ""))
        if iinv:
            log(f"画像の本: {len(iinv)} 冊 / 新規・追加あり: {len(itargets)} 冊" + (f" / 送信待ち: {iwait} 冊" if iwait else ""))
        queue = load_queue(c) if c["convert_mode"] == "queue" else []
        dups = mark_dups(inv, catalog, queue, set(settings.get("not_dup") or []))
        if dups:
            log(f"重複している本: {len(dups)} 冊（変換しません）")
        if not a.dry_run and save_inventory(inv, c, plain_root):
            inv_changed = True
            log("ビューア用の本の一覧を更新しました")
        skipped = [t for t in targets if t[2] in dups]
        targets = [t for t in targets if t[2] not in dups]
        if c["convert_mode"] == "queue" and not a.force:
            order = {b: i for i, b in enumerate(queue)}
            if not c["images_auto"]:
                targets += itargets; itargets = []
            unconv = {t[2] for t in targets} | dups
            targets = sorted((t for t in targets if t[2] in order), key=lambda t: order[t[2]])
            log(f"変換待ち: {len(targets)} 件")
            qdup = [b for b in queue if b in dups]
            if qdup:
                msg = f"変換待ちのうち {len(qdup)} 冊は重複している本なので、とばしました（書庫で「重複」と表示されます）"
                log(msg)
                if a.auto:
                    print(f"[{datetime.now():%Y-%m-%d %H:%M}] {msg}", file=sys.stderr, flush=True)
            if queue and not targets:
                # 変換待ちがあるのに 1 冊も対象にならなかった理由を、自動実行でも必ず残す
                done = sum(1 for b in queue if b in catalog)
                lost = len(queue) - done - sum(1 for b in queue if b in unconv)
                why = [f"変換待ち {len(queue)} 冊のうち、NAS 上の未変換の本の中に見つかったのは 0 冊でした"]
                if done:
                    why.append(f"{done} 冊はすでに変換済みです（書庫の変換待ちから外れていません）")
                if lost:
                    why.append(f"{lost} 冊は NAS 上に見つかりません（移動・削除・まだ照合していない可能性）")
                if not pulled:
                    why.append("GitHub から最新を取り込めていないので、変換待ちの一覧が古い可能性があります")
                print(f"[{datetime.now():%Y-%m-%d %H:%M}] " + "\n  ".join(why), file=sys.stderr, flush=True)
        # 画像の本（iPhone や NAS に置いたもの）は先に処理する。追加分は前回の続きだけなので軽い
        targets = itargets + targets

    # 1日の上限（手動・自動の合計で数える。--file での1冊指定は対象外）
    dpath = plain_root / "daily.json"
    today = datetime.now().strftime("%Y-%m-%d")
    daily = load_json(dpath, {})
    used = daily.get("count", 0) if daily.get("date") == today else 0
    cap = None
    if not one and not a.no_limit and c["daily_limit"]:
        cap = max(0, c["daily_limit"] - used)
    if a.limit:
        cap = a.limit if cap is None else min(cap, a.limit)
    if cap is not None and len(targets) > cap:
        if cap == 0:
            msg = f"今日はもう {used} 冊変換したので、残り {len(targets)} 冊は明日以降に回します"
            log(msg)
            if a.auto:
                print(f"[{datetime.now():%Y-%m-%d %H:%M}] {msg}", file=sys.stderr, flush=True)
        else:
            log(f"今回は {cap} 冊だけ変換します（残り {len(targets) - cap} 冊は明日以降）")
        targets = targets[:cap]
    if a.dry_run:
        for _, rel, _ in targets:
            print(f"▶ {rel}")
        return
    filled = backfill_bundles(catalog, c)
    if filled:
        log(f"GitHub版ビューア用データを追加: {filled} 冊")
    if not targets and not moved and not filled and not inv_changed and not received:
        if a.no_push or not needs_push(repo):
            return
        log("前回送っていない変更を GitHub へ送ります")

    if a.auto:
        print(f"[{datetime.now():%Y-%m-%d %H:%M}] 変換 {len(targets)} 件"
              + (f" / iPhone から {len(received)} 件受け取り" if received else ""))

    done, titles = 0, []
    for i, (p, rel, bid) in enumerate(targets, 1):
        print(f"▶ [{i}/{len(targets)}] {rel}", flush=True)
        try:
            imgs, sig = {}, None
            had_imgs = (Path(c["repo_dir"]) / "books" / bid / "images.json.age").exists()
            if is_image_book(p, c, vol):
                sig = image_sig(p)[0]                    # 処理の前に記録（処理中に届いた分は次回に回す）
                title, ch, imgs = convert_images(p, bid, c, a.force, print)
                authors, kind = [], "image"
            else:
                meta = calibre_meta(p)
                title, ch = convert_epub(p, c, imgs) if p.suffix.lower() == ".epub" else convert_pdf(p, c, imgs)
                title = meta.get("title") or title          # Calibreの書名を優先（PDFのタイトルは当てにならない）
                authors = meta.get("authors", [])
                kind = p.suffix.lower().lstrip(".")
            if not ch:
                print("  本文が取れませんでした（DRM付きの可能性）"); continue
            plain_dir, entries = write_book(bid, title, rel, ch, c, kind, authors)
            if imgs or kind == "epub" or had_imgs:
                try:                                     # 図がなくなった本も古い一覧を残さないよう書き直す
                    n_img, _ = write_images(bid, ch, imgs, c)
                    if n_img:
                        print(f"  挿絵・図 {n_img} 点")
                except Exception as e:
                    print(f"  挿絵・図は付けられませんでした: {e}", file=sys.stderr)
            catalog[bid] = {
                "title": title,
                "authors": authors,
                "type": kind,
                "src_path": str(p),                      # NAS上の元ファイル
                "plain_dir": str(plain_dir),             # 平文Markdownのフォルダ
                "bundle": str(plain_dir / "bundle.json"),  # 要約ビューア用データ
                "repo_dir": f"books/{bid}",              # GitHub上の暗号化フォルダ
                "converted": datetime.now().isoformat(timespec="seconds"),
                "chapters": entries,                     # 章ごとのタイトルとパス
            }
            if kind == "image":
                catalog[bid]["img_sig"] = sig            # 次回、中身が増えていたら追加分を処理する
            save_catalog(cpath, catalog, c)              # 1冊ごとに保存
            done += 1
            if not one:
                used += 1
                save_json(dpath, {"date": today, "count": used})
            titles.append(title)
            print(f"  ✓ {title}（{len(ch)}章）")
        except Exception as e:
            print(f"  ✗ 失敗: {e}", file=sys.stderr)

    if moved and not done:
        save_catalog(cpath, catalog, c)                  # 移動の反映だけ
    if not a.no_push:
        try:
            git_push(repo, done)
        except subprocess.CalledProcessError as e:
            print(f"push失敗: {e.stderr}", file=sys.stderr)
            if a.auto:
                notify("GitHubへのpushに失敗しました。ログを確認してください")
    if not done:
        return
    print(f"要約ビューア用ファイル: {plain_root / '_upload'}")
    if a.auto:
        notify(f"{done}冊を追加: {'、'.join(titles[:3])}{' ほか' if done > 3 else ''}")
    elif c["viewer_url"]:
        subprocess.run([OPEN, c["viewer_url"]])


if __name__ == "__main__":
    main()
