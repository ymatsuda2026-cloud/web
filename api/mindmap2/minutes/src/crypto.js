// src/crypto.js — 議事録の暗号化（ブラウザ側）
//
// しくみ（Mac 側の mac/m2crypto.py と同じ形式。片方を変えたら必ず両方そろえる）
//   ・会議ごとに 32 バイトの鍵（DEK）を作り、タイトル・文字起こし・要約・メモを AES-GCM で暗号化する
//   ・DEK は「閲覧グループの公開鍵（ECDH P-256）」で包んで index.json の k に並べる
//       包み方: 使い捨て鍵ペア × グループ公開鍵 で ECDH → HKDF-SHA256（salt=0×32, info="minutes2-wrap"）→ AES-GCM
//   ・グループの秘密鍵は jsonbin の「鍵束」に入っていて、鍵束は権限コードから PBKDF2 で作った鍵で暗号化してある
const te = new TextEncoder()
const td = new TextDecoder()
const subtle = globalThis.crypto.subtle

export const b64 = (u8) => {
  const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)
  let s = ''
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000))
  return btoa(s)
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

const ZERO32 = new Uint8Array(32)
const WRAP_INFO = te.encode('minutes2-wrap')
const CURVE = { name: 'ECDH', namedCurve: 'P-256' }
export const PBKDF2_ITER = 600000

/** 権限コード → 鍵束を開く鍵 */
export async function codeKey(code, salt) {
  const base = await subtle.importKey('raw', te.encode(String(code).trim()), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** jsonbin から GAS 経由で届いた鍵束 {salt, iv, ct} を権限コードで開く */
export async function openBundle(code, sealed) {
  const key = await codeKey(code, unb64(sealed.salt))
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, key, unb64(sealed.ct))
  return JSON.parse(td.decode(pt))
}

const aesKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

export const newDek = () => rnd(32)

/** DEK で JSON を暗号化 → {iv, ct}（どちらも base64） */
export async function sealJson(dek, obj) {
  const iv = rnd(12)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(dek), te.encode(JSON.stringify(obj)))
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

export async function openJson(dek, v) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, await aesKey(dek), unb64(v.ct))
  return JSON.parse(td.decode(pt))
}

/** 鍵束の秘密鍵（JWK）を読み込む */
export const importPriv = (jwk) =>
  subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, CURVE, false, ['deriveBits'])

/** pub.json の公開鍵（非圧縮 65 バイトの base64） */
export const importPub = (rawB64) => subtle.importKey('raw', unb64(rawB64), CURVE, true, [])

async function kek(priv, pub) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ZERO32, info: WRAP_INFO }, hk,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** DEK をグループの公開鍵で包む → {e, iv, ct} */
export async function wrapDek(dek, groupPubB64) {
  const eph = await subtle.generateKey(CURVE, true, ['deriveBits'])
  const k = await kek(eph.privateKey, await importPub(groupPubB64))
  const iv = rnd(12)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, dek)
  const e = await subtle.exportKey('raw', eph.publicKey)
  return { e: b64(new Uint8Array(e)), iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

/** 自分のグループ秘密鍵（CryptoKey）で DEK を取り出す */
export async function unwrapDek(w, priv) {
  const k = await kek(priv, await importPub(w.e))
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.ct)))
}
