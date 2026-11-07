#!/usr/bin/env python3
"""
ClipStock 書き出し: Notion(動画DB / web記事DB) → age で暗号化 → web-archive へ複写

ClipStock(ブラウザ)はここで作ったファイルだけを読む。Notion は叩かない。
一覧が速いのはそのため。書き込み(要約)だけが GAS 経由で Notion に行く。

web-archive の中身(すべて age で暗号化済み。GitHub 上では読めない):
  index.json.age        一覧(全件。状態つき。本文は入れない)
  notes.json.age        マーカーとメモの一覧(ノート画面用)
  night.json.age        文字起こしの状況(夜間処理画面用)
  items/<id>.json.age   1件ぶんの本文(要約・分野別・応用・活用・マップ・文字起こし)
  thumbs/<id>.jpg.age   サムネイル(幅360に縮小)

使い方:
  初回     python3.14 clipstock_export.py --init          # 鍵を作る(1回だけ)
  通常     python3.14 clipstock_export.py                  # 差分だけ書き出して push
  確認     python3.14 clipstock_export.py --dry-run        # 何も書かず、やることだけ表示
  作り直し python3.14 clipstock_export.py --full           # 差分を無視して全件

準備:
  pip install --break-system-packages pyrage requests pillow
  git clone git@github.com:ymatsuda2026-cloud/web-archive.git ~/clipstock-archive
  ~/.clipstock.env に NOTION_TOKEN=... など(SETUP.md 参照)
"""

import argparse
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

try:
    import pyrage
except ImportError:  # pragma: no cover
    pyrage = None

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

NOTION_VERSION = "2022-06-28"
DEFAULT_VIDEO_DB = "3630e7a535dc8154ac62d41f7611540f"
DEFAULT_WEB_DB = "4130e7a535dc83509c9a01cd6ac0a6a7"

# Notion のカラム名(clipstock/gas/Code.gs の PROP_* と同じ)
P_TITLE, P_WEB_TITLE = "動画タイトル", "タイトル"
P_URL, P_THUMB, P_STATUS = "URL", "サムネイル", "状態"
P_SUMMARY, P_MINDMAP, P_FIELDS = "要約", "マインドマップ", "分野別要約"
P_APPLY, P_IDEAS, P_MEMO = "応用", "活用アイデア", "メモ"
P_MODEL, P_GENERATED, P_CATEGORY = "要約モデル", "要約日時", "分類"

ST_NEW, ST_RETRY, ST_RUNNING = "新規", "再取得", "処理中"
ST_DONE, ST_SUMMARIZED, ST_EXCLUDED = "完了", "要約済み", "除外"
PENDING = {ST_NEW, ST_RETRY, ST_RUNNING}

STALE_HOURS = 24          # 未処理のままこの時間を超えたら「要確認」
KEEP_RUNS = 30            # 夜間処理の履歴を残す件数
THUMB_WIDTH = 360

TC_RE = re.compile(r"\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]")
MARK_RE = re.compile(r"<m([123])>([\s\S]*?)</m\1>")


# ---------------------------------------------------------------- 設定

def load_env(path: Path) -> dict:
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def config() -> dict:
    env = load_env(Path(os.environ.get("CLIPSTOCK_ENV", "~/.clipstock.env")).expanduser())
    env.update({k: v for k, v in os.environ.items() if k.startswith(("NOTION_", "WEB_", "VIDEO_", "ARCHIVE_", "AGE_", "STATE_"))})
    home = Path.home()
    return {
        "notion": env.get("NOTION_TOKEN", ""),
        "notion_web": env.get("WEB_NOTION_TOKEN", "") or env.get("NOTION_TOKEN", ""),
        "video_db": env.get("VIDEO_DB_ID", DEFAULT_VIDEO_DB),
        "web_db": env.get("WEB_DB_ID", DEFAULT_WEB_DB),       # 空文字なら読まない
        "archive": Path(env.get("ARCHIVE_DIR", str(home / "clipstock-archive"))).expanduser(),
        "key": Path(env.get("AGE_KEY_FILE", str(home / ".config/clipstock/key.txt"))).expanduser(),
        "state": Path(env.get("STATE_FILE", str(home / ".clipstock/state.json"))).expanduser(),
    }


# ---------------------------------------------------------------- 暗号化

def load_identity(path: Path):
    if pyrage is None:
        sys.exit("pyrage が必要です: pip install --break-system-packages pyrage")
    if not path.exists():
        sys.exit(f"鍵がありません: {path}\n先に --init を実行してください")
    for line in path.read_text().splitlines():
        if line.strip().startswith("AGE-SECRET-KEY-"):
            return pyrage.x25519.Identity.from_str(line.strip())
    sys.exit(f"{path} に AGE-SECRET-KEY- で始まる行がありません")


def init_key(path: Path) -> None:
    if pyrage is None:
        sys.exit("pyrage が必要です: pip install --break-system-packages pyrage")
    if path.exists():
        sys.exit(f"すでに鍵があります: {path}\n(上書きすると既存の書庫が読めなくなるため、何もしません)")
    ident = pyrage.x25519.Identity.generate()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# ClipStock の復号鍵。他人に渡さない・GitHub に上げない\n{ident}\n")
    path.chmod(0o600)
    print(f"鍵を作りました: {path}")
    print("ブラウザの登録画面に貼る「復号の鍵」は、このファイルの AGE-SECRET-KEY- で始まる1行です。")
    print(f"公開鍵(暗号化に使う側): {ident.to_public()}")


class Sealer:
    def __init__(self, identity):
        self.recipient = identity.to_public()

    def seal(self, data: bytes) -> bytes:
        return pyrage.encrypt(data, [self.recipient])


# ---------------------------------------------------------------- Notion

class Notion:
    def __init__(self, token: str):
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"Bearer {token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        })

    def call(self, method: str, path: str, payload=None):
        for attempt in range(6):
            r = self.s.request(method, f"https://api.notion.com/v1/{path}", json=payload, timeout=60)
            if r.status_code == 429:
                time.sleep(float(r.headers.get("Retry-After", 2 ** attempt)))
                continue
            if r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            if r.status_code >= 300:
                raise RuntimeError(f"Notion {r.status_code}: {r.text[:300]}")
            return r.json()
        raise RuntimeError("Notion が応答しません(リトライ上限)")

    def query_all(self, db_id: str):
        pages, cursor = [], None
        while True:
            payload = {"page_size": 100}
            if cursor:
                payload["start_cursor"] = cursor
            res = self.call("POST", f"databases/{db_id}/query", payload)
            pages += res["results"]
            if not res.get("has_more"):
                return pages
            cursor = res["next_cursor"]

    def body_text(self, page_id: str) -> str:
        """ページ本文のテキスト系ブロックを上から連結(GAS の fetchTranscript_ と同じ)"""
        lines, cursor = [], None
        while True:
            path = f"blocks/{page_id}/children?page_size=100" + (f"&start_cursor={cursor}" if cursor else "")
            res = self.call("GET", path)
            for b in res["results"]:
                rt = (b.get(b.get("type")) or {}).get("rich_text")
                if rt:
                    t = "".join(x.get("plain_text", "") for x in rt)
                    if t:
                        lines.append(t)
            if not res.get("has_more"):
                return "\n".join(lines)
            cursor = res["next_cursor"]


def rich(props, name):
    return "".join(x.get("plain_text", "") for x in (props.get(name) or {}).get("rich_text", []))


def select(props, name):
    s = (props.get(name) or {}).get("select")
    return s["name"] if s else ""


def prop_url(props, name):
    return (props.get(name) or {}).get("url") or ""


def title_of(props):
    for p in props.values():
        if p.get("type") == "title":
            return "".join(x.get("plain_text", "") for x in p.get("title", []))
    return ""


def date_of(props, name):
    d = (props.get(name) or {}).get("date")
    return (d or {}).get("start") or ""


def youtube_thumb(url: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", url or "")
    return f"https://i.ytimg.com/vi/{m.group(1)}/mqdefault.jpg" if m else ""


def to_item(page, src: str) -> dict:
    p = page["properties"]
    url = prop_url(p, P_URL)
    return {
        "id": page["id"].replace("-", ""),
        "src": src,
        "title": title_of(p) or "(タイトル未取得)",
        "status": select(p, P_STATUS) or ST_NEW,
        "category": select(p, P_CATEGORY),
        "url": url,
        "thumb": prop_url(p, P_THUMB) or youtube_thumb(url),
        "created": page.get("created_time", ""),
        "edited": page.get("last_edited_time", ""),
        "generated": date_of(p, P_GENERATED),
        "model": rich(p, P_MODEL),
        "summary": rich(p, P_SUMMARY),
        "mindmap": rich(p, P_MINDMAP),
        "fields": rich(p, P_FIELDS),
        "apply": rich(p, P_APPLY),
        "ideas": rich(p, P_IDEAS),
        "memo": rich(p, P_MEMO),
    }


# ---------------------------------------------------------------- 変換

def plain(raw: str) -> str:
    return MARK_RE.sub(lambda m: m.group(2), raw or "")


def last_timecode(text: str) -> int:
    last = 0
    for m in TC_RE.finditer(text or ""):
        last = int(m.group(1) or 0) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return last


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def index_entry(it: dict, duration: int) -> dict:
    body = plain(it["summary"]).replace("\n", " ")[:240]
    return {
        "id": it["id"], "src": it["src"], "t": it["title"], "st": it["status"],
        "url": it["url"], "th": 1 if it["thumb"] else 0, "c": it["created"], "e": it["edited"],
        "g": it["generated"], "d": duration, "s": body, "cat": it["category"],
        "h": {k: 1 for k, v in (("sm", it["summary"]), ("mm", it["mindmap"]), ("fl", it["fields"]),
                                ("ap", it["apply"]), ("id", it["ideas"]), ("me", it["memo"])) if v},
    }


def notes_of(it: dict) -> list:
    out = []
    for key, label in (("summary", "サマリ"), ("fields", "分野別"), ("apply", "応用"), ("ideas", "活用"), ("mindmap", "マップ")):
        for m in MARK_RE.finditer(it[key] or ""):
            text = TC_RE.sub("", m.group(2)).strip()
            if text:
                out.append({"id": it["id"], "f": label, "c": int(m.group(1)), "t": text[:300]})
    if it["memo"].strip():
        out.append({"id": it["id"], "f": "メモ", "c": 0, "t": it["memo"].strip()[:500]})
    return out


def make_thumb(url: str) -> bytes | None:
    try:
        r = requests.get(url, timeout=20)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        print(f"  サムネ取得失敗: {e}")
        return None
    data = r.content
    if Image is None:
        return data
    try:
        im = Image.open(io.BytesIO(data)).convert("RGB")
        if im.width > THUMB_WIDTH:
            im = im.resize((THUMB_WIDTH, round(im.height * THUMB_WIDTH / im.width)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=72, optimize=True)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return data


# ---------------------------------------------------------------- 本体

def git(repo: Path, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), *args], check=check, capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser(description="ClipStock 書き出し")
    ap.add_argument("--init", action="store_true", help="復号鍵を作る(初回のみ)")
    ap.add_argument("--full", action="store_true", help="差分を無視して全件書き出す")
    ap.add_argument("--dry-run", action="store_true", help="何も書かない")
    ap.add_argument("--no-push", action="store_true", help="commit までで push しない")
    args = ap.parse_args()
    cfg = config()

    if args.init:
        return init_key(cfg["key"])
    if not cfg["notion"]:
        sys.exit("NOTION_TOKEN がありません(~/.clipstock.env)")
    repo: Path = cfg["archive"]
    if not (repo / ".git").exists():
        sys.exit(f"{repo} が git の作業場所ではありません。web-archive を clone してください")

    sealer = Sealer(load_identity(cfg["key"]))
    state_path: Path = cfg["state"]
    state = json.loads(state_path.read_text()) if state_path.exists() and not args.full else {}
    items_state: dict = state.get("items", {})
    now = datetime.now(timezone.utc)
    stamp = now.isoformat(timespec="seconds")

    if not args.dry_run:
        git(repo, "pull", "--rebase", "--autostash", check=False)

    # --- Notion から全件のメタ情報
    pages = [(p, "video") for p in Notion(cfg["notion"]).query_all(cfg["video_db"])]
    if cfg["web_db"]:
        try:
            pages += [(p, "web") for p in Notion(cfg["notion_web"]).query_all(cfg["web_db"])]
        except Exception as e:  # noqa: BLE001  web が読めなくても動画ぶんは出す
            print(f"web記事DBを読めませんでした(動画のみ続行): {e}")
    items = [to_item(p, s) for p, s in pages]
    items = [i for i in items if i["status"] != ST_EXCLUDED]
    print(f"Notion: {len(items)} 件")

    clients = {"video": Notion(cfg["notion"]), "web": Notion(cfg["notion_web"])}
    new_state: dict = {}
    written = 0
    added, transcribed, summarized, failed = [], [], [], []

    def put(rel: str, data: bytes):
        nonlocal written
        written += 1
        if args.dry_run:
            return
        f = repo / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)

    for it in items:
        old = items_state.get(it["id"], {})
        item_file = repo / "items" / f"{it['id']}.json.age"
        changed = old.get("edited") != it["edited"] or not item_file.exists()
        duration = old.get("d", 0)

        # 状態の遷移(夜間処理の記録用)
        if not old:
            added.append(it)
        if it["status"] == ST_DONE and old.get("st") in (None, *PENDING):
            transcribed.append(it)
        if it["status"] == ST_SUMMARIZED and old.get("st") != ST_SUMMARIZED:
            summarized.append(it)

        if changed:
            try:
                transcript = ""
                if it["status"] in (ST_DONE, ST_SUMMARIZED):
                    transcript = clients[it["src"]].body_text(it["id"])
                    duration = last_timecode(transcript)
                bundle = {
                    "v": 1, "id": it["id"], "src": it["src"], "title": it["title"], "url": it["url"],
                    "status": it["status"], "created": it["created"], "generated": it["generated"], "model": it["model"],
                    "summary": it["summary"], "mindmap": it["mindmap"], "fields": it["fields"],
                    "apply": it["apply"], "ideas": it["ideas"], "memo": it["memo"], "transcript": transcript,
                }
                put(f"items/{it['id']}.json.age", sealer.seal(dumps(bundle).encode("utf-8")))
            except Exception as e:  # noqa: BLE001
                print(f"  × {it['title'][:40]}: {e}")
                failed.append({"id": it["id"], "t": it["title"], "why": str(e)[:120]})
                new_state[it["id"]] = old or {}
                continue

        thumb_file = repo / "thumbs" / f"{it['id']}.jpg.age"
        if it["thumb"] and (old.get("thumb") != it["thumb"] or not thumb_file.exists()):
            data = make_thumb(it["thumb"])
            if data:
                put(f"thumbs/{it['id']}.jpg.age", sealer.seal(data))

        new_state[it["id"]] = {"edited": it["edited"], "st": it["status"], "d": duration, "thumb": it["thumb"]}

    # --- 消えた/除外されたものを片づける
    live = {i["id"] for i in items}
    for sub, ext in (("items", ".json.age"), ("thumbs", ".jpg.age")):
        d = repo / sub
        if d.exists():
            for f in d.glob(f"*{ext}"):
                if f.name[: -len(ext)] not in live:
                    print(f"  削除: {sub}/{f.name}")
                    if not args.dry_run:
                        f.unlink()
                    written += 1

    # --- 一覧・ノート・夜間処理
    entries = sorted((index_entry(i, new_state.get(i["id"], {}).get("d", 0)) for i in items), key=lambda x: x["c"], reverse=True)
    notes = [n for i in items for n in notes_of(i)]

    cutoff = now - timedelta(hours=STALE_HOURS)
    def parse(ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except Exception:  # noqa: BLE001
            return now
    counts = {k: sum(1 for i in items if i["status"] == k) for k in (ST_NEW, ST_RETRY, ST_RUNNING, ST_DONE, ST_SUMMARIZED)}
    queue = [{"id": i["id"], "t": i["title"], "st": i["status"], "c": i["created"], "e": i["edited"]}
             for i in items if i["status"] != ST_SUMMARIZED]
    stale = [q["id"] for q in queue if q["st"] in PENDING and parse(q["e"]) < cutoff]

    runs = state.get("runs", [])
    if added or transcribed or summarized or failed:
        runs.insert(0, {
            "at": stamp, "total": len(items),
            "added": [{"id": i["id"], "t": i["title"]} for i in added][:50],
            "transcribed": [{"id": i["id"], "t": i["title"]} for i in transcribed][:50],
            "summarized": [{"id": i["id"], "t": i["title"]} for i in summarized][:50],
            "failed": failed[:50],
        })
        runs = runs[:KEEP_RUNS]
    night = {"v": 1, "at": stamp, "counts": counts, "queue": queue[:200], "stale": stale, "runs": runs}

    for name, payload, key in (
        ("index.json.age", {"v": 1, "at": stamp, "items": entries}, "index"),
        ("notes.json.age", {"v": 1, "notes": notes}, "notes"),
        ("night.json.age", night, "night"),
    ):
        body = dict(payload)
        body.pop("at", None)                  # 時刻だけ違っても書き直さない
        h = sha(dumps(body))
        if h != state.get("hash", {}).get(key) or not (repo / name).exists():
            put(name, sealer.seal(dumps(payload).encode("utf-8")))
            state.setdefault("hash", {})[key] = h

    print(f"書き出し: {written} ファイル / 新規 {len(added)} / 文字起こし完了 {len(transcribed)} / 要約済み {len(summarized)} / 失敗 {len(failed)}")
    if args.dry_run:
        print("(--dry-run のため何も書いていません)")
        return

    state.update({"items": new_state, "runs": runs})
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False))

    if not written:
        print("変更なし")
        return
    git(repo, "add", "-A")
    if git(repo, "diff", "--cached", "--quiet", check=False).returncode == 0:
        return
    git(repo, "commit", "-m", f"update {now.astimezone().strftime('%Y-%m-%d %H:%M')}")
    if args.no_push:
        print("commit しました(--no-push)")
        return
    r = git(repo, "push", check=False)
    print("push しました" if r.returncode == 0 else f"push に失敗: {r.stderr.strip()}")


if __name__ == "__main__":
    main()
