// src/bio.js — Face ID・Touch ID（ClipStock と同じ作り。WebAuthn の PRF で権限コードを包んで、この端末にだけ置く）
import { b64, unb64, rnd } from './crypto.js'

const KEY = 'm2.bio'
const te = new TextEncoder()
const td = new TextDecoder()

export const bioOk = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext)
export const bioRegistered = () => !!localStorage.getItem(KEY)
export const bioForget = () => localStorage.removeItem(KEY)

const prfKey = (out) => crypto.subtle.importKey('raw', new Uint8Array(out).slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])

async function prfGet(idB64, salt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rnd(32), rpId: location.hostname, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: unb64(idB64) }],
    extensions: { prf: { eval: { first: salt } } }, timeout: 60000 } })
  const res = a.getClientExtensionResults()?.prf?.results?.first
  if (!res) throw new Error('この端末では Face ID・Touch ID で開けません。')
  return res
}

export async function bioRegister(code) {
  const salt = rnd(32)
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { name: '議事録', id: location.hostname },
    user: { id: rnd(16), name: 'minutes2', displayName: '議事録' },
    challenge: rnd(32),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    extensions: { prf: { eval: { first: salt } } }, timeout: 60000 } })
  const ext = cred.getClientExtensionResults()?.prf
  if (ext && ext.enabled === false) throw new Error('この端末では Face ID・Touch ID で開けません。')
  const id = b64(new Uint8Array(cred.rawId))
  const out = ext?.results?.first || await prfGet(id, salt)
  const iv = rnd(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await prfKey(out), te.encode(code)))
  localStorage.setItem(KEY, JSON.stringify({ id, salt: b64(salt), iv: b64(iv), ct: b64(ct) }))
}

/** → 権限コード */
export async function bioUnlock() {
  const v = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (!v) throw new Error('Face ID・Touch ID が登録されていません。')
  const out = await prfGet(v.id, unb64(v.salt))
  return td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, await prfKey(out), unb64(v.ct)))
}
