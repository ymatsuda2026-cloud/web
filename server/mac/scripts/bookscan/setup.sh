#!/bin/bash
# 初回セットアップ（Mac mini で1回だけ実行）  使い方: ./setup.sh [リポジトリ名]
set -euo pipefail
REPO_NAME="${1:-book-archive}"
BASE=~/epub2gh
CONF=~/.config/epub2gh

brew install age ocrmypdf tesseract tesseract-lang gh
mkdir -p "$BASE" "$CONF"
python3 -m venv "$BASE/.venv"
"$BASE/.venv/bin/pip" install -q ebooklib beautifulsoup4 lxml markdownify pymupdf
cp "$(dirname "$0")/epub2gh.py" "$BASE/"

# 暗号鍵（秘密鍵は絶対にGitHubへ上げない。必ず別の場所にバックアップ）
if [ ! -f "$CONF/key.txt" ]; then
  age-keygen -o "$CONF/key.txt"
  chmod 600 "$CONF/key.txt"
  age-keygen -y "$CONF/key.txt" > "$CONF/recipients.txt"
  echo "⚠ 秘密鍵 $CONF/key.txt をパスワードマネージャ等にバックアップしてください"
fi

gh auth status >/dev/null 2>&1 || gh auth login
if [ ! -d "$BASE/repo/.git" ]; then
  cd "$BASE"
  gh repo view "$REPO_NAME" >/dev/null 2>&1 || gh repo create "$REPO_NAME" --private
  gh repo clone "$REPO_NAME" repo
  printf '# book-archive\n\n中身は age で暗号化済み。復号は decrypt.sh を使用。\n' > repo/README.md
fi
echo "完了。 $BASE/.venv/bin/python $BASE/epub2gh.py --dry-run で確認し、./install-agent.sh で定期実行に登録できます"
