#!/usr/bin/env python3
"""
epub2gh の夜間処理を実行し、結果を「書庫」の夜間処理ダッシュボード用に GitHub へ置く。

  ~/epub2gh/.venv/bin/python nightly_status.py          … epub2gh.py --auto と make_thumbs.py を実行して結果を記録
  ~/epub2gh/.venv/bin/python nightly_status.py --dry-run … 実行せず、記録ファイルの中身だけ表示

結果は暗号化した status.json.age（直近60回分）として、本のリポジトリに push する。
epub2gh.py 本体には手を入れない。
"""
import json, os, re, subprocess, sys, tempfile, time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = Path("~/.config/epub2gh/config.json").expanduser()
KEEP = 60
ERR_RE = re.compile(r"失敗|エラー|できませんでした|見つかりません|Traceback|Error|error|Exception")


def run(cmd, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    return subprocess.run(cmd, **kw)


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


def head(repo):
    r = run(["git", "rev-parse", "HEAD"], cwd=repo)
    return r.stdout.strip() if r.returncode == 0 else None


def converted_since(repo, before):
    """この回に新しく追加された本（books/<bid>/bundle.json.age）"""
    if not before:
        return []
    r = run(["git", "diff", "--name-only", "--diff-filter=A", before, "HEAD", "--", "books"], cwd=repo)
    bids = []
    for line in r.stdout.splitlines():
        m = re.match(r"books/([^/]+)/bundle\.json\.age$", line.strip())
        if m and m.group(1) not in bids:
            bids.append(m.group(1))
    return bids


def read_status(c, path):
    if not path.exists():
        return {"runs": []}
    r = run(["age", "-d", "-i", c["age_identity"], str(path)])
    if r.returncode:
        print(f"これまでの記録を読めなかったので、新しく作ります: {r.stderr.strip()}", file=sys.stderr)
        return {"runs": []}
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"runs": []}


def write_status(c, path, data):
    rec = recipient_args(c)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        tmp = f.name
    try:
        r = run(["age", *rec, "-o", str(path), tmp])
        if r.returncode:
            raise RuntimeError("暗号化に失敗しました: " + r.stderr.strip())
    finally:
        os.unlink(tmp)


def push(repo):
    run(["git", "add", "status.json.age"], cwd=repo)
    if run(["git", "diff", "--cached", "--quiet"], cwd=repo).returncode == 0:
        return True
    run(["git", "commit", "-q", "-m", "夜間処理の記録を更新"], cwd=repo)
    for _ in range(3):
        run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo)
        if run(["git", "push", "-q"], cwd=repo).returncode == 0:
            return True
        time.sleep(5)
    return False


def main():
    dry = "--dry-run" in sys.argv
    c = load_config()
    repo = Path(c["repo_dir"])
    spath = repo / "status.json.age"
    if dry:
        print(json.dumps(read_status(c, spath), ensure_ascii=False, indent=1))
        return

    run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo)
    before = head(repo)
    start = datetime.now().astimezone()
    # epub2gh.py を実行し、出力はそのままログにも流す
    p = subprocess.Popen([sys.executable, str(HERE / "epub2gh.py"), "--auto"], cwd=HERE,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = []
    for line in p.stdout:
        sys.stdout.write(line); sys.stdout.flush()
        lines.append(line.rstrip("\n"))
    code = p.wait()
    # claude.ai 版で書き出した要約を取り込む
    if (HERE / "import_summaries.py").exists():
        try:
            t = run([sys.executable, str(HERE / "import_summaries.py")], cwd=HERE, timeout=1800)
        except subprocess.TimeoutExpired:
            t = subprocess.CompletedProcess([], 124, "", "要約の取り込みが時間切れになりました")
        for line in (t.stdout + t.stderr).splitlines():
            print(line); lines.append(line)
    # 表紙のサムネイルを作る（失敗しても変換の結果には影響させない）
    if (HERE / "make_thumbs.py").exists():
        try:
            t = run([sys.executable, str(HERE / "make_thumbs.py"), "--minutes", "90"], cwd=HERE, timeout=3 * 3600)
        except subprocess.TimeoutExpired:
            t = subprocess.CompletedProcess([], 124, "", "サムネイル作成が時間切れになりました")
        for line in (t.stdout + t.stderr).splitlines():
            print(line); lines.append(line)
    # これまでに変換した EPUB に挿絵・図を付ける（少しずつ）
    if (HERE / "add_images.py").exists():
        try:
            t = run([sys.executable, str(HERE / "add_images.py"), "--minutes", "60"], cwd=HERE, timeout=2 * 3600)
        except subprocess.TimeoutExpired:
            t = subprocess.CompletedProcess([], 124, "", "挿絵・図の追加が時間切れになりました")
        for line in (t.stdout + t.stderr).splitlines():
            print(line); lines.append(line)
    end = datetime.now().astimezone()

    errors = [l.strip()[:300] for l in lines if ERR_RE.search(l)][:30]
    entry = {
        "start": start.isoformat(timespec="seconds"),
        "end": end.isoformat(timespec="seconds"),
        "code": code,
        "converted": converted_since(repo, before),
        "errors": errors,
        "tail": [l[:300] for l in lines[-15:]],
    }
    data = read_status(c, spath)
    data["runs"] = ([entry] + data.get("runs", []))[:KEEP]
    data["updated"] = end.isoformat(timespec="seconds")
    data["limit"] = c.get("daily_limit", 20)
    try:
        write_status(c, spath, data)
        if not push(repo):
            print("夜間処理の記録を push できませんでした（次の回にまとめて送ります）", file=sys.stderr)
    except Exception as e:
        print(f"夜間処理の記録を書けませんでした: {e}", file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
