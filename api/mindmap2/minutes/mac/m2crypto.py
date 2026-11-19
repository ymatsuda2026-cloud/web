"""m2crypto.py — 議事録の暗号化（Mac 側）

web/src/crypto.js と同じ形式。片方を変えたら必ず両方そろえる。
  ・会議ごとの鍵（DEK, 32 バイト）で JSON を AES-GCM 暗号化 → {"iv", "ct"}（base64）
  ・DEK はグループ公開鍵（ECDH P-256）で包む → {"e", "iv", "ct"}
      使い捨て鍵ペア × グループ公開鍵で ECDH → HKDF-SHA256（salt=0x00*32, info=b"minutes2-wrap"）→ AES-GCM
  ・鍵束は権限コードから PBKDF2-SHA256（600,000 回）で作った鍵で AES-GCM 暗号化 → {"salt", "iv", "ct"}
"""
import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PBKDF2_ITER = 600_000
WRAP_INFO = b"minutes2-wrap"
ZERO32 = b"\x00" * 32


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def unb64(s: str) -> bytes:
    return base64.b64decode(s)


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _unb64url(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# ---------- 会議の中身 ----------

def new_dek() -> bytes:
    return os.urandom(32)


def seal_json(dek: bytes, obj) -> dict:
    iv = os.urandom(12)
    ct = AESGCM(dek).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode("utf-8"), None)
    return {"iv": b64(iv), "ct": b64(ct)}


def open_json(dek: bytes, v: dict):
    pt = AESGCM(dek).decrypt(unb64(v["iv"]), unb64(v["ct"]), None)
    return json.loads(pt.decode("utf-8"))


# ---------- グループ鍵 ----------

def new_group_key():
    """→ (秘密鍵 JWK dict, 公開鍵 raw の base64)"""
    priv = ec.generate_private_key(ec.SECP256R1())
    return priv_to_jwk(priv), pub_raw_b64(priv.public_key())


def priv_to_jwk(priv) -> dict:
    n = priv.private_numbers()
    return {
        "kty": "EC", "crv": "P-256",
        "d": _b64url(n.private_value.to_bytes(32, "big")),
        "x": _b64url(n.public_numbers.x.to_bytes(32, "big")),
        "y": _b64url(n.public_numbers.y.to_bytes(32, "big")),
    }


def jwk_to_priv(jwk: dict):
    return ec.derive_private_key(int.from_bytes(_unb64url(jwk["d"]), "big"), ec.SECP256R1())


def pub_raw_b64(pub) -> str:
    return b64(pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def _pub_from_b64(s: str):
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(s))


def _kek(priv, pub) -> bytes:
    shared = priv.exchange(ec.ECDH(), pub)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=ZERO32, info=WRAP_INFO).derive(shared)


def wrap_dek(dek: bytes, group_pub_b64: str) -> dict:
    eph = ec.generate_private_key(ec.SECP256R1())
    k = _kek(eph, _pub_from_b64(group_pub_b64))
    iv = os.urandom(12)
    return {"e": pub_raw_b64(eph.public_key()), "iv": b64(iv), "ct": b64(AESGCM(k).encrypt(iv, dek, None))}


def unwrap_dek(w: dict, priv) -> bytes:
    k = _kek(priv, _pub_from_b64(w["e"]))
    return AESGCM(k).decrypt(unb64(w["iv"]), unb64(w["ct"]), None)


# ---------- 鍵束 ----------

def seal_bundle(code: str, obj: dict) -> dict:
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha256", code.strip().encode("utf-8"), salt, PBKDF2_ITER, 32)
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode("utf-8"), None)
    return {"salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def open_bundle(code: str, sealed: dict) -> dict:
    key = hashlib.pbkdf2_hmac("sha256", code.strip().encode("utf-8"), unb64(sealed["salt"]), PBKDF2_ITER, 32)
    return json.loads(AESGCM(key).decrypt(unb64(sealed["iv"]), unb64(sealed["ct"]), None).decode("utf-8"))
