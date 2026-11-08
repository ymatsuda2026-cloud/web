#!/usr/bin/env python3
"""Notionの動画DBとweb記事DBを読み、動画ナレッジ(clipstock)の一覧用JSONを書き出す。

アプリは開くたびにGAS経由でNotionを全件クエリしていて、件数が増えるほど
最初の描画までが遅かった。cronでこのスクリプトを回してJSONを先に用意しておき、
画面はそれを読むだけにする。詳細(タブごとの本文)は従来どおりNotionから取るので、
ここでは一覧とアイデア一覧に要るものだけを書き出す。

出力(取り込み元ごとにNotionが別なので、ファイルも分ける):
  index-video.json / index-web.json  カード表示・検索・絞り込みに要る項目(長文は有無のフラグだけ)
  idea-video.json  / idea-web.json   応用と活用アイデアの本文(アイデア一覧画面が使う)

「分類」カラムが入っているページは上のファイルには入れず、分類ごとに分けて書く:
  index-<分類>-video.json / idea-<分類>-web.json ...
分類が増えたら spaces.json にも足すので、画面側は ?space=<分類> で切り替えられる。

環境変数:
  NOTION_TOKEN       Notion Integration Token(必須)
  WEB_NOTION_TOKEN   web記事DBを別の統合に接続しているときのトークン(あればこちらを優先)
  VIDEO_ENV_FILE     環境変数を読み込むファイルのパス(既定: ~/.video_notion_sync.env)
  VIDEO_DB_ID        対象データベースID
  WEB_DB_ID          web記事DBのID(空文字にするとwebを読まない)
  CLIPSTOCK_OUT_DIR  出力先ディレクトリ(--out より弱い)

使い方:
    python3 build_clipstock_json.py
    python3 build_clipstock_json.py --out ~/Claude/app/clipstock/data
"""
import argparse
import fcntl
from functools import wraps
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

JST = timezone(timedelta(hours=9))
SCRIPT_DIR = Path(__file__).resolve().parent


def find_repo_root():
    """リポジトリの位置を探す。~/scripts などにコピーして使うことがあるため。"""
    for d in (SCRIPT_DIR, *SCRIPT_DIR.parents):
        if (d / ".git").exists() or (d / "data" / "clipstock").is_dir():
            return d
    return None


REPO_ROOT = find_repo_root()

ENV_FILE = Path(os.environ.get("VIDEO_ENV_FILE", str(Path.home() / ".video_notion_sync.env")))


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_env()

NOTION_API = "https://api.notion.com/v1"
NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
# web記事DBを別の統合(例:「サイト」)に接続している場合は WEB_NOTION_TOKEN を使う
WEB_NOTION_TOKEN = os.environ.get("WEB_NOTION_TOKEN") or NOTION_TOKEN
VIDEO_DB_ID = os.environ.get("VIDEO_DB_ID", "3630e7a535dc8154ac62d41f7611540f")
WEB_DB_ID = os.environ.get("WEB_DB_ID", "4130e7a535dc83509c9a01cd6ac0a6a7").strip()

# Notion側のカラム名。gas/Code.gs の PROP_* と一致させること
PROP_TITLE = "動画タイトル"
PROP_WEB_TITLE = "タイトル"  # web記事DB側のタイトル欄。他のカラム名は共通
PROP_URL = "URL"
PROP_THUMB = "サムネイル"
PROP_TAGS = "タグ"
PROP_STATUS = "状態"
PROP_SUMMARY = "要約"
PROP_MINDMAP = "マインドマップ"
PROP_FIELDS = "分野別要約"
PROP_APPLY = "応用"
PROP_IDEAS = "活用アイデア"
PROP_MEMO = "メモ"
PROP_MODEL = "要約モデル"
PROP_GENERATED = "要約日時"
PROP_RAW_COUNT = "原文文字数"
PROP_PUBLIC = "公開"  # checkbox。マインドマップ一覧に並べるか
PROP_CREATED = "作成日時"
PROP_CATEGORY = "分類"  # 空ならまとめて1つ、入っていれば分類ごとにファイルを分ける

STATUS_NEW = "新規"
LOCK_FILE = Path(os.environ.get("CLIPSTOCK_BUILD_LOCK_FILE", str(Path.home() / ".clipstock_build_clipstock_json.lock")))

# spaces.json で取り込み元とスペースのIDに使えない名前(基本の3つとぶつかる)
RESERVED_IDS = {"all", "video", "web"}


def single_instance(lock_file):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            handle = open(lock_file, "w")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                print(f"別の一覧生成処理が実行中のため終了します: {lock_file}")
                return 0
            try:
                handle.write(str(os.getpid()))
                handle.flush()
                return function(*args, **kwargs)
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
                handle.close()
        return wrapped
    return decorate

# ---------------------------------------------------------------- Notion


def notion_headers(token=None):
    return {
        "Authorization": f"Bearer {token or NOTION_TOKEN}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }


def query_all_pages(db_id, sort, token=None):
    """DBの全ページを作成日時の新しい順で取得する。"""
    pages = []
    cursor = None
    while True:
        payload = {"page_size": 100, "sorts": [sort]}
        if cursor:
            payload["start_cursor"] = cursor
        resp = requests.post(
            f"{NOTION_API}/databases/{db_id}/query",
            headers=notion_headers(token),
            json=payload,
            timeout=60,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Notion API {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        pages.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return pages


def collect_pages():
    """動画DBとweb記事DBのページを (page, source) で返す。

    web側はあとから足したものなので、共有し忘れなどで落ちても動画分は書き出す。
    webはDBに「作成日時」カラムが無くても並べられるよう、ページの作成時刻でソートする。
    """
    pages = [
        (page, "video")
        for page in query_all_pages(VIDEO_DB_ID, {"property": PROP_CREATED, "direction": "descending"})
    ]
    if WEB_DB_ID:
        try:
            pages += [
                (page, "web")
                for page in query_all_pages(
                    WEB_DB_ID,
                    {"timestamp": "created_time", "direction": "descending"},
                    token=WEB_NOTION_TOKEN,
                )
            ]
        except Exception as err:  # noqa: BLE001
            print(f"web記事DBを読めませんでした(動画だけ書き出します): {err}", file=sys.stderr)
    return pages


# ---------------------------------------------------------------- プロパティの読み出し


def plain_text(rich):
    return "".join(part.get("plain_text", "") for part in (rich or []))


def title_of(props, name):
    return plain_text((props.get(name) or {}).get("title"))


def rich_of(props, name):
    return plain_text((props.get(name) or {}).get("rich_text"))


def url_of(props, name):
    return (props.get(name) or {}).get("url") or ""


def select_of(props, name):
    sel = (props.get(name) or {}).get("select")
    return (sel or {}).get("name") or ""


def multi_select_of(props, name):
    return [o.get("name", "") for o in (props.get(name) or {}).get("multi_select") or []]


def number_of(props, name):
    value = (props.get(name) or {}).get("number")
    return value if isinstance(value, (int, float)) else 0


def checkbox_of(props, name):
    return bool((props.get(name) or {}).get("checkbox"))


def date_of(props, name):
    date = (props.get(name) or {}).get("date")
    return (date or {}).get("start")


def created_of(page, props):
    prop = props.get(PROP_CREATED) or {}
    return prop.get("created_time") or page.get("created_time")


def category_of(props):
    """分類。select / multi_select / テキストのどれで作られていても読む。"""
    prop = props.get(PROP_CATEGORY) or {}
    kind = prop.get("type")
    if kind == "select":
        return ((prop.get("select") or {}).get("name") or "").strip()
    if kind == "multi_select":
        names = [o.get("name", "") for o in prop.get("multi_select") or []]
        return (names[0] if names else "").strip()
    if kind == "rich_text":
        return plain_text(prop.get("rich_text")).strip()
    return ""


def slug(category):
    """分類名をファイル名とIDに使える形にする。日本語はそのまま残す。"""
    name = "".join(c for c in str(category) if c.isprintable() and c not in '/\\:*?"<>|')
    name = "_".join(name.split()).strip("._")[:40]
    if not name:
        return ""
    return f"c-{name}" if name in RESERVED_IDS else name


# ---------------------------------------------------------------- 変換


def title_any_of(props):
    """title型のプロパティを探す。DBごとに名前が違う(動画タイトル / タイトル)ため。"""
    for name in (PROP_TITLE, PROP_WEB_TITLE):
        text = title_of(props, name)
        if text:
            return text
    for value in props.values():
        if isinstance(value, dict) and value.get("type") == "title":
            return plain_text(value.get("title"))
    return ""


def to_item(page, source):
    """gas/Code.gs の listVideos_ と同じ形にする。webは状態が空欄なら None。"""
    p = page.get("properties", {})
    status = select_of(p, PROP_STATUS)
    if source == "web" and not status:
        return None
    return {
        "key": page["id"],
        "source": source,
        "category": category_of(p),
        "title": title_any_of(p) or "(タイトル未取得)",
        "url": url_of(p, PROP_URL),
        "thumb": url_of(p, PROP_THUMB),
        "status": status or STATUS_NEW,
        "tags": multi_select_of(p, PROP_TAGS),
        "createdAt": created_of(page, p),
        "editedAt": page.get("last_edited_time"),
        "summary": rich_of(p, PROP_SUMMARY),
        "model": rich_of(p, PROP_MODEL) or None,
        "generatedAt": date_of(p, PROP_GENERATED),
        "rawCount": number_of(p, PROP_RAW_COUNT),
        "isPublic": checkbox_of(p, PROP_PUBLIC),
        "has": {
            "mindmap": bool(rich_of(p, PROP_MINDMAP)),
            "fields": bool(rich_of(p, PROP_FIELDS)),
            "apply": bool(rich_of(p, PROP_APPLY)),
            "ideas": bool(rich_of(p, PROP_IDEAS)),
            "memo": bool(rich_of(p, PROP_MEMO)),
        },
    }


def to_idea(page, source):
    """gas/Code.gs の listIdeas_ と同じ形。応用も活用も無いページは None を返す。

    musicスペースだけは例外で、原文があればAI生成前でも残す。
    プレイヤーは idea-music-video.json を曲リストとして読むため。
    """
    p = page.get("properties", {})
    apply_text = rich_of(p, PROP_APPLY)
    ideas_text = rich_of(p, PROP_IDEAS)
    category = category_of(p)
    if not apply_text and not ideas_text:
        is_music = SPACE_MODES.get(category) == "music"
        if not (is_music and number_of(p, PROP_RAW_COUNT) > 0):
            return None
    status = select_of(p, PROP_STATUS)
    if source == "web" and not status:
        return None
    return {
        "key": page["id"],
        "source": source,
        "category": category,
        "title": title_any_of(p),
        "url": url_of(p, PROP_URL),
        "thumb": url_of(p, PROP_THUMB),
        "tags": multi_select_of(p, PROP_TAGS),
        "status": status,
        "apply": apply_text,
        "ideas": ideas_text,
    }


# ---------------------------------------------------------------- 出力


def write_json(path, payload):
    """書き込み中のファイルを画面に読ませないよう、一時ファイルを作ってから差し替える。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def file_name(prefix, category, source):
    """分類なしは従来どおりの名前にする(既存のリンクとフォールバックを壊さないため)。"""
    key = slug(category)
    return f"{prefix}-{key}-{source}.json" if key else f"{prefix}-{source}.json"


SOURCE_LABELS = {"video": "動画", "web": "Web"}

# 分類ごとの見せ方。画面側が ?space=<分類> のタブ構成とAI生成の中身を切り替える
SPACE_MODES = {"music": "music"}


def base_spaces():
    return {
        "version": 1,
        "_note": "build_clipstock_json.py が分類ぶんを自動で足す。auto が付いた項目は"
                 "分類が消えると自動で消えるので、手で直したいものは auto を外すこと。",
        "default": "all",
        "sources": {
            "video": {"label": "動画", "list": "index-video.json", "idea": "idea-video.json", "db": "video"},
            "web": {"label": "Web", "list": "index-web.json", "idea": "idea-web.json", "db": "web"},
        },
        "spaces": [
            {"id": "all", "label": "すべて", "sources": ["video", "web"]},
            {"id": "video", "label": "動画", "sources": ["video"]},
            {"id": "web", "label": "Web記事", "sources": ["web"]},
        ],
    }


def update_spaces(out_dir, categories):
    """分類の増減を spaces.json に反映する。

    手で足した項目や書き換えたラベルを消さないよう、面倒を見るのは auto を付けた項目だけ。
    分類が消えたときは、その auto 項目だけ取り下げる(書き出したJSONは残る)。
    """
    path = out_dir / "spaces.json"
    doc = base_spaces()
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and loaded.get("sources") and loaded.get("spaces"):
                doc = loaded
        except Exception as err:  # noqa: BLE001  壊れていたら作り直す
            print(f"spaces.json を読めないため作り直します: {err}", file=sys.stderr)

    sources = doc.setdefault("sources", {})
    spaces = doc.setdefault("spaces", [])
    keys = {slug(c) for c in categories}
    keys.discard("")

    for key, category in sorted({slug(c): c for c in categories}.items()):
        if not key:
            continue
        ids = []
        for source in ("video", "web"):
            sid = f"{key}-{source}"
            ids.append(sid)
            if sid not in sources:
                sources[sid] = {
                    "label": f"{category}({SOURCE_LABELS[source]})",
                    "list": file_name("index", category, source),
                    "idea": file_name("idea", category, source),
                    "db": source,
                    "category": category,
                    "auto": True,
                }
        space = next((s for s in spaces if s.get("id") == key), None)
        if space is None:
            space = {"id": key, "label": category, "sources": ids, "auto": True}
            spaces.append(space)
        # 見せ方はコード側の対応表が正とするので、自動項目は毎回揃え直す
        if space.get("auto") and SPACE_MODES.get(category):
            space["mode"] = SPACE_MODES[category]

    # 無くなった分類の自動項目を取り下げる
    doc["spaces"] = [s for s in spaces if not s.get("auto") or s.get("id") in keys]
    doc["sources"] = {
        sid: spec
        for sid, spec in sources.items()
        if not spec.get("auto") or sid.rsplit("-", 1)[0] in keys
    }

    write_json(path, doc)
    return path


@single_instance(LOCK_FILE)
def main():
    parser = argparse.ArgumentParser(description="動画ナレッジの一覧JSONを書き出す")
    parser.add_argument(
        "--out",
        default=os.environ.get("CLIPSTOCK_OUT_DIR")
        or (str(REPO_ROOT / "data" / "clipstock") if REPO_ROOT else None),
        help="出力先ディレクトリ",
    )
    parser.add_argument("--dry-run", action="store_true", help="件数だけ表示して書き出さない")
    args = parser.parse_args()

    if not args.out:
        print("出力先を決められません。CLIPSTOCK_OUT_DIR または --out で data/clipstock を指定してください",
              file=sys.stderr)
        return 1

    if not NOTION_TOKEN:
        print("NOTION_TOKEN が未設定です", file=sys.stderr)
        return 1

    pages = collect_pages()
    items = [item for item in (to_item(page, source) for page, source in pages) if item]
    items.sort(key=lambda i: i.get("createdAt") or "", reverse=True)
    ideas = [idea for idea in (to_idea(page, source) for page, source in pages) if idea]
    generated_at = datetime.now(JST).isoformat()

    def pick(rows, category, source):
        return [r for r in rows if r["source"] == source and (r.get("category") or "") == category]

    # 分類名はJSONのキーではなくファイル名になるので、空でないものだけ集める
    categories = sorted({(r.get("category") or "") for r in items + ideas} - {""})

    print(
        f"動画 {len([r for r in items if r['source'] == 'video'])}件"
        f" / web {len([r for r in items if r['source'] == 'web'])}件"
        f" / アイデアのあるもの {len(ideas)}件"
    )
    if categories:
        print("分類: " + " / ".join(f"{c}({len([r for r in items if r.get('category') == c])})" for c in categories))
    if args.dry_run:
        return 0

    # 片方のNotionが落ちてももう片方の古いファイルはそのまま残るよう、取り込み元ごとに書く
    out_dir = Path(args.out).expanduser()
    for category in [""] + categories:
        for source in ("video", "web"):
            write_json(out_dir / file_name("index", category, source),
                       {"generatedAt": generated_at, "items": pick(items, category, source)})
            write_json(out_dir / file_name("idea", category, source),
                       {"generatedAt": generated_at, "items": pick(ideas, category, source)})
    update_spaces(out_dir, categories)
    print(f"書き出しました: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
