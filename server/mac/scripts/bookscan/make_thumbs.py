#!/usr/bin/env python3
"""
書庫の「サムネイル」表示用に、NAS の本の表紙から小さな画像を作り、暗号化して GitHub に置く。

  ~/epub2gh/.venv/bin/python make_thumbs.py              … まだ無い本を最大400冊ぶん作る
  ~/epub2gh/.venv/bin/python make_thumbs.py --limit 2000 … 一度にたくさん作る
  ~/epub2gh/.venv/bin/python make_thumbs.py --dry-run    … 作らずに件数だけ表示
  --minutes 0 で時間の上限なし（既定は120分で打ち切り、残りは次の回）

途中経過を20冊ごとに表示し、200冊ごとに GitHub へ送る（途中で止めても作った分は残る）。
1冊ごとの処理には時間の上限があり、固まった本は飛ばして先へ進む。

表紙は、Calibre の本のフォルダにある cover.jpg → EPUB の中の表紙 → PDF の1ページ目の順に探す。
画像は thumbs/<本のID>.jpg.age として本のリポジトリに置く（中身は age で暗号化）。
nightly_status.py から毎晩呼ばれる。
"""
import json, os, re, signal, subprocess, sys, tempfile, time, zipfile
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath

CONFIG = Path("~/.config/epub2gh/config.json").expanduser()
SKIP_FILE = Path("~/.cache/epub2gh/thumb_skip.json").expanduser()   # 表紙が取れなかった本（30日は試さない）
SIZE = 360            # 長い辺のピクセル数
QUALITY = 70


def run(cmd, timeout=None, **kw):
    """外部コマンドを実行。timeout 秒を過ぎたら打ち切って失敗扱いにする"""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "時間切れ")


# epub2gh.py と同じ設定を使う（設定ファイルが無ければ epub2gh.py の既定値）
DEFAULTS = {
    "nas_share": "data",
    "src_subdirs": ["calibre/books"],
    "repo_dir": "~/epub2gh/repo",
    "plain_dir": "~/epub2gh/plain",
    "age_recipients": "~/.config/epub2gh/recipients.txt",
    "age_identity": "~/.config/epub2gh/key.txt",
    "daily_limit": 20,
}


def load_config():
    c = dict(DEFAULTS)
    try:                                    # epub2gh.py の既定値に合わせる
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import epub2gh
        c.update(getattr(epub2gh, "DEFAULT_CONF", {}) or {})
    except Exception:
        pass
    if CONFIG.exists():
        try:
            c.update(json.loads(CONFIG.read_text(encoding="utf-8")))
        except Exception as e:
            sys.exit(f"設定ファイルを読めません: {CONFIG}（{e}）")
    for k in ("repo_dir", "plain_dir", "age_recipients", "age_identity"):
        if c.get(k):
            c[k] = str(Path(c[k]).expanduser())
    if not Path(c["repo_dir"]).is_dir():
        sys.exit(f"本のリポジトリが見つかりません: {c['repo_dir']}")
    if not Path(c["age_identity"]).is_file():
        sys.exit(f"age の鍵が見つかりません: {c['age_identity']}")
    return c


def recipient_args(c):
    """暗号化の宛先（epub2gh.py と同じ recipients.txt。無ければ鍵から公開鍵を取り出す）"""
    rp = Path(c.get("age_recipients") or "")
    if rp.is_file():
        return ["-R", str(rp)]
    r = subprocess.run(["age-keygen", "-y", c["age_identity"]], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError("age の公開鍵を取り出せませんでした: " + r.stderr.strip())
    return ["-r", r.stdout.strip()]


def decrypt_json(c, path):
    r = run(["age", "-d", "-i", c["age_identity"], str(path)])
    if r.returncode:
        raise RuntimeError(f"{path.name} を復号できませんでした: {r.stderr.strip()}")
    return json.loads(r.stdout)


def nas_roots(c):
    """NAS のマウント先（/Volumes/data や /Volumes/data-1）と、その下の本の置き場所"""
    share = c.get("nas_share", "data")
    subs = c.get("src_subdirs") or ["calibre/books"]
    roots = []
    for v in sorted(Path("/Volumes").glob(share + "*")):
        if v.is_dir():
            roots += [v / s for s in subs] + [v]
    return roots


def find_book(rel, roots):
    for base in roots:
        p = base / rel
        if p.is_file():
            return p
    return None


def epub_cover(p, tmp):
    """EPUB の中から表紙画像を取り出す"""
    try:
        with zipfile.ZipFile(p) as z:
            names = z.namelist()
            opf = None
            if "META-INF/container.xml" in names:
                m = re.search(r'full-path="([^"]+)"', z.read("META-INF/container.xml").decode("utf-8", "ignore"))
                opf = m.group(1) if m else None
            href = None
            if opf and opf in names:
                x = z.read(opf).decode("utf-8", "ignore")
                items = {m.group(0): m for m in re.finditer(r"<item\b[^>]*>", x)}
                def attr(tag, name):
                    m = re.search(rf'\b{name}="([^"]*)"', tag)
                    return m.group(1) if m else None
                for tag in items:                       # EPUB3: properties="cover-image"
                    if "cover-image" in (attr(tag, "properties") or ""):
                        href = attr(tag, "href"); break
                if not href:                            # EPUB2: <meta name="cover" content="ID">
                    m = re.search(r'<meta\b[^>]*name="cover"[^>]*content="([^"]+)"', x) or \
                        re.search(r'<meta\b[^>]*content="([^"]+)"[^>]*name="cover"', x)
                    if m:
                        for tag in items:
                            if attr(tag, "id") == m.group(1):
                                href = attr(tag, "href"); break
                if href:
                    href = str(PurePosixPath(opf).parent / href) if "/" in opf else href
            if not href or href not in names:           # 最後の手段：名前に cover を含む画像
                imgs = [n for n in names if re.search(r"cover.*\.(jpe?g|png)$", n, re.I)]
                href = imgs[0] if imgs else None
            if not href:
                return None
            out = tmp / ("epubcover" + Path(href).suffix.lower())
            out.write_bytes(z.read(href))
            return out
    except Exception:
        return None


PDF_RENDER = r"""
import sys, fitz
d = fitz.open(sys.argv[1])
pg = d[0]
z = 720 / max(pg.rect.width, pg.rect.height)
pg.get_pixmap(matrix=fitz.Matrix(z, z), alpha=False).save(sys.argv[2])
"""


def pdf_cover(p, tmp):
    """PDF の1ページ目を画像にする（PyMuPDF → 無理ならクイックルック）。固まっても60秒で打ち切る"""
    out = tmp / "pdfcover.png"
    r = run([sys.executable, "-c", PDF_RENDER, str(p), str(out)], timeout=60)
    if r.returncode == 0 and out.exists():
        return out
    r = run(["qlmanage", "-t", "-s", "720", "-o", str(tmp), str(p)], timeout=60)
    out = tmp / (p.name + ".png")
    return out if r.returncode == 0 and out.exists() else None


def cover_of(p, tmp):
    for name in ("cover.jpg", "cover.jpeg", "cover.png"):
        q = p.parent / name
        if q.is_file():
            return q
    if p.suffix.lower() == ".epub":
        return epub_cover(p, tmp)
    if p.suffix.lower() == ".pdf":
        return pdf_cover(p, tmp)
    return None


WORKERS = 4           # 並行して作る冊数
BOOK_TIMEOUT = 120    # 1冊にかける時間の上限（秒）


def worker_roots():
    """NAS の置き場所を調べて JSON で出す（親のプロセスが時間の上限つきで呼ぶ）"""
    c = load_config()
    print(json.dumps([str(r) for r in nas_roots(c)], ensure_ascii=False))
    return 0


META_CACHE = Path("~/.cache/epub2gh/meta.json").expanduser()


def worker_meta(job):
    """1冊ぶんの Calibre の情報（シリーズ・タグ）を metadata.opf から読んで JSON で出す"""
    j = json.loads(job)
    p = find_book(j["path"], [Path(r) for r in j["roots"]])
    out = {}
    opf = p.parent / "metadata.opf" if p else None
    if opf and opf.is_file():
        x = opf.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'<meta\b[^>]*name="calibre:series"[^>]*content="([^"]+)"', x) or re.search(r'<meta\b[^>]*content="([^"]+)"[^>]*name="calibre:series"', x)
        if m:
            out["series"] = html_unescape(m.group(1))
            mi = re.search(r'<meta\b[^>]*name="calibre:series_index"[^>]*content="([^"]+)"', x) or re.search(r'<meta\b[^>]*content="([^"]+)"[^>]*name="calibre:series_index"', x)
            if mi:
                try: out["series_index"] = float(mi.group(1))
                except ValueError: pass
        tags = [html_unescape(t.strip()) for t in re.findall(r"<dc:subject[^>]*>([^<]+)</dc:subject>", x)]
        if tags:
            out["tags"] = tags[:20]
    print(json.dumps(out, ensure_ascii=False))
    return 0


def html_unescape(t):
    import html
    return html.unescape(t)


def meta_phase(c, books, roots, rec, repo, minutes=30):
    """シリーズ・タグの一覧（meta.json.age）を作る。まだ調べていない本だけ NAS を見に行く"""
    try:
        cache = json.loads(META_CACHE.read_text(encoding="utf-8"))
    except Exception:
        cache = {}
    todo = [b for b in books if b.get("bid") and b["bid"] not in cache]
    if todo:
        print(f"シリーズ・タグ: {len(todo)} 冊を調べます", flush=True)
    from concurrent.futures import ThreadPoolExecutor
    t0 = time.time()

    def one(b):
        if minutes and time.time() - t0 > minutes * 60:
            return b, None
        job = json.dumps({"path": b.get("path", ""), "roots": roots}, ensure_ascii=False)
        r = run([sys.executable, str(Path(__file__).resolve()), "--meta", job], timeout=30)
        try:
            return b, json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {}
        except Exception:
            return b, {}

    done = 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for b, m in ex.map(one, todo):
            if m is None:
                continue
            cache[b["bid"]] = m
            done += 1
            if done % 200 == 0:
                print(f"シリーズ・タグ: {done}/{len(todo)} 冊", flush=True)
    META_CACHE.parent.mkdir(parents=True, exist_ok=True)
    META_CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    data = {"books": {k: v for k, v in cache.items() if v}, "updated": datetime.now().isoformat(timespec="seconds")}
    dst = repo / "meta.json.age"
    plain = json.dumps(data["books"], ensure_ascii=False, sort_keys=True)
    stamp = META_CACHE.with_suffix(".sent")
    if dst.exists() and stamp.exists() and stamp.read_text(encoding="utf-8") == plain:
        return False
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        tmp = f.name
    try:
        if run(["age", *rec, "-o", str(dst), tmp], timeout=60).returncode:
            print("シリーズ・タグ: 暗号化できませんでした", file=sys.stderr, flush=True)
            return False
    finally:
        os.unlink(tmp)
    stamp.write_text(plain, encoding="utf-8")
    print(f"シリーズ・タグ: {len(data['books'])} 冊ぶんを更新しました", flush=True)
    return True


def worker_one(job):
    """1冊ぶん：本を探す → 表紙を取り出す → 縮小 → 暗号化。終了コード 0=作成 2=表紙なし 3=本が無い 4/5=変換失敗"""
    j = json.loads(job)
    p = find_book(j["path"], [Path(r) for r in j["roots"]])
    if not p:
        return 3
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        src = cover_of(p, tmp)
        if not src:
            return 2
        jpg = tmp / "thumb.jpg"
        if run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(QUALITY),
                "-Z", str(SIZE), str(src), "--out", str(jpg)], timeout=60).returncode or not jpg.exists():
            return 4
        out = Path(j["out"]); part = out.with_name(out.name + ".part")
        if run(["age", *j["rec"], "-o", str(part), str(jpg)], timeout=60).returncode:
            part.unlink(missing_ok=True)
            return 5
        part.replace(out)
    return 0


def main():
    a = sys.argv[1:]
    if a[:1] == ["--roots"]:
        return worker_roots()
    if a[:1] == ["--one"]:
        return worker_one(a[1])
    if a[:1] == ["--meta"]:
        return worker_meta(a[1])
    dry = "--dry-run" in a
    limit = int(a[a.index("--limit") + 1]) if "--limit" in a else 400
    minutes = int(a[a.index("--minutes") + 1]) if "--minutes" in a else 120
    c = load_config()
    repo = Path(c["repo_dir"])
    inv_path = repo / "inventory.json.age"
    if not inv_path.exists():
        print("サムネイル: 本の一覧がまだないので作りません")
        return 0
    books = decrypt_json(c, inv_path).get("books", [])
    tdir = repo / "thumbs"
    have = {x.name[:-len(".jpg.age")] for x in tdir.glob("*.jpg.age")} if tdir.exists() else set()
    try:
        skip = json.loads(SKIP_FILE.read_text(encoding="utf-8"))
    except Exception:
        skip = {}
    now = datetime.now()
    skip = {k: v for k, v in skip.items() if datetime.fromisoformat(v) > now - timedelta(days=30)}
    todo = [b for b in books if b.get("bid") and b["bid"] not in have and b["bid"] not in skip]
    print(f"サムネイル: 未作成 {len(todo)} 冊（今回は最大 {limit} 冊）", flush=True)
    if dry:
        return 0
    # NAS が応答するか、別のプロセスで確かめる（つながりが切れたまま固まっていても待ち続けない）
    r = run([sys.executable, str(Path(__file__).resolve()), "--roots"], timeout=30)
    if r.returncode == 124:
        print("サムネイル: NAS が応答しません。Finder で NAS（smb://nas220/data）をいったん取り出して、接続し直してください", flush=True)
        return 1
    try:
        roots = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        roots = []
    if not roots:
        print("サムネイル: NAS がマウントされていないので、次の回に作ります", flush=True)
        return 0
    try:
        rec = recipient_args(c)
    except Exception as e:
        print(f"サムネイル: {e}", file=sys.stderr)
        return 1
    tdir.mkdir(exist_ok=True)
    for x in tdir.glob("*.part"):           # 途中で止めたときの書きかけ
        x.unlink(missing_ok=True)
    batch = todo[:limit]
    kinds = {}
    for b in batch:
        k = Path(b.get("path", "")).suffix.lower().lstrip(".") or "?"
        kinds[k] = kinds.get(k, 0) + 1
    if batch: print("サムネイル: 内訳 " + "・".join(f"{k.upper()} {v}冊" for k, v in sorted(kinds.items())) + f"（{WORKERS}冊ずつ並行して作ります）", flush=True)

    made = nocover = pushed = done = 0
    t0 = time.time()

    def save_skip():
        SKIP_FILE.parent.mkdir(parents=True, exist_ok=True)
        SKIP_FILE.write_text(json.dumps(skip, ensure_ascii=False), encoding="utf-8")

    def send(n):
        run(["git", "add", "thumbs"], cwd=repo)
        if run(["git", "diff", "--cached", "--quiet"], cwd=repo).returncode == 0:
            return True
        run(["git", "commit", "-q", "-m", f"表紙のサムネイルを追加（{n}冊）" if n else "シリーズ・タグを更新"], cwd=repo)
        for _ in range(3):
            run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo, timeout=300)
            if run(["git", "push", "-q"], cwd=repo, timeout=600).returncode == 0:
                return True
            time.sleep(5)
        print("サムネイル: push できませんでした（次の回にまとめて送ります）", file=sys.stderr, flush=True)
        return False

    def one(b):
        """1冊を別のプロセスで作る。BOOK_TIMEOUT 秒で打ち切る"""
        job = json.dumps({"path": b.get("path", ""), "roots": roots, "rec": rec,
                          "out": str(tdir / f"{b['bid']}.jpg.age")}, ensure_ascii=False)
        t1 = time.time()
        pr = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--one", job],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            code = pr.wait(timeout=BOOK_TIMEOUT)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(pr.pid, signal.SIGKILL)   # 中で固まった sips や qlmanage もまとめて止める
            except Exception:
                pr.kill()
            try:
                pr.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            code = 124
        return b, code, time.time() - t1

    stop = False
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
    with ThreadPoolExecutor(WORKERS) as ex:
        it = iter(batch)
        running = set()
        last_note = time.time()
        while True:
            while not stop and len(running) < WORKERS:
                if minutes and time.time() - t0 > minutes * 60:
                    print(f"サムネイル: {minutes}分たったので、残りは次の回に作ります", flush=True)
                    stop = True
                    break
                b = next(it, None)
                if b is None:
                    stop = True
                    break
                running.add(ex.submit(one, b))
            if not running:
                break
            fin, running = wait(running, timeout=60, return_when=FIRST_COMPLETED)
            if not fin and time.time() - last_note >= 60:
                print(f"サムネイル: 処理中…（{done}/{len(batch)} 冊目、経過 {int(time.time() - t0) // 60}分）", flush=True)
                last_note = time.time()
            for f in fin:
                b, code, took = f.result()
                done += 1
                if code == 0:
                    made += 1
                else:
                    nocover += 1
                    skip[b["bid"]] = now.isoformat(timespec="seconds")
                if code == 124:
                    print(f"サムネイル: 時間切れで飛ばした本: {b.get('title', '')[:40]}", flush=True)
                elif took > 30:
                    print(f"サムネイル: 時間がかかった本（{int(took)}秒）: {b.get('title', '')[:40]}", flush=True)
                if done % 20 == 0 or done == len(batch):
                    el = int(time.time() - t0)
                    rest = int(el / done * (len(batch) - done))
                    print(f"サムネイル: {done}/{len(batch)} 冊目（作成 {made}・表紙なし {nocover}）経過 {el // 60}分 残り約 {rest // 60}分", flush=True)
                    last_note = time.time()
            if made - pushed >= 200:          # 200冊ごとに送って、途中で止めても残るようにする
                save_skip()
                if send(made - pushed):
                    print(f"サムネイル: ここまでの {made} 冊を GitHub に送りました", flush=True)
                    pushed = made
    save_skip()
    print(f"サムネイル: {made} 冊作成、表紙なし {nocover} 冊（{int(time.time() - t0) // 60}分）", flush=True)
    meta_phase(c, books, roots, rec, repo)
    run(["git", "add", "meta.json.age"], cwd=repo)
    if send(made - pushed):
        print("サムネイル: GitHub に送りました", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
