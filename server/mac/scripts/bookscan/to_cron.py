#!/usr/bin/env python3
"""
to_cron — 書庫の夜間処理を launchd から cron に移す。

  python3 to_cron.py           # 移す（launchd の設定から実行内容と時刻を読み取って crontab に書く）
  python3 to_cron.py --test    # 2 分後に 1 回だけ cron から実行し、終わるまで待って結果を表示する
  python3 to_cron.py --undo    # launchd に戻す

  移したあと、cron に「フルディスクアクセス」を 1 度だけ許可する（NAS を読むため）:
    システム設定 > プライバシーとセキュリティ > フルディスクアクセス で ＋ →
    Command+Shift+G で /usr/sbin/cron を開いて追加

launchd の設定ファイル（.plist）は消さずに .plist.disabled に名前を変えて残す（--undo で戻せる）。
crontab は書き換える前に、このフォルダに crontab.backup-日時 として控えを取る。
"""
import argparse, os, plistlib, re, shlex, subprocess, sys, time
from datetime import datetime, timedelta
from pathlib import Path

LABEL = "jp.writerm.epub2gh"
BEGIN, END = "# >>> 書庫の夜間処理（epub2gh）", "# <<< 書庫の夜間処理（epub2gh）"
TBEGIN, TEND = "# >>> 書庫の夜間処理のテスト（to_cron.py --test が自動で消す）", "# <<< 書庫の夜間処理のテスト"
HERE = Path(__file__).resolve().parent


def sh(cmd, inp=None, check=True):
    r = subprocess.run(cmd, input=inp, capture_output=True, text=True)
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(cmd)} に失敗: {r.stderr.strip()}")
    return r


def read_crontab():
    r = sh(["crontab", "-l"], check=False)
    return r.stdout if r.returncode == 0 else ""      # 「no crontab」は空として扱う


def write_crontab(text):
    sh(["crontab", "-"], inp=text if text.endswith("\n") else text + "\n")


def drop_block(text, begin, end):
    out, skip = [], False
    for line in text.splitlines():
        if line.strip() == begin:
            skip = True
            continue
        if line.strip() == end:
            skip = False
            continue
        if not skip:
            out.append(line)
    return "\n".join(out).rstrip("\n") + ("\n" if out else "")


def load_job(plist):
    """launchd の設定から、cron の 1 行に入れるコマンドと時刻を作る"""
    d = plistlib.loads(plist.read_bytes())
    args = d.get("ProgramArguments") or ([d["Program"]] if d.get("Program") else None)
    if not args:
        sys.exit(f"{plist} に実行するコマンド（ProgramArguments）がありません")
    env = d.get("EnvironmentVariables", {})
    out, err = d.get("StandardOutPath"), d.get("StandardErrorPath")
    parts = []
    if d.get("WorkingDirectory"):
        parts.append(f"cd {shlex.quote(d['WorkingDirectory'])} &&")
    parts += [f"{k}={shlex.quote(str(v))}" for k, v in env.items()]
    parts.append(shlex.join(args))
    if out:
        parts.append(f">> {shlex.quote(out)}")
    if err:
        parts.append("2>&1" if err == out else f"2>> {shlex.quote(err)}")
    cmd = " ".join(parts).replace("%", r"\%")        # cron では % は改行の意味になる
    cal = d.get("StartCalendarInterval") or {"Hour": 23, "Minute": 0}
    times = cal if isinstance(cal, list) else [cal]
    if d.get("StartInterval") and not d.get("StartCalendarInterval"):
        sys.exit("この設定は「○秒ごと」の実行です。cron への自動変換は時刻指定の設定だけに対応しています")
    sched = []
    for t in times:
        f = lambda k: str(t[k]) if k in t else "*"
        sched.append(f"{t.get('Minute', 0)} {f('Hour')} {f('Day')} {f('Month')} {f('Weekday')}")
    return cmd, sched, out or err


def launchd(action, plist, label):
    uid = os.getuid()
    if action == "stop":
        sh(["launchctl", "bootout", f"gui/{uid}/{label}"], check=False)
    else:
        sh(["launchctl", "bootstrap", f"gui/{uid}", str(plist)], check=False)


def install(plist, label):
    disabled = plist.with_name(plist.name + ".disabled")
    src = plist if plist.exists() else disabled
    if not src.exists():
        sys.exit(f"launchd の設定が見つかりません: {plist}")
    cmd, sched, log = load_job(src)
    cur = read_crontab()
    if cur:
        bak = HERE / f"crontab.backup-{datetime.now():%Y%m%d-%H%M%S}"
        bak.write_text(cur)
        print(f"今の crontab の控え: {bak}")
    block = [BEGIN, "# launchd（" + label + "）から移行。元に戻すときは: python3 to_cron.py --undo"]
    block += [f"{s} {cmd}" for s in sched] + [END]
    new = drop_block(drop_block(cur, BEGIN, END), TBEGIN, TEND)
    write_crontab((new + "\n" if new.strip() else "") + "\n".join(block) + "\n")
    if plist.exists():
        launchd("stop", plist, label)
        plist.rename(disabled)
    print("cron に移しました:")
    for s in sched:
        print(f"  {s} {cmd}")
    print(f"launchd の自動実行は止めました（設定は {disabled.name} として残しています）")
    print("\n次に 1 度だけ、cron にフルディスクアクセスを許可してください（NAS を読むため）:\n"
          "  システム設定 > プライバシーとセキュリティ > フルディスクアクセス で ＋ →\n"
          "  Command+Shift+G で /usr/sbin/cron を開いて追加し、スイッチをオン\n"
          "許可したら、python3 to_cron.py --test で確かめてください")
    return log


def undo(plist, label):
    write_crontab(drop_block(drop_block(read_crontab(), BEGIN, END), TBEGIN, TEND))
    disabled = plist.with_name(plist.name + ".disabled")
    if disabled.exists():
        disabled.rename(plist)
    if plist.exists():
        launchd("start", plist, label)
    print("cron から外し、launchd の自動実行に戻しました")


def test(plist, label, wait_max=1800):
    """2 分後に 1 回だけ cron から実行する（cron と同じ PATH・同じ許可の条件で動く）"""
    cur = read_crontab()
    if BEGIN not in cur:
        sys.exit("まだ cron に移していません。先に python3 to_cron.py を実行してください")
    lines = cur.splitlines()
    i, j = lines.index(BEGIN), lines.index(END)
    line = next(l for l in lines[i + 1:j] if l.strip() and not l.startswith("#"))
    cmd = line.split(None, 5)[5]                  # 先頭の 5 つ（分 時 日 月 曜日）のあとが実行内容
    log = None
    m = re.search(r">> ('[^']*'|\S+)", cmd)
    if m:
        log = Path(shlex.split(m.group(1))[0])
    mark = HERE / ".cron-test-done"
    mark.unlink(missing_ok=True)
    at = datetime.now() + timedelta(minutes=2)
    at = at.replace(second=0, microsecond=0)
    # 実行の終わりと終了コードを印に書く
    tcmd = f"( {cmd} ); echo \"$?\" > {shlex.quote(str(mark))}"
    tblock = f"{TBEGIN}\n{at.minute} {at.hour} {at.day} {at.month} * {tcmd}\n{TEND}\n"
    write_crontab(drop_block(cur, TBEGIN, TEND) + tblock)
    start = log.stat().st_size if log and log.exists() else 0
    print(f"{at:%H:%M} に cron から 1 回実行します。終わるまで待っています（最長 {wait_max // 60} 分）…")
    try:
        t0 = time.time()
        while not mark.exists():
            if time.time() - t0 > wait_max + 150:
                print("時間内に終わりませんでした。cron が動いていないか、処理が長引いています")
                return 1
            time.sleep(5)
        code = mark.read_text().strip()
    finally:
        write_crontab(drop_block(read_crontab(), TBEGIN, TEND))   # テストの行は必ず消す
        mark.unlink(missing_ok=True)
    print(f"終了コード: {code}")
    if log and log.exists():
        with open(log, "rb") as f:
            f.seek(start)
            new = f.read().decode("utf-8", "replace").strip()
        print("--- このテストで書かれたログ ---")
        print(new or "（ログへの出力はありません。新しい本がなければ静かに終わります）")
    new = new if log and log.exists() else ""
    ok = code == "0" and "PermissionError" not in new and "許可がありません" not in new
    print("\n✓ cron から正常に動きました" if ok else
          "\n× うまく動きませんでした。上のログを確かめてください")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="書庫の夜間処理を launchd から cron に移す")
    ap.add_argument("--test", action="store_true", help="2 分後に 1 回だけ cron から実行して確かめる")
    ap.add_argument("--undo", action="store_true", help="launchd に戻す")
    ap.add_argument("--label", default=LABEL)
    ap.add_argument("--plist", help="launchd の設定ファイル（既定 ~/Library/LaunchAgents/<label>.plist）")
    a = ap.parse_args()
    plist = Path(a.plist) if a.plist else Path.home() / "Library/LaunchAgents" / f"{a.label}.plist"
    if a.undo:
        undo(plist, a.label)
    elif a.test:
        sys.exit(test(plist, a.label))
    else:
        install(plist, a.label)


if __name__ == "__main__":
    main()
