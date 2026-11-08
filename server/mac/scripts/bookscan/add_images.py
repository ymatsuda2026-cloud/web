#!/usr/bin/env python3
"""
これまでに変換した EPUB に、挿絵と図をあとから付ける。

  ~/epub2gh/.venv/bin/python add_images.py              … まだ付けていない本を順に（最大60分）
  ~/epub2gh/.venv/bin/python add_images.py --minutes 0  … 時間の上限なしで全部
  ~/epub2gh/.venv/bin/python add_images.py --dry-run    … 対象の冊数だけ表示

本文はそのまま。元の EPUB を開き直して挿絵の位置を調べ、「どの段落のあとか」の一覧と画像を
暗号化して置く（books/<本のID>/images.json.age と images/<本のID>/）。
以前の変換と段落が合わない章には付けない（読み位置・要約がずれないように）。
nightly_status.py から毎晩呼ばれる。
"""
import json, os, signal, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOOK_TIMEOUT = 300
WORKERS = 2


def run(cmd, timeout=None, **kw):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", "時間切れ")


def worker(bid):
    """1冊ぶん（別のプロセスで動く）。終了コード 0=付けた 2=元の本が無い 3=段落が合わない 4=失敗"""
    import warnings; warnings.filterwarnings("ignore")
    sys.path.insert(0, str(HERE))
    import epub2gh as E
    c = E.load_conf()
    catalog = E.load_json(Path(c["plain_dir"]) / "catalog.json", {})
    e = catalog.get(bid) or {}
    src = Path(e.get("src_path", ""))
    if not src.is_file():
        vol = E.find_mount(c)
        rel = ""
        try:
            rel = json.loads(Path(e.get("bundle", "")).read_text(encoding="utf-8")).get("src", "")
        except Exception:
            pass
        cand = ([vol / rel] if vol and rel else []) + ([vol / s / rel for s in c["src_subdirs"]] if vol and rel else [])
        src = next((x for x in cand if x.is_file()), None)
        if not src:
            print("元の本が見つかりません"); return 2
    try:
        bundle = json.loads(Path(e["bundle"]).read_text(encoding="utf-8"))
    except Exception:
        print("変換済みの本文を読めません"); return 4
    imgs = {}
    _, chapters = E.convert_epub(src, c, imgs)
    if len(chapters) != len(bundle.get("chapters", [])):
        print("章の数が以前の変換と合わない"); return 3
    n, skipped = E.write_images(bid, chapters, imgs, c, bundle["chapters"])
    print(json.dumps({"images": n, "skipped": skipped}))
    return 0


def main():
    a = sys.argv[1:]
    if a[:1] == ["--one"]:
        return worker(a[1])
    dry = "--dry-run" in a
    minutes = int(a[a.index("--minutes") + 1]) if "--minutes" in a else 60
    sys.path.insert(0, str(HERE))
    import warnings; warnings.filterwarnings("ignore")
    import epub2gh as E
    c = E.load_conf()
    repo = Path(c["repo_dir"])
    catalog = E.load_json(Path(c["plain_dir"]) / "catalog.json", {})
    todo = [bid for bid, e in catalog.items() if e.get("type") == "epub" and not (repo / "books" / bid / "images.json.age").exists()]
    print(f"挿絵・図: まだ付けていない EPUB {len(todo)} 冊", flush=True)
    if dry or not todo:
        return 0
    if not E.find_mount(c):
        print("挿絵・図: NAS がマウントされていないので、次の回に付けます", flush=True)
        return 0

    def one(bid):
        pr = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--one", bid],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        try:
            out, _ = pr.communicate(timeout=BOOK_TIMEOUT)
            return bid, pr.returncode, out
        except subprocess.TimeoutExpired:
            try: os.killpg(pr.pid, signal.SIGKILL)
            except Exception: pr.kill()
            return bid, 124, ""

    t0 = time.time(); done = ok = imgs = sent = 0; bad = []
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
    with ThreadPoolExecutor(WORKERS) as ex:
        it = iter(todo); running = set(); stop = False
        while True:
            while not stop and len(running) < WORKERS:
                if minutes and time.time() - t0 > minutes * 60:
                    print(f"挿絵・図: {minutes}分たったので、残りは次の回に付けます", flush=True); stop = True; break
                bid = next(it, None)
                if bid is None:
                    stop = True; break
                running.add(ex.submit(one, bid))
            if not running:
                break
            fin, running = wait(running, return_when=FIRST_COMPLETED)
            for f in fin:
                bid, code, out = f.result(); done += 1
                title = catalog.get(bid, {}).get("title", bid)[:40]
                if code == 0:
                    ok += 1
                    try: imgs += json.loads(out.strip().splitlines()[-1]).get("images", 0)
                    except Exception: pass
                else:
                    bad.append(f"{title}（{ {2: '元の本なし', 3: '段落が合わない', 124: '時間切れ'}.get(code, '失敗') }）")
                if done % 10 == 0 or done == len(todo):
                    print(f"挿絵・図: {done}/{len(todo)} 冊（付けた本 {ok}・画像 {imgs} 点）経過 {int(time.time() - t0) // 60}分", flush=True)
            if ok - sent >= 50:
                if E.needs_push(repo):
                    E.run(["git", "add", "images", "books"], cwd=repo, check=False)
                    E.run(["git", "commit", "-q", "-m", f"挿絵・図を追加（{ok - sent}冊）"], cwd=repo, check=False)
                    E.run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo, check=False)
                    E.run(["git", "push", "-q"], cwd=repo, check=False)
                sent = ok
    for b in bad[:20]:
        print(f"挿絵・図: 付けなかった本: {b}", flush=True)
    print(f"挿絵・図: {ok} 冊に画像 {imgs} 点を付けました", flush=True)
    if ok:
        E.run(["git", "add", "images", "books"], cwd=repo, check=False)
        E.run(["git", "commit", "-q", "-m", f"挿絵・図を追加（{ok - sent}冊）"], cwd=repo, check=False)
        E.run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo, check=False)
        if E.run(["git", "push", "-q"], cwd=repo, check=False).returncode == 0:
            print("挿絵・図: GitHub に送りました", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
