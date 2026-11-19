#!/usr/bin/env python3
"""setup_keys.py — 権限コード・グループ鍵・鍵束の準備と入れ替え（管理者が Mac で実行する）

  python3 setup_keys.py token                           GAS の SETUP_TOKEN にする値を作る（最初に1回）
  python3 setup_keys.py init --roles jba,kijun,xYz      最初の1回。グループ鍵と権限コードを作る
  python3 setup_keys.py rotate --role jba               その role の権限コードを新しくする
  python3 setup_keys.py add-role --role eigyo           role を増やす（管理者の権限コードを聞きます）
  python3 setup_keys.py rebuild                         鍵束を作り直す（読み取りトークンを替えたとき。全 role のコードを聞きます）
  python3 setup_keys.py push                            GAS に共通の設定（GH_*・AUDIO_FOLDER_ID など）を登録し直す
  python3 setup_keys.py check                           GAS に登録済みのキーを確かめる（値は表示しません）

  オプション --ask   権限コードを自動で作らず、自分で入力する（16文字以上）

作るもの
  ~/.minutes2/keys.json   全グループの秘密鍵など（Mac の外に出さない。chmod 600）
  GitHub: pub.json        グループの公開鍵（暗号化に使う。秘密ではない）
  GitHub: index.json      空の一覧（無ければ）
  GAS スクリプトプロパティ  role ごとの鍵束（権限コードで暗号化）・コードのハッシュ・各種の秘密値
                          → GAS の setup に SETUP_TOKEN 付きで送って登録する（手で貼らない）
権限コードそのものは、どこにも保存しない（表示は一度だけ）。
"""
import argparse
import getpass
import hashlib
import hmac
import json
import secrets
import sys

import requests

from m2common import ENV, GitHub, load_keys, save_keys, KEYS_PATH
from m2crypto import new_group_key, seal_bundle

ADMIN_ROLE = "xYz"
CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # 見間違えやすい i l o 0 1 を除く


def gen_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(20))
    return "-".join(raw[i:i + 5] for i in range(0, 20, 5))  # 例: k3m9x-…（20文字＋区切り）


def ask_code(role: str) -> str:
    while True:
        c = getpass.getpass(f"  {role} の新しい権限コード（16文字以上）: ").strip()
        if len(c) >= 16 and c == getpass.getpass("  もう一度: ").strip():
            return c
        print("  16文字以上で、2回同じものを入れてください。")


def code_hash(pepper: str, code: str) -> str:
    return hmac.new(pepper.encode("utf-8"), code.strip().encode("utf-8"), hashlib.sha256).hexdigest()


def gh_info() -> dict:
    for k in ("GH_OWNER", "GH_REPO", "GH_READ_TOKEN"):
        if not ENV.get(k):
            sys.exit(f".env に {k} がありません")
    return {"owner": ENV["GH_OWNER"], "repo": ENV["GH_REPO"], "branch": ENV.get("GH_BRANCH", "main"), "token": ENV["GH_READ_TOKEN"]}


def bundle_for(keys: dict, role: str) -> dict:
    roles = keys["roles"]
    if role == ADMIN_ROLE:
        own = {r["gid"]: r["priv"] for r in roles.values()}
        return {"v": 1, "role": role, "keys": own, "gh": gh_info(), "roles": {name: r["gid"] for name, r in roles.items()}}
    r = roles[role]
    return {"v": 1, "role": role, "keys": {r["gid"]: r["priv"]}, "gh": gh_info()}


# ---------- GAS への登録 ----------

def gas_setup(set_props=None, delete=None, check=False) -> dict:
    url, token = ENV.get("GAS_URL"), ENV.get("GAS_SETUP_TOKEN")
    if not url or not token:
        sys.exit(".env に GAS_URL と GAS_SETUP_TOKEN を書いてください（GAS のスクリプトプロパティ SETUP_TOKEN と同じ値）")
    body = {"action": "setup", "token": token, "set": set_props or {}, "del": delete or []}
    r = requests.post(url, data=json.dumps(body), headers={"Content-Type": "text/plain;charset=utf-8"}, timeout=120, allow_redirects=True)
    r.raise_for_status()
    j = r.json()
    if not j.get("ok"):
        sys.exit("GAS への登録に失敗しました: " + str(j.get("error")))
    return j["data"]


def common_props(keys: dict) -> dict:
    """GAS に入れる共通の値（.env と keys.json から）"""
    need = ["GH_TOKEN", "GH_OWNER", "GH_REPO", "AUDIO_FOLDER_ID"]
    miss = [k for k in need if not ENV.get(k)]
    if miss:
        sys.exit(".env に " + ", ".join(miss) + " がありません")
    return {
        "CODE_PEPPER": keys["pepper"],
        "SESSION_SECRET": keys["session_secret"],
        "CODE_HASHES": json.dumps(keys["hashes"], separators=(",", ":")),
        "ROLE_GIDS": json.dumps({name: r["gid"] for name, r in keys["roles"].items()}, separators=(",", ":")),
        "GH_TOKEN": ENV["GH_TOKEN"], "GH_OWNER": ENV["GH_OWNER"], "GH_REPO": ENV["GH_REPO"],
        "GH_BRANCH": ENV.get("GH_BRANCH", "main"), "AUDIO_FOLDER_ID": ENV["AUDIO_FOLDER_ID"],
    }


def bundle_prop(code: str, keys: dict, role: str) -> dict:
    return {"BUNDLE_" + role: json.dumps(seal_bundle(code, bundle_for(keys, role)), separators=(",", ":"))}


def report(res: dict):
    print("GAS に登録しました:", ", ".join(res.get("set", [])) or "（なし）")
    if res.get("deleted"):
        print("GAS から消しました:", ", ".join(res["deleted"]))


def push_pub(keys: dict):
    gh = GitHub()
    gh.write("pub.json", json.dumps({r["gid"]: r["pub"] for r in keys["roles"].values()}, indent=1), "pub keys")
    text, _ = gh.get("index.json")
    if text is None:
        gh.put("index.json", "[]", None, "init index")


def print_codes(codes: dict):
    print("\n===== 権限コード（この画面でだけ表示します。各グループの人に安全な方法で渡してください）=====")
    for role, c in codes.items():
        print(f"  {role:10s} {c}")
    print("※ 権限コードは保存していません。忘れたら rotate で作り直します。")


def set_code(keys: dict, role: str, code: str):
    keys["hashes"] = {h: r for h, r in keys["hashes"].items() if r != role}
    keys["hashes"][code_hash(keys["pepper"], code)] = role


def cmd_init(a):
    if KEYS_PATH.exists():
        sys.exit(f"{KEYS_PATH} がもうあります。作り直すときは退避してから実行してください。")
    roles = [r.strip() for r in a.roles.split(",") if r.strip()]
    if ADMIN_ROLE not in roles:
        sys.exit(f"--roles に管理者 {ADMIN_ROLE} を含めてください")
    keys = {"pepper": secrets.token_hex(32), "session_secret": secrets.token_hex(32), "hashes": {}, "roles": {}}
    codes = {}
    for role in roles:
        priv, pub = new_group_key()
        keys["roles"][role] = {"gid": "g" + secrets.token_hex(5), "priv": priv, "pub": pub}
        codes[role] = ask_code(role) if a.ask else gen_code()
        set_code(keys, role, codes[role])
    props = common_props(keys)
    for role in roles:
        props.update(bundle_prop(codes[role], keys, role))
    save_keys(keys)
    push_pub(keys)
    report(gas_setup(props))
    print_codes(codes)


def cmd_rotate(a):
    keys = load_keys()
    role = a.role
    if role not in keys["roles"]:
        sys.exit(f"role {role} がありません")
    code = ask_code(role) if a.ask else gen_code()
    set_code(keys, role, code)
    props = {"CODE_HASHES": json.dumps(keys["hashes"], separators=(",", ":"))}
    props.update(bundle_prop(code, keys, role))
    report(gas_setup(props))  # この時点で古いコードは使えなくなる
    save_keys(keys)
    print_codes({role: code})


def check_code(keys: dict, role: str, label: str) -> str:
    code = getpass.getpass(f"{label}（{role}）の今の権限コード: ").strip()
    if keys["hashes"].get(code_hash(keys["pepper"], code)) != role:
        sys.exit("権限コードが違います")
    return code


def cmd_add_role(a):
    keys = load_keys()
    role = a.role
    if role in keys["roles"]:
        sys.exit(f"role {role} はもうあります")
    admin_code = check_code(keys, ADMIN_ROLE, "管理者")
    priv, pub = new_group_key()
    keys["roles"][role] = {"gid": "g" + secrets.token_hex(5), "priv": priv, "pub": pub}
    code = ask_code(role) if a.ask else gen_code()
    set_code(keys, role, code)
    props = {
        "CODE_HASHES": json.dumps(keys["hashes"], separators=(",", ":")),
        "ROLE_GIDS": json.dumps({name: r["gid"] for name, r in keys["roles"].items()}, separators=(",", ":")),
    }
    props.update(bundle_prop(code, keys, role))
    props.update(bundle_prop(admin_code, keys, ADMIN_ROLE))  # 管理者は新しいグループも開けるようにする
    save_keys(keys)
    push_pub(keys)
    report(gas_setup(props))
    print_codes({role: code})


def cmd_rebuild(a):
    keys = load_keys()
    props = {}
    for role in keys["roles"]:
        code = check_code(keys, role, "")
        props.update(bundle_prop(code, keys, role))
    report(gas_setup(props))
    print("鍵束を作り直しました。")


def cmd_token(a):
    t = secrets.token_hex(32)
    print("次の値を、GAS のスクリプトプロパティ SETUP_TOKEN と、~/.minutes2/.env の GAS_SETUP_TOKEN の両方に入れてください。")
    print(t)


def cmd_push(a):
    report(gas_setup(common_props(load_keys())))


def cmd_check(a):
    keys = load_keys()
    have = set(gas_setup(check=True).get("have", []))
    want = ["CODE_PEPPER", "CODE_HASHES", "ROLE_GIDS", "SESSION_SECRET", "GH_TOKEN", "GH_OWNER", "GH_REPO", "GH_BRANCH", "AUDIO_FOLDER_ID"]
    want += ["BUNDLE_" + r for r in keys["roles"]]
    for k in want:
        print(("  ok  " if k in have else "  なし ") + k)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init"); s.add_argument("--roles", required=True); s.add_argument("--ask", action="store_true")
    s = sub.add_parser("rotate"); s.add_argument("--role", required=True); s.add_argument("--ask", action="store_true")
    s = sub.add_parser("add-role"); s.add_argument("--role", required=True); s.add_argument("--ask", action="store_true")
    sub.add_parser("rebuild")
    sub.add_parser("push")
    sub.add_parser("token")
    sub.add_parser("check")
    a = p.parse_args()
    {"init": cmd_init, "rotate": cmd_rotate, "add-role": cmd_add_role, "rebuild": cmd_rebuild,
     "push": cmd_push, "check": cmd_check, "token": cmd_token}[a.cmd](a)


if __name__ == "__main__":
    main()
