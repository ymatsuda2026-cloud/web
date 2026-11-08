#!/bin/bash
# epub2gh を毎日決まった時刻に実行する（夜間処理の記録つき。Mac mini で1回実行）
#   ./install-agent.sh          … 毎日 23:00
#   ./install-agent.sh 20       … 毎日 20:00
#   ./install-agent.sh 23 30    … 毎日 23:30
#   ./install-agent.sh remove   … 定期実行をやめる
# このフォルダ（例: ~/scripts/bookscan）の nightly_status.py が epub2gh.py --auto を実行し、
# 結果を書庫の「夜間処理」画面用に GitHub へ送る
set -euo pipefail
LABEL=jp.writerm.epub2gh
PLIST=~/Library/LaunchAgents/$LABEL.plist
DIR="$(cd "$(dirname "$0")" && pwd)"
PY=~/epub2gh/.venv/bin/python
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [ "${1:-}" = "remove" ]; then
  rm -f "$PLIST"
  echo "定期実行をやめました"
  exit 0
fi

HOUR=${1:-23}
MIN=${2:-0}
[ -x "$PY" ] || { echo "Python が見つかりません: $PY（先に setup.sh を実行してください）"; exit 1; }
[ -f "$DIR/epub2gh.py" ] || { echo "epub2gh.py がこのフォルダにありません: $DIR"; exit 1; }
[ -f "$DIR/nightly_status.py" ] || { echo "nightly_status.py がこのフォルダにありません: $DIR"; exit 1; }

mkdir -p ~/Library/LaunchAgents
cat > "$PLIST" << PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$DIR/nightly_status.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StandardOutPath</key><string>$DIR/epub2gh.log</string>
  <key>StandardErrorPath</key><string>$DIR/epub2gh.err.log</string>
</dict>
</plist>
PL

launchctl bootstrap "$DOMAIN" "$PLIST"
printf '登録しました：毎日 %d:%02d に実行し、結果を書庫の「夜間処理」に送ります\n' "$HOUR" "$MIN"
echo "ログ: $DIR/epub2gh.log"
echo "すぐ試す: launchctl kickstart -k $DOMAIN/$LABEL"
