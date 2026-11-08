#!/bin/bash
# 暗号化リポジトリを平文に戻す（鍵を紛失した別Macでの復元用）
# 使い方: ./decrypt.sh [出力先]   書名一覧だけ見る: ./decrypt.sh --list
set -euo pipefail
KEY=~/.config/epub2gh/key.txt
REPO=~/epub2gh/repo
if [ "${1:-}" = "--list" ]; then age -d -i "$KEY" "$REPO/index.json.age"; exit; fi
OUT="${1:-$HOME/epub2gh/restored}"
find "$REPO/books" -name '*.age' | while read -r f; do
  rel="${f#$REPO/books/}"; dst="$OUT/${rel%.age}"
  mkdir -p "$(dirname "$dst")"; age -d -i "$KEY" -o "$dst" "$f"
done
age -d -i "$KEY" -o "$OUT/index.json" "$REPO/index.json.age"
echo "復号完了: $OUT"
