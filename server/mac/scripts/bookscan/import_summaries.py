#!/usr/bin/env python3
"""
claude.ai 版の書庫で書き出した要約（shoko-summaries*.json）を、GitHub 版の書庫で読めるように
暗号化して summaries/<本のID>.json.age として本のリポジトリに置く。

  ~/epub2gh/.venv/bin/python import_summaries.py

書き出したファイルは次のどちらかに置いてあれば取り込む（取り込んだら ~/epub2gh/plain/_imported に移す）。
  ~/Downloads/shoko-summaries*.json
  ~/epub2gh/inbox/*.json
nightly_status.py から毎晩呼ばれる。夜間の自動実行で「ダウンロード」フォルダを読めない場合は、
inbox に置くか、ターミナルからこのスクリプトを実行する。
"""
import json, os, shutil, subprocess, sys, tempfile, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from make_thumbs import load_config, recipient_args, run   # 設定と暗号化の宛先は make_thumbs.py と同じ

INBOXES = [(Path("~/Downloads").expanduser(), "shoko-summaries*.json"), (Path("~/epub2gh/inbox").expanduser(), "*.json")]


def decrypt(c, path):
    r = run(["age", "-d", "-i", c["age_identity"], str(path)], timeout=60)
    return json.loads(r.stdout) if r.returncode == 0 else None


def encrypt(rec, obj, dst):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        tmp = f.name
    try:
        return run(["age", *rec, "-o", str(dst), tmp], timeout=60).returncode == 0
    finally:
        os.unlink(tmp)


def main():
    c = load_config()
    repo = Path(c["repo_dir"])
    files = []
    for d, pat in INBOXES:
        try:
            files += sorted(d.glob(pat), key=lambda p: p.stat().st_mtime)
        except PermissionError:
            print(f"要約: {d} を読めませんでした（夜間の自動実行では「ダウンロード」を読めないことがあります。~/epub2gh/inbox に置いてください）", flush=True)
    if not files:
        print("要約: 取り込むファイルはありません", flush=True)
        return 0
    rec = recipient_args(c)
    sdir = repo / "summaries"; sdir.mkdir(exist_ok=True)
    done_dir = Path(c.get("plain_dir", "~/epub2gh/plain")).expanduser() / "_imported"; done_dir.mkdir(parents=True, exist_ok=True)
    books_n = ch_n = 0
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("format") != "shoko-summaries":
            continue
        for bid, b in (data.get("books") or {}).items():
            dst = sdir / f"{bid}.json.age"
            cur = (decrypt(c, dst) if dst.exists() else None) or {"bid": bid, "chapters": {}}
            changed = False
            for no, sm in (b.get("chapters") or {}).items():
                old = cur["chapters"].get(str(no))
                if not old or (sm.get("at") or 0) >= (old.get("at") or 0):
                    cur["chapters"][str(no)] = {k: sm.get(k) for k in ("summary", "mindmap", "at")}
                    changed = True; ch_n += 1
            if changed:
                cur["title"] = b.get("title", cur.get("title", ""))
                cur["updated"] = datetime.now().isoformat(timespec="seconds")
                if encrypt(rec, cur, dst):
                    books_n += 1
        shutil.move(str(f), str(done_dir / f"{datetime.now():%Y%m%d-%H%M%S}-{f.name}"))
    print(f"要約: {books_n} 冊・{ch_n} 章を取り込みました", flush=True)
    if books_n:
        run(["git", "add", "summaries"], cwd=repo)
        run(["git", "commit", "-q", "-m", f"要約を取り込み（{books_n}冊）"], cwd=repo)
        for _ in range(3):
            run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo, timeout=300)
            if run(["git", "push", "-q"], cwd=repo, timeout=600).returncode == 0:
                print("要約: GitHub に送りました", flush=True)
                break
            time.sleep(5)
        else:
            print("要約: push できませんでした（次の回にまとめて送ります）", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
