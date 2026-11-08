#!/usr/bin/env python3
"""
img2book — 画像・PDF（フォルダ / zip / PDF 単体）から本を作る部品。epub2gh.py から呼び出す。

  ・フォルダ、zip、フォルダの中の zip、PDF をまとめて 1 冊として扱う
  ・ページ順はファイル名の番号順（1, 2, 10 の順）。PDF はその位置にページ順で入る
  ・ページごとにハッシュを記録し、2 回目以降は増えたページだけを処理（追加登録）
  ・画像とスキャン PDF は tesseract（jpn + jpn_vert + eng）で文字起こし
  ・文字の層がある PDF は、埋め込まれた文字と画像・図の位置をそのまま使う
  ・図・写真の部分だけを切り出して WebP で保存し、本文の該当位置に参照を入れる

出力（book_dir の下）
  pages/0001.md        … ページごとの本文（図の参照つき）。章はここから組み立てる
  fig/p0001-1.jpg      … 切り出した図
  state.json           … 処理済み画像のハッシュとページ番号

単体で試す:
  python img2book.py <フォルダ / zip / PDF> --out ./test_book
"""
import argparse, hashlib, io, json, os, re, shutil, sys, tempfile, unicodedata, zipfile
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from PIL import Image, ImageDraw, ImageOps

try:
    import pymupdf as fitz
except ImportError:
    import fitz  # 古い PyMuPDF

# 自動実行（launchd）など PATH が狭いときも tesseract・age・git が見つかるように、標準の場所を足す
_cur = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]
for _d in [os.path.dirname(sys.executable), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
           "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]:
    if _d not in _cur and os.path.isdir(_d):
        _cur.append(_d)
os.environ["PATH"] = os.pathsep.join(_cur)

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".heic"}
DOC_EXT = IMG_EXT | {".pdf"}
SKIP_DIRS = {"@eaDir", "#recycle", "__MACOSX", ".DS_Store"}
CJK = r"\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef"

DEFAULTS = {
    "ocr_langs": "jpn+jpn_vert+eng",
    "pages_per_chapter": 20,     # 画像の本は 20 ページごとに章に分ける
    "fig_min_area": 0.03,        # ページ面積の 3% 未満の塊は図とみなさない
    "fig_max_edge": 1400,        # 切り出した図の長辺（px）。epub2gh の挿絵と同じ
    "fig_quality": 85,           # JPEG の画質
    "scan_dpi": 200,             # スキャン PDF を画像にするときの解像度
    "pdf_text_min": 30,          # 1 ページの文字数がこれ未満ならスキャンとみなす
}


# ---------- 画像を集める ----------
def natural_key(s):
    s = unicodedata.normalize("NFKC", s)
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _zip_name(info):
    """Windows で作った zip の日本語名（cp932）を直す"""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        raw = info.filename.encode("cp437")
    except UnicodeEncodeError:
        return info.filename
    for enc in ("utf-8", "cp932"):          # Mac/Linux は UTF-8、Windows は cp932
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return info.filename


def collect_images(src):
    """src（フォルダ / zip / PDF）から (表示名, 読み込み関数) をファイル名順で返す"""
    src = Path(src)
    items = []

    def add_zip(zp, prefix):
        with zipfile.ZipFile(zp) as z:
            for info in z.infolist():
                name = _zip_name(info)
                parts = Path(name).parts
                if info.is_dir() or any(p in SKIP_DIRS or p.startswith("._") for p in parts):
                    continue
                if Path(name).suffix.lower() in DOC_EXT:
                    items.append((f"{prefix}{name}",
                                  lambda zp=zp, n=info.filename: zipfile.ZipFile(zp).read(n)))

    if src.is_file() and src.suffix.lower() == ".zip":
        add_zip(src, "")
    elif src.is_file() and src.suffix.lower() in DOC_EXT:
        items.append((src.name, src.read_bytes))
    elif src.is_dir():
        for p in src.rglob("*"):
            rel = p.relative_to(src)
            if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts):
                continue
            if p.is_file() and p.suffix.lower() in DOC_EXT:
                items.append((str(rel), p.read_bytes))
            elif p.is_file() and p.suffix.lower() == ".zip":
                add_zip(p, f"{rel.with_suffix('')}/")
    else:
        raise ValueError(f"フォルダ、zip、画像、PDF のどれかを指定してください: {src}")
    items.sort(key=lambda x: natural_key(x[0]))
    return items


def load_image(data):
    if data[:12].find(b"ftyp") >= 0 and b"hei" in data[:32]:
        try:
            import pillow_heif  # iPhone の HEIC 用（入っていれば使う）
            pillow_heif.register_heif_opener()
        except ImportError:
            raise RuntimeError("HEIC を読むには pillow-heif が必要です（pip install pillow-heif）")
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)          # スマホ写真の向きを直す
    return im.convert("RGB")


# ---------- 文字起こし ----------
def normalize(im):
    """スマホ写真の影・明るさのむら・紙の色をならした白黒の画像（numpy）にする"""
    g = cv2.cvtColor(np.array(im.convert("RGB")), cv2.COLOR_RGB2GRAY)
    k = max(15, min(g.shape) // 30) | 1
    bg = cv2.medianBlur(cv2.dilate(g, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))), k)
    n = cv2.divide(g, bg, scale=255)
    return cv2.normalize(n, None, 0, 255, cv2.NORM_MINMAX)


def ocr_page(im, langs, psm=3):
    """単語の位置つきで OCR し、(ブロックのリスト, 文字の箱, 読み取りの確かさ) を返す。
       確かさ ＝ 確信度 60 以上で読めた日本語の文字数（縦横の読み比べに使う）"""
    src = Image.fromarray(normalize(im))
    d = pytesseract.image_to_data(src, lang=langs, config=f"--psm {psm}",
                                  output_type=pytesseract.Output.DICT)
    blocks, boxes, score = {}, [], 0
    for i, w in enumerate(d["text"]):
        w = (w or "").strip()
        conf = float(d["conf"][i])
        if not w or conf < 30:                # 写真の中の誤認識は文字扱いしない
            continue
        x, y, bw, bh = d["left"][i], d["top"][i], d["width"][i], d["height"][i]
        boxes.append((x, y, bw, bh))
        if conf >= 60:
            score += len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", w))
        key = d["block_num"][i]
        b = blocks.setdefault(key, {"top": y, "left": x, "lines": {}})
        b["top"], b["left"] = min(b["top"], y), min(b["left"], x)
        b["lines"].setdefault((d["par_num"][i], d["line_num"][i]), []).append(w)

    out = []
    for b in blocks.values():
        lines = []
        for words in b["lines"].values():
            s = ""
            for w in words:   # 日本語どうしは詰め、英数字どうしは空白を入れる
                if s and not (re.search(rf"[{CJK}]$", s) or re.match(rf"[{CJK}]", w)):
                    s += " "
                s += w
            lines.append(s)
        text = join_lines(lines)
        if text:
            out.append({"top": b["top"], "left": b["left"], "text": text})
    return out, boxes, score


def split_langs(langs):
    """'jpn+jpn_vert+eng' → 横書き用 'jpn+eng'、縦書き用 'jpn_vert+eng'（縦がなければ None）"""
    parts = langs.split("+")
    base = [l for l in parts if l not in ("jpn", "jpn_vert")]
    h = "+".join(["jpn"] + base) if "jpn" in parts else langs
    v = "+".join(["jpn_vert"] + base) if "jpn_vert" in parts else None
    return h, v


def ocr_best(im, langs, psm_h=3, psm_v=3):
    """横書き・縦書きの両方で読み、よく読めたほうを返す（混ぜて読むと写真では文字化けしやすい）"""
    h, v = split_langs(langs)
    best = ocr_page(im, h, psm_h)
    if v:
        alt = ocr_page(im, v, psm_v)
        if alt[2] > best[2] * 1.2:            # 縦書きがはっきり上回るときだけ縦書きにする
            best = alt
            if psm_v != 5:                    # 縦書きは「縦書きの段落」として読むほうが崩れにくいことがある
                alt5 = ocr_page(im, v, 5)
                if alt5[2] > best[2]:
                    best = alt5
    return best


def join_lines(lines):
    """行末で切れた文をつなぐ（句点などで終わる行は段落の終わり）"""
    out = ""
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        if out and not re.search(r"[。．！？!?」』）)：:]$", out):
            out += "" if re.search(rf"[{CJK}]$", out) else " "
        elif out:
            out += "\n"
        out += ln
    return out


# ---------- 図の切り出し ----------
def find_figures(im, text_boxes, min_area_ratio):
    """文字の箱を消したあとに残る大きな塊を図・写真とみなす"""
    g = normalize(im)                         # 影や紙の色を図と取り違えないように
    h, w = g.shape
    ink = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                cv2.THRESH_BINARY_INV, 51, 15)
    # 写真の面（濃淡のある部分）も拾う
    edges = cv2.Canny(cv2.GaussianBlur(g, (5, 5), 0), 40, 120)
    mask = cv2.bitwise_or(ink, edges)
    for x, y, bw, bh in text_boxes:
        pad = max(2, bh // 4)
        cv2.rectangle(mask, (x - pad, y - pad), (x + bw + pad, y + bh + pad), 0, -1)
    # ページの縁の線・のどの影・罫線のような長い直線を除く（絵とページの縁がつながって 1 つの塊にならないように）
    for kw, kh in ((int(w * 0.4), 1), (1, int(h * 0.4))):
        line = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(1, kw), max(1, kh))))
        mask = cv2.subtract(mask, cv2.dilate(line, np.ones((5, 5), np.uint8)))
    # ページの端（紙の縁や影）を除く
    m = int(min(h, w) * 0.02)
    mask[:m, :], mask[-m:, :], mask[:, :m], mask[:, -m:] = 0, 0, 0, 0

    k = max(15, min(h, w) // 40)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    figs = []
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if bw * bh < min_area_ratio * h * w or bw * bh > 0.95 * h * w:
            continue
        if bw < w * 0.08 or bh < h * 0.05:        # 細い線（罫線・柱）は除く
            continue
        # 中身が薄すぎる塊は除く（膨らませただけのノイズ）
        if cv2.countNonZero(ink[y:y + bh, x:x + bw]) < 0.02 * bw * bh:
            continue
        # 写真の縁にかかる塊のうち、縁に沿った細い帯（ページの縁・影・切れた行）と、
        # 中まで濃い塊（指・机）は図にしない。縁まで届く線画（地平線など）は残す
        edge = x <= m * 2 or y <= m * 2 or x + bw >= w - m * 2 or y + bh >= h - m * 2
        if edge:
            fill = cv2.countNonZero(ink[y:y + bh, x:x + bw]) / max(1, bw * bh)
            if bw < w * 0.12 or bh < h * 0.12 or fill > 0.35:
                continue
        figs.append((x, y, bw, bh))
    figs = merge_boxes(figs, gap=int(min(h, w) * 0.06))   # 近くにある部品（雲・星・人など）は 1 つの図に
    figs.sort(key=lambda b: (b[1], b[0]))
    return figs


def merge_boxes(boxes, gap=0):
    changed = True
    while changed:
        changed, out = False, []
        for b in boxes:
            for i, o in enumerate(out):
                if not (b[0] > o[0] + o[2] + gap or o[0] > b[0] + b[2] + gap or
                        b[1] > o[1] + o[3] + gap or o[1] > b[1] + b[3] + gap):
                    x0, y0 = min(b[0], o[0]), min(b[1], o[1])
                    x1 = max(b[0] + b[2], o[0] + o[2]); y1 = max(b[1] + b[3], o[1] + o[3])
                    out[i] = (x0, y0, x1 - x0, y1 - y0); changed = True
                    break
            else:
                out.append(b)
        boxes = out
    return boxes


def crop_jpeg(im, box, max_edge, quality, pad=6):
    """図の部分を切り出して JPEG のバイト列にする"""
    x, y, bw, bh = box
    crop = im.crop((max(0, x - pad), max(0, y - pad),
                    min(im.width, x + bw + pad), min(im.height, y + bh + pad)))
    crop.thumbnail((max_edge, max_edge))
    buf = io.BytesIO()
    crop.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def save_fig(im, box, path, max_edge, quality):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(crop_jpeg(im, box, max_edge, quality))


# ---------- 1 ページの処理 ----------
def is_text_region(im, box, langs):
    """図の候補の部分だけを読み直し、読めた文字を消したあとに線や塗りがほとんど残らなければ図ではないとみなす。
       (図ではないか, 読み直した文章) を返す。文章が None のときは、読み直しても文字が少ない切れ端・裏写り
       なので、最初の文字起こしの結果をそのまま使う"""
    x, y, w, h = box
    crop = im.crop((x, y, x + w, y + h))
    blocks, boxes, score = ocr_best(crop, langs, 6, 5)   # 6 = 横書きの段落、5 = 縦書きの段落
    gray = np.array(crop.convert("L"))
    if np.median(gray) < 200:                 # 色の付いた枠に白い文字（見出し・演習問題など）
        inv = ocr_best(ImageOps.invert(crop.convert("RGB")), langs, 6, 5)
        if inv[2] > max(score * 1.3, 8):
            return True, "\n\n".join(b["text"] for b in inv[0])
    text = "\n\n".join(b["text"] for b in blocks)
    n = normalize(crop)
    ink = ((n < 140) * 255).astype(np.uint8)  # 薄い色（裏写り・色の付いた枠・蛍光ペン）は線に数えない
    total = cv2.countNonZero(ink)
    for bx, by, bw, bh in boxes:              # 読めた文字（と下の蛍光ペンの線）を消す
        pad = max(2, bh // 3)
        cv2.rectangle(ink, (bx - pad, by - pad), (bx + bw + pad, by + bh + pad), 0, -1)
    # 残ったもののうち、文字より大きくつながった線や塗り（＝イラスト・図表）だけを数える。
    # 読み落とした字や切れた行の端は、1 文字くらいの小さな粒なので数えない
    ch = float(np.median([min(bw, bh) for _, _, bw, bh in boxes])) if boxes else 20.0
    cnt, _, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(ink, np.ones((3, 3), np.uint8)))
    big = sum(int(st[j, 4]) for j in range(1, cnt)
              if max(st[j, 2], st[j, 3]) > ch * 2.5 and min(st[j, 2], st[j, 3]) > ch * 0.6)  # 細い罫線・縁は除く
    if total and big / total >= 0.25:
        return False, ""                      # 文字より大きな線や塗りがある＝図
    return True, (text if score >= 4 else None)


def detect_figures(im, text_boxes, c):
    """図の候補を見つけ、文章だったものを除く。(図の箱, 読み直した文章) を返す"""
    figs, texts = [], []
    for box in find_figures(im, text_boxes, c["fig_min_area"]):
        is_text, t = is_text_region(im, box, c["ocr_langs"])
        if is_text:
            if t is not None:
                texts.append((box, t))       # 最初の文字起こしで読めなかった文章
        else:
            figs.append(box)
    return figs, texts


def process_page(im, page_no, book_dir, c):
    blocks, boxes, _ = ocr_best(im, c["ocr_langs"])
    figs, texts = detect_figures(im, boxes, c)
    if figs:
        # 図があると文字の向きの判定がずれるので、図を白く消して文字起こしし直す
        clean = im.copy()
        dr = ImageDraw.Draw(clean)
        for x, y, bw, bh in figs:
            dr.rectangle((x, y, x + bw, y + bh), fill="white")
        blocks, _, _ = ocr_best(clean, c["ocr_langs"])
    inside = lambda b, r: r[0] <= b["left"] <= r[0] + r[2] and r[1] <= b["top"] <= r[1] + r[3]
    blocks = [b for b in blocks if not any(inside(b, r) for r, _ in texts)]   # 二重を防ぐ
    items = [(b["top"], "t", b["text"]) for b in blocks]
    items += [(r[1], "t", t) for r, t in texts if t]
    names = []
    for i, box in enumerate(figs, 1):
        name = f"p{page_no:04d}-{i}.jpg"
        save_fig(im, box, Path(book_dir) / "fig" / name, c["fig_max_edge"], c["fig_quality"])
        items.append((box[1], "f", name))
        names.append(name)
    items.sort(key=lambda t: t[0])            # 上から順に本文と図を並べる
    parts = [t[2] if t[1] == "t" else f"![図](fig/{t[2]})" for t in items]
    return "\n\n".join(parts).strip(), names


# ---------- 文字の層がある PDF のページ ----------
def pdf_page_figures(page, min_area_ratio):
    """埋め込み画像と、線や図形で描かれた図の位置を返す"""
    pr = page.rect
    area = pr.width * pr.height
    rects = []
    for info in page.get_image_info():
        rects.append(fitz.Rect(info["bbox"]) & pr)
    if hasattr(page, "cluster_drawings"):           # PyMuPDF 1.24 以降
        try:
            rects += [r & pr for r in page.cluster_drawings()]
        except Exception:
            pass
    rects = [r for r in rects if not r.is_empty and
             min_area_ratio * area <= r.width * r.height <= 0.9 * area   # 背景の全面画像は除く
             and r.width > pr.width * 0.08 and r.height > pr.height * 0.05]
    boxes = merge_boxes([(r.x0, r.y0, r.width, r.height) for r in rects])
    boxes.sort(key=lambda b: (b[1], b[0]))
    return boxes


def pdf_figure_jpeg(page, box, c):
    """文字の層がある PDF のページから、図の部分を画像にして切り出す"""
    x, y, w, h = box
    zoom = c["scan_dpi"] / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, alpha=False,
                          clip=fitz.Rect(x - 3, y - 3, x + w + 3, y + h + 3))
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return crop_jpeg(im, (0, 0, im.width, im.height), c["fig_max_edge"], c["fig_quality"], pad=0)


def process_pdf_text_page(page, page_no, book_dir, c):
    figs = pdf_page_figures(page, c["fig_min_area"])
    items = []
    for x0, y0, x1, y1, text, _, btype in page.get_text("blocks", sort=True):
        if btype != 0:
            continue
        # 図の中の文字（グラフの目盛りなど）は図の一部として扱う
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if any(fx <= cx <= fx + fw and fy <= cy <= fy + fh for fx, fy, fw, fh in figs):
            continue
        t = join_lines(text.splitlines())
        if t:
            items.append((y0, "t", t))
    names = []
    for i, box in enumerate(figs, 1):
        name = f"p{page_no:04d}-{i}.jpg"
        out = Path(book_dir) / "fig" / name
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(pdf_figure_jpeg(page, box, c))
        items.append((box[1], "f", name))
        names.append(name)
    items.sort(key=lambda t: t[0])
    return "\n\n".join(t[2] if t[1] == "t" else f"![図](fig/{t[2]})" for t in items).strip(), names


def scanned_pdf_figures(page, c):
    """文字起こし済み（ocrmypdf 済み）のスキャンのページから図を切り出す。[(上端の位置pt, JPEG)]"""
    zoom = c["scan_dpi"] / 72
    im = render_page(page, c["scan_dpi"])
    words = [(int(x0 * zoom), int(y0 * zoom), int((x1 - x0) * zoom), int((y1 - y0) * zoom))
             for x0, y0, x1, y1, *_ in page.get_text("words")]
    figs, _ = detect_figures(im, words, c)
    return [(y / zoom, crop_jpeg(im, (x, y, w, h), c["fig_max_edge"], c["fig_quality"]))
            for x, y, w, h in figs]


def text_pdf_figures(page, c):
    """文字の層がある PDF のページから図を切り出す。[(上端の位置pt, JPEG)]"""
    return [(box[1], pdf_figure_jpeg(page, box, c)) for box in pdf_page_figures(page, c["fig_min_area"])]


def render_page(page, dpi):
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def iter_pages(name, data, c):
    """1 ファイルを (ページ名, ハッシュ, 処理関数) に分ける。PDF はページごと"""
    fh = hashlib.sha256(data).hexdigest()[:16]
    if not name.lower().endswith(".pdf"):
        yield name, fh, lambda no, d: process_page(load_image(data), no, d, c)
        return
    doc = fitz.open(stream=data, filetype="pdf")
    for i, page in enumerate(doc):
        def run(no, d, page=page):
            if len(page.get_text("text").strip()) >= c["pdf_text_min"]:
                return process_pdf_text_page(page, no, d, c)
            return process_page(render_page(page, c["scan_dpi"]), no, d, c)   # スキャン
        yield f"{name} p.{i + 1}", f"{fh}:{i + 1}", run


# ---------- 本 1 冊（追加登録に対応） ----------
def update_book(src, book_dir, conf=None, limit=None, log=print):
    """新しい画像だけを処理する。戻り値: 追加したページ数"""
    c = {**DEFAULTS, **(conf or {})}
    book_dir = Path(book_dir)
    (book_dir / "pages").mkdir(parents=True, exist_ok=True)
    st_path = book_dir / "state.json"
    st = json.loads(st_path.read_text()) if st_path.exists() else {"images": {}, "pages": 0}

    added = 0
    for fname, read in collect_images(src):
        data = read()
        for name, h, run in iter_pages(fname, data, c):
            if h in st["images"]:
                continue
            if limit is not None and added >= limit:
                log(f"  上限 {limit} ページに達したので、残りは次回に回します")
                return added
            page_no = st["pages"] + 1
            log(f"  p.{page_no}  {name}")
            md, figs = run(page_no, book_dir)
            (book_dir / "pages" / f"{page_no:04d}.md").write_text(md, encoding="utf-8")
            st["images"][h] = {"page": page_no, "name": name, "figs": figs}
            st["pages"] = page_no
            added += 1
            st_path.write_text(json.dumps(st, ensure_ascii=False, indent=1))  # 1 ページごとに保存
    return added


def build_chapters(book_dir, conf=None):
    """pages/ から章を組み立てる。epub2gh の chapters と同じ (章名, 本文) のリスト"""
    c = {**DEFAULTS, **(conf or {})}
    pages = sorted((Path(book_dir) / "pages").glob("*.md"))
    k, chapters = c["pages_per_chapter"], []
    for s in range(0, len(pages), k):
        chunk = pages[s:s + k]
        body = "\n\n".join(f"<!-- p.{int(p.stem)} -->\n{p.read_text(encoding='utf-8')}"
                           for p in chunk)
        if body.strip():
            chapters.append((f"p{s + 1}-{s + len(chunk)}", body))
    return chapters


def book_title(src):
    p = Path(src)
    return unicodedata.normalize("NFC", p.stem if p.suffix.lower() in DOC_EXT | {".zip"} else p.name)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="画像・PDF から本を作る（単体テスト用）")
    ap.add_argument("src", help="画像・PDF のフォルダ、zip、または PDF")
    ap.add_argument("--out", required=True, help="出力先フォルダ")
    ap.add_argument("--limit", type=int, help="今回処理する最大ページ数")
    a = ap.parse_args()
    print(f"書名: {book_title(a.src)}")
    n = update_book(a.src, a.out, limit=a.limit)
    ch = build_chapters(a.out)
    print(f"追加 {n} ページ / 章 {len(ch)} 個")
    for t, body in ch:
        (Path(a.out) / f"{t}.md").write_text(body, encoding="utf-8")
