#!/usr/bin/env python3
"""setup_keys.py — 権限コード・グループ鍵・鍵束の準備と入れ替え（管理者が Mac で実行する）

  python3 setup_keys.py init --roles jba,kijun,xYz      最初の1回。グループ鍵と権限コードを作る
  python3 setup_keys.py rotate --role jba               その role の権限コードを新しくする
  python3 setup_keys.py add-role --role eigyo           role を増やす（管理者の権限コードを聞きます）
  python3 setup_keys.py rebuild                         鍵束を作り直す（読み取りトークンを替えたとき。全 role のコードを聞きます）
  python3 setup_keys.py props                           GAS のスクリプトプロパティに入れる値を表示する

  オプション --ask   権限コードを自動で作らず、自分で入力する（16文字以上）

作るもの
  ~/.minutes2/keys.json   全グループの秘密鍵など（Mac の外に出さない。chmod 600）
  GitHub: pub.json        グループの公開鍵（暗号化に使う。秘密ではない）
  GitHub: index.json      空の一覧（無ければ）
  jsonbin                 role ごとの鍵束（権限コードで暗号化）
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


# ---------- jsonbin ----------

def jb_headers():
    if not ENV.get("JSONBIN_KEY"):
        sys.exit(".env に JSONBIN_KEY がありません")
    return {"X-Master-Key": ENV["JSONBIN_KEY"], "Content-Type": "application/json"}


def jb_read(bin_id: str) -> dict:
    r = requests.get(f"https://api.jsonbin.io/v3/b/{bin_id}/latest", headers={**jb_headers(), "X-Bin-Meta": "false"}, timeout=60)
    r.raise_for_status()
    return r.json().get("bundles", {})


def jb_write(keys: dict, bundles: dict):
    data = {"bundles": bundles}
    bin_id = keys.get("jsonbin_bin_id") or ENV.get("JSONBIN_BIN_ID")
    if bin_id:
        r = requests.put(f"https://api.jsonbin.io/v3/b/{bin_id}", headers=jb_headers(), json=data, timeout=60)
        r.raise_for_status()
    else:
        r = requests.post("https://api.jsonbin.io/v3/b", headers={**jb_headers(), "X-Bin-Private": "true", "X-Bin-Name": "minutes2-bundles"}, json=data, timeout=60)
        r.raise_for_status()
        bin_id = r.json()["metadata"]["id"]
    keys["jsonbin_bin_id"] = bin_id


def push_pub(keys: dict):
    gh = GitHub()
    gh.write("pub.json", json.dumps({r["gid"]: r["pub"] for r in keys["roles"].values()}, indent=1), "pub keys")
    text, _ = gh.get("index.json")
    if text is None:
        gh.put("index.json", "[]", None, "init index")


def print_props(keys: dict):
    gids = {name: r["gid"] for name, r in keys["roles"].items()}
    print("\n===== GAS のスクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）=====")
    print("CODE_PEPPER     =", keys["pepper"])
    print("CODE_HASHES     =", json.dumps(keys["hashes"], separators=(",", ":")))
    print("ROLE_GIDS       =", json.dumps(gids, separators=(",", ":")))
    print("SESSION_SECRET  =", keys["session_secret"])
    print("JSONBIN_BIN_ID  =", keys.get("jsonbin_bin_id", "（未作成）"))
    print("ほかに JSONBIN_KEY / GH_TOKEN（書き込み用）/ GH_OWNER / GH_REPO / GH_BRANCH / AUDIO_FOLDER_ID も入れてください。")


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
    bundles = {role: seal_bundle(codes[role], bundle_for(keys, role)) for role in roles}
    save_keys(keys)
    push_pub(keys)
    jb_write(keys, bundles)
    save_keys(keys)
    print_props(keys)
    print_codes(codes)


def cmd_rotate(a):
    keys = load_keys()
    role = a.role
    if role not in keys["roles"]:
        sys.exit(f"role {role} がありません")
    code = ask_code(role) if a.ask else gen_code()
    set_code(keys, role, code)
    bundles = jb_read(keys["jsonbin_bin_id"])
    bundles[role] = seal_bundle(code, bundle_for(keys, role))
    jb_write(keys, bundles)
    save_keys(keys)
    print("\nGAS の CODE_HASHES を次の値に替えてください（古いコードはその時点で使えなくなります）。")
    print("CODE_HASHES =", json.dumps(keys["hashes"], separators=(",", ":")))
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
    bundles = jb_read(keys["jsonbin_bin_id"])
    bundles[role] = seal_bundle(code, bundle_for(keys, role))
    bundles[ADMIN_ROLE] = seal_bundle(admin_code, bundle_for(keys, ADMIN_ROLE))  # 管理者は新しいグループも開けるようにする
    save_keys(keys)
    push_pub(keys)
    jb_write(keys, bundles)
    save_keys(keys)
    print("\nGAS の CODE_HASHES と ROLE_GIDS を替えてください。")
    print_props(keys)
    print_codes({role: code})


def cmd_rebuild(a):
    keys = load_keys()
    bundles = {}
    for role in keys["roles"]:
        code = check_code(keys, role, "")
        bundles[role] = seal_bundle(code, bundle_for(keys, role))
    jb_write(keys, bundles)
    save_keys(keys)
    print("鍵束を作り直しました。")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("init"); s.add_argument("--roles", required=True); s.add_argument("--ask", action="store_true")
    s = sub.add_parser("rotate"); s.add_argument("--role", required=True); s.add_argument("--ask", action="store_true")
    s = sub.add_parser("add-role"); s.add_argument("--role", required=True); s.add_argument("--ask", action="store_true")
    sub.add_parser("rebuild")
    sub.add_parser("props")
    a = p.parse_args()
    {"init": cmd_init, "rotate": cmd_rotate, "add-role": cmd_add_role, "rebuild": cmd_rebuild,
     "props": lambda _a: print_props(load_keys())}[a.cmd](a)


if __name__ == "__main__":
    main()
