#!/usr/bin/env python3
"""
inbox — iPhone の登録画面（upload.html）から GitHub に届いたページを受け取り、
NAS の _images/<書名>/ に置く。そのあとは img2book.py がほかの画像と同じように処理する。

  1. book-archive リポジトリを pull
  2. inbox/<ID>/manifest.age を復号して書名とファイル名を読む
  3. 各ページを復号して NAS の _images/<書名>/<ID>_<ファイル名> に保存
  4. 全部置けたら inbox/<ID> をリポジトリから消して push

epub2gh.py が毎回の実行の最初に呼び出すので、ふだんは単体で動かす必要はない。
  ~/epub2gh/.venv/bin/python inbox.py            # 受け取りだけを今すぐ行う
  ~/epub2gh/.venv/bin/python inbox.py --dry-run  # 届いているものを見るだけ

設定（~/.config/epub2gh/config.json。なければ既定値）
  repo_dir      … book-archive の作業フォルダ（既定 ~/epub2gh/repo）
  age_identity  … 復号の秘密鍵（既定 ~/.config/epub2gh/key.txt）
  images_dir    … 受け取ったページを置く場所（既定 /Volumes/data/calibre/books/_images）
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile, unicodedata
from pathlib import Path

# 自動実行（launchd）など PATH が狭いときも tesseract・age・git が見つかるように、標準の場所を足す
_cur = [d for d in os.environ.get("PATH", "").split(os.pathsep) if d]
for _d in [os.path.dirname(sys.executable), "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
           "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]:
    if _d not in _cur and os.path.isdir(_d):
        _cur.append(_d)
os.environ["PATH"] = os.pathsep.join(_cur)

CONF_PATH = Path.home() / ".config/epub2gh/config.json"
DEFAULTS = {
    "repo_dir": str(Path.home() / "epub2gh/repo"),
    "age_identity": str(Path.home() / ".config/epub2gh/key.txt"),
    "images_dir": "/Volumes/data/calibre/books/_images",
    "branch": "main",
}


def conf():
    c = dict(DEFAULTS)
    if CONF_PATH.exists():
        c.update({k: v for k, v in json.loads(CONF_PATH.read_text()).items() if k in DEFAULTS})
    return c


def run(cmd, cwd=None, data=None):
    r = subprocess.run(cmd, cwd=cwd, input=data, capture_output=True)
    if r.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd[:3]))} に失敗: {r.stderr.decode(errors='replace').strip()}")
    return r.stdout


def decrypt(path, identity):
    return run(["age", "-d", "-i", identity, str(path)])


def safe_dir(title):
    """書名をフォルダ名にする（ショートカットで作ったフォルダと同じ名前になるように）"""
    t = unicodedata.normalize("NFC", title).strip()
    t = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", t).strip(". ")
    return t[:120] or "無題"


def safe_file(name):
    n = re.sub(r'[/\\:*?"<>|\x00-\x1f]', "_", Path(name).name)
    return n or "page"


def receive(repo, identity, dest_root, dry_run=False, log=print):
    """inbox/ に届いた登録を NAS に置き、置けたものを git rm する（commit はしない）。
       戻り値: [(書名, 件数)]"""
    repo, dest_root = Path(repo), Path(dest_root)
    inbox = repo / "inbox"
    uploads = sorted(p.parent for p in inbox.glob("*/manifest.age")) if inbox.exists() else []
    got = []
    for up in uploads:
        try:
            m = json.loads(decrypt(up / "manifest.age", identity))
        except Exception as e:
            log(f"  {up.name}: 目録を読めません（{e}）。この登録は残します")
            continue
        title, files = m.get("title") or "無題", m.get("files", [])
        dest = dest_root / safe_dir(title)
        log(f"iPhone から「{title}」 {len(files)} 件 → {dest}")
        if dry_run:
            continue
        dest.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(dir=dest, prefix=".inbox-"))   # 途中の失敗を残さない
        try:
            for f in files:
                data = decrypt(up / f["blob"], identity)
                (tmp / f"{up.name}_{safe_file(f['name'])}").write_bytes(data)
            for p in tmp.iterdir():
                os.replace(p, dest / p.name)
        except Exception as e:
            log(f"  {up.name}: 取り込みに失敗しました（{e}）。この登録は残して次回やり直します")
            continue
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        run(["git", "rm", "-r", "-q", str(up.relative_to(repo))], cwd=repo)
        got.append((title, len(files)))
    return got


def main():
    ap = argparse.ArgumentParser(description="iPhone から届いたページを受け取る")
    ap.add_argument("--dry-run", action="store_true", help="届いているものを見るだけ")
    a = ap.parse_args()
    c = conf()
    repo, ident, dest_root = Path(c["repo_dir"]), c["age_identity"], Path(c["images_dir"])

    if not Path(ident).exists():
        sys.exit(f"復号の鍵がありません: {ident}（config.json の age_identity を確かめてください）")
    if not a.dry_run and not dest_root.parent.exists():
        sys.exit(f"NAS が見つかりません: {dest_root.parent}（nas220 をマウントしてから実行してください）")

    run(["git", "pull", "--rebase", "--autostash", "-q"], cwd=repo)
    got = receive(repo, ident, dest_root, a.dry_run)
    if not got:
        if not a.dry_run:
            print("iPhone からの登録はありません")
        return
    run(["git", "commit", "-q", "-m", f"inbox 取り込み {len(got)} 件"], cwd=repo)
    run(["git", "push", "-q", "origin", f"HEAD:{c['branch']}"], cwd=repo)
    print(f"{len(got)} 件を受け取りました")


if __name__ == "__main__":
    main()
