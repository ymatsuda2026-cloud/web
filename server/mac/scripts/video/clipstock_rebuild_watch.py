#!/usr/bin/env python3
"""ブラウザからの「一覧JSONを作り直して」という依頼を拾って実行する。

clipstock の画面(GitHub Pages)から Mac は直接叩けないため、GAS の
スクリプトプロパティに置かれた印を取りに行く方式にしている。
画面側で次の操作をすると印が付く:
  - 詳細の「この項目を作り直す」「すべて生成」
  - トップバーの「まとめて生成」
  - マインドマップの公開 / 非公開の切り替え

印があれば build_clipstock_json.py で index-*.json / idea-*.json を作り直し、
--push を付けていれば github_sync.py で GitHub へ反映する。

環境変数 (既定で ~/.video_notion_sync.env からも読む):
  CLIPSTOCK_GAS_URL       GASウェブアプリの /exec URL(必須)
  CLIPSTOCK_ACCESS_TOKEN  GASのスクリプトプロパティ ACCESS_TOKEN と同じ値(必須)
  CLIPSTOCK_OUT_DIR       出力先(省略時はリポジトリの data/clipstock)
  CLIPSTOCK_SYNC_CONFIG   github_sync.py に渡す設定JSON(省略時は ../github/config/clipstock.json)
  GITHUB_SYNC_SCRIPT      github_sync.py のパス
  VIDEO_ENV_FILE          環境変数ファイルのパス

使い方:
    python3 clipstock_rebuild_watch.py --once            # cron向け。1回だけ確認
    python3 clipstock_rebuild_watch.py --once --push     # 作り直したらpushまでする
    python3 clipstock_rebuild_watch.py --interval 60     # 常駐して60秒ごとに確認
"""
import argparse
import fcntl
from functools import wraps
import json
import os
import subprocess
import sys
import time
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
BUILDER = SCRIPT_DIR / "build_clipstock_json.py"
SYNC_SCRIPT = Path(os.environ.get("GITHUB_SYNC_SCRIPT", str(SCRIPT_DIR.parent / "github" / "github_sync.py")))
SYNC_CONFIG = Path(os.environ.get("CLIPSTOCK_SYNC_CONFIG", str(SCRIPT_DIR.parent / "github" / "config" / "clipstock.json")))

ENV_FILE = Path(os.environ.get("VIDEO_ENV_FILE", str(Path.home() / ".video_notion_sync.env")))


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


load_env()

GAS_URL = os.environ.get("CLIPSTOCK_GAS_URL", "").strip()
ACCESS_TOKEN = os.environ.get("CLIPSTOCK_ACCESS_TOKEN", "").strip()
OUT_DIR = (
    Path(os.environ["CLIPSTOCK_OUT_DIR"]).expanduser()
    if os.environ.get("CLIPSTOCK_OUT_DIR")
    else (REPO_ROOT / "data" / "clipstock" if REPO_ROOT else None)
)
LOCK_FILE = Path(os.environ.get("CLIPSTOCK_REBUILD_WATCH_LOCK_FILE", str(Path.home() / ".clipstock_rebuild_watch.lock")))


def single_instance(lock_file):
    def decorate(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            handle = open(lock_file, "w")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                log(f"別の一覧再生成ウォッチャーが実行中のため終了します: {lock_file}")
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


def log(msg):
    print(f"[{datetime.now(JST).strftime('%H:%M:%S')}] {msg}", flush=True)


# GASは正しいリクエストでもリダイレクト先(script.googleusercontent.com)が
# 404を返すことがある。投げ直せば通るので、諦める前に何度か試す。
RETRY_WAITS = [1, 3, 8, 20, 40]
RETRY_CODES = {404, 429, 500, 502, 503, 504}


def post_gas(payload):
    last = None
    for wait in [0] + RETRY_WAITS:
        if wait:
            time.sleep(wait)
        # 毎回URLを変える。同じURLだと壊れたリダイレクトを掴んだまま繰り返す
        sep = "&" if "?" in GAS_URL else "?"
        url = f"{GAS_URL}{sep}r={int(time.time() * 1000):x}"
        try:
            resp = requests.post(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "text/plain;charset=utf-8"},
                timeout=60,
            )
            if resp.status_code in RETRY_CODES:
                last = requests.HTTPError(f"HTTP {resp.status_code}")
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            last = e
    raise last


def take_request():
    """GASに溜まった依頼を引き取る。取れたら {'requestedAt':..., 'reasons':[...]}。"""
    body = post_gas({"action": "takeRebuildRequest", "token": ACCESS_TOKEN})
    if not body.get("ok"):
        raise RuntimeError(body.get("error") or "GASがエラーを返しました")
    data = body.get("data") or {}
    return data if data.get("requestedAt") else None


def rebuild():
    if not BUILDER.exists():
        log(f"❌ {BUILDER.name} が見つかりません")
        return False
    if OUT_DIR is None:
        log("❌ 出力先を決められません。CLIPSTOCK_OUT_DIR で data/clipstock を指定してください")
        return False
    result = subprocess.run(
        [sys.executable, str(BUILDER), "--out", str(OUT_DIR)],
        capture_output=True, text=True, timeout=900)
    out = (result.stdout or "").strip()
    if out:
        print(out, flush=True)
    if result.returncode != 0:
        log(f"❌ 一覧JSONの生成に失敗: {(result.stderr or '').strip()[-300:]}")
        return False
    log(f"✅ 一覧JSONを更新: {OUT_DIR}")
    return True


def push():
    if not SYNC_SCRIPT.exists():
        log(f"⚠️ {SYNC_SCRIPT} が見つからないためpushしません")
        return
    if not SYNC_CONFIG.exists():
        log(f"⚠️ {SYNC_CONFIG} が見つからないためpushしません")
        return
    result = subprocess.run(
        [sys.executable, str(SYNC_SCRIPT), "--config", str(SYNC_CONFIG)],
        capture_output=True, text=True, timeout=900)
    out = (result.stdout or "").strip()
    if out:
        print(out, flush=True)
    if result.returncode != 0:
        log(f"⚠️ pushに失敗: {(result.stderr or result.stdout or '').strip()[-300:]}")
    else:
        log("✅ GitHubへpushしました")


def run_once(do_push):
    try:
        req = take_request()
    except Exception as e:
        log(f"⚠️ 依頼の確認に失敗: {type(e).__name__}: {e}")
        return
    if not req:
        return
    log(f"依頼を受け取りました ({req.get('requestedAt')}) 理由: {','.join(req.get('reasons') or [])}")
    if rebuild() and do_push:
        push()


@single_instance(LOCK_FILE)
def main():
    ap = argparse.ArgumentParser(description="clipstockの一覧JSON作り直し依頼を拾う")
    ap.add_argument("--once", action="store_true", help="1回だけ確認して終わる(cron向け)")
    ap.add_argument("--interval", type=int, default=60, help="常駐時の確認間隔(秒)")
    ap.add_argument("--push", action="store_true", help="作り直したあとGitHubへpushする")
    args = ap.parse_args()

    if not GAS_URL or not ACCESS_TOKEN:
        print("❌ CLIPSTOCK_GAS_URL と CLIPSTOCK_ACCESS_TOKEN を設定してください"
              f"（{ENV_FILE} でも可）", file=sys.stderr)
        return 1

    if args.once:
        run_once(args.push)
        return 0

    log(f"依頼待ち受け開始: {args.interval}秒ごと / 出力先 {OUT_DIR}")
    while True:
        run_once(args.push)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
