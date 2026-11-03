/**
 * JSONBinに置く設定(videos-config.js)を暗号化するための小物。
 *
 * パスフレーズから PBKDF2-SHA256 で鍵を作り、AES-256-GCM で包む。鍵そのものは
 * どこにも保存せず、復号できるのはパスフレーズを知っている人だけ。GAS URL・共有トークン・
 * AI接続のAPIキーなど、見られて困る値がBinにそのまま乗らないようにする。
 *
 * 形式は api/kanban/kanban.api.js と同じ考え方(AES-256-GCM/PBKDF2-SHA256)だが、
 * enc名を変えて独立させてある(他アプリの復号とは混ざらない)。
 */

const ENC = 'clipstock-config-aesgcm/v1'
const ITERATIONS = 250000

export function cryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle)
}

/** 渡された値が、この形式の暗号文(封筒)かどうか */
export function isEnvelope(x) {
  return !!x && typeof x === 'object' && x.enc === ENC && typeof x.ct === 'string'
}

function utf8(s) {
  return new TextEncoder().encode(s)
}

function b64e(bytes) {
  let s = ''
  bytes.forEach((b) => {
    s += String.fromCharCode(b)
  })
  return btoa(s)
}

function b64d(str) {
  const s = atob(String(str))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function deriveKey(passphrase, salt, iterations, usages) {
  if (!cryptoAvailable()) {
    throw new Error('この環境では暗号化を使えません(httpsかlocalhostで開いてください)')
  }
  const base = await crypto.subtle.importKey('raw', utf8(String(passphrase)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

/** 設定(プレーンなJSON)を暗号化して、Binに置ける封筒の形にする */
export async function encryptConfig(json, passphrase, iterations = ITERATIONS) {
  if (!passphrase) throw new Error('パスフレーズが設定されていません')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt, iterations, ['encrypt'])
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(ENC), tagLength: 128 },
    key,
    utf8(JSON.stringify(json))
  )
  return { enc: ENC, kdf: 'PBKDF2-SHA256', iterations, salt: b64e(salt), iv: b64e(iv), ct: b64e(new Uint8Array(ct)) }
}

/** 封筒を復号して元のJSON(オブジェクト)に戻す。パスフレーズ違い・改ざんは例外を投げる */
export async function decryptConfig(envelope, passphrase) {
  if (!isEnvelope(envelope)) throw new Error('暗号化の形式が違います')
  if (envelope.kdf !== 'PBKDF2-SHA256') throw new Error(`未対応の鍵導出です: ${envelope.kdf}`)
  if (!passphrase) throw new Error('パスフレーズを入力してください')
  const key = await deriveKey(passphrase, b64d(envelope.salt), Number(envelope.iterations) || ITERATIONS, ['decrypt'])
  let plain
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64d(envelope.iv), additionalData: utf8(ENC), tagLength: 128 },
      key,
      b64d(envelope.ct)
    )
  } catch {
    throw new Error('パスフレーズが違うか、データが壊れています')
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new Error('復号した中身がJSONではありません')
  }
}
