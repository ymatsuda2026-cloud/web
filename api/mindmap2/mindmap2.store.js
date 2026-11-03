/*!
 * mindmap2.store.js — マインドマップの保存まわりを引き受ける共通API
 *
 *   import * as Store from './mindmap2.store.js'
 *
 * 役割は3つだけ。
 *   1) 複数のマインドマップを1つの「ストア」として持つ
 *   2) ストアを JSONBin の1つのBinに読み書きする
 *   3) 必要ならパスフレーズで暗号化してから預ける
 *
 * 保存する中身は mindmap2.js と同じ Markdown 文字列のまま持つ。
 * 描画ライブラリを差し替えても、Binの中身がそのまま読めるようにするため。
 */

const API = 'https://api.jsonbin.io/v3'

const SETTINGS_KEY = 'mindmap2.settings.v1'
const CACHE_KEY = 'mindmap2.cache.v1'
const UI_KEY = 'mindmap2.ui.v1'
const PASS_KEY = 'mindmap2.pass.v1'

// ---------------------------------------------------------------- 設定

export function defaultSettings() {
  return {
    binId: '',
    keyType: 'master', // 'master' | 'access'
    apiKey: '',
    encrypt: false,
    rememberPass: false, // sessionStorage にだけ置く(タブを閉じると消える)
  }
}

export function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

/** タブの開き具合など、中身ではない見た目の状態 */
export function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}')
  } catch {
    return {}
  }
}

export function saveUiState(ui) {
  localStorage.setItem(UI_KEY, JSON.stringify(ui))
}

/** パスフレーズは sessionStorage にだけ置く。localStorage には絶対に書かない */
export function rememberedPass() {
  try {
    return sessionStorage.getItem(PASS_KEY) || ''
  } catch {
    return ''
  }
}

export function rememberPass(pass) {
  try {
    if (pass) sessionStorage.setItem(PASS_KEY, pass)
    else sessionStorage.removeItem(PASS_KEY)
  } catch {
    /* プライベートモードなどでは黙って諦める */
  }
}

// ---------------------------------------------------------------- ストア

export function emptyStore() {
  return { app: 'mindmap2', version: 1, rev: 0, updatedAt: null, docs: [] }
}

function uid() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** 外から来たJSONを、欠けている項目を補いながらストアの形に整える */
export function normalizeStore(value) {
  const base = emptyStore()
  if (!value || typeof value !== 'object') return base
  const docs = Array.isArray(value.docs) ? value.docs : []
  return {
    ...base,
    rev: Number(value.rev) || 0,
    updatedAt: value.updatedAt || null,
    docs: docs
      .filter((d) => d && typeof d === 'object')
      .map((d) => ({
        id: String(d.id || uid()),
        title: String(d.title || '無題'),
        markdown: String(d.markdown ?? ''),
        createdAt: d.createdAt || new Date().toISOString(),
        updatedAt: d.updatedAt || d.createdAt || new Date().toISOString(),
      })),
  }
}

export function newDoc(title = '新しいマップ') {
  const now = new Date().toISOString()
  return { id: uid(), title, markdown: `# ${title}`, createdAt: now, updatedAt: now }
}

export function duplicateDoc(doc) {
  const now = new Date().toISOString()
  const title = `${doc.title} のコピー`
  return {
    id: uid(),
    title,
    markdown: replaceFirstLabel(doc.markdown, title),
    createdAt: now,
    updatedAt: now,
  }
}

/** 一覧に出す名前。中心ノード(最初の非空行)をそのまま名前として扱う */
export function titleOf(markdown, fallback = '無題') {
  const line = String(markdown ?? '')
    .split('\n')
    .find((l) => l.trim())
  if (!line) return fallback
  const label = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?/, '').trim()
  return label || fallback
}

function replaceFirstLabel(markdown, label) {
  const lines = String(markdown ?? '').split('\n')
  const i = lines.findIndex((l) => l.trim())
  if (i < 0) return `# ${label}`
  const m = lines[i].match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?)/)
  lines[i] = (m ? m[1] : '') + label
  return lines.join('\n')
}

// ---------------------------------------------------------------- 暗号化
//
// パスフレーズから PBKDF2(SHA-256) で鍵を作り、AES-GCM で包む。
// 鍵そのものはどこにも保存しない。復号できるのはパスフレーズを知っている人だけ。
// rev と updatedAt だけは包みの外に出す。更新のぶつかりを、復号せずに見分けるため。

const te = new TextEncoder()
const td = new TextDecoder()
const ITERATIONS = 250000

export function cryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle)
}

function toB64(buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromB64(text) {
  const bin = atob(String(text || ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function deriveKey(pass, salt, iterations) {
  if (!cryptoAvailable()) {
    throw new Error('この環境では暗号化を使えません(https か localhost で開いてください)')
  }
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** ストアを暗号化して、Binに置ける形にする */
export async function seal(store, pass) {
  if (!pass) throw new Error('パスフレーズが設定されていません')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(pass, salt, ITERATIONS)
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(store)))
  return {
    app: 'mindmap2',
    enc: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    rev: store.rev,
    updatedAt: store.updatedAt,
    salt: toB64(salt),
    iv: toB64(iv),
    body: toB64(body),
  }
}

export function isSealed(record) {
  return Boolean(record && typeof record === 'object' && record.enc === 'AES-GCM' && record.body)
}

export async function unseal(record, pass) {
  if (!pass) throw new Error('パスフレーズが必要です')
  const key = await deriveKey(pass, fromB64(record.salt), Number(record.iterations) || ITERATIONS)
  let buf
  try {
    buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(record.iv) }, key, fromB64(record.body))
  } catch {
    throw new Error('パスフレーズが違うか、データが壊れています')
  }
  return normalizeStore(JSON.parse(td.decode(buf)))
}

/** 保存用の record(暗号化するかどうかはここで決まる) */
export async function toRecord(store, { encrypt, pass }) {
  return encrypt ? seal(store, pass) : { ...store, app: 'mindmap2' }
}

/** record を読める形に戻す。暗号化されていれば pass が要る */
export async function fromRecord(record, pass) {
  return isSealed(record) ? unseal(record, pass) : normalizeStore(record)
}

/** 復号せずに分かる版数。更新のぶつかりを見分けるのに使う */
export function revOf(record) {
  return Number(record?.rev) || 0
}

// ---------------------------------------------------------------- ローカル控え
//
// Binに届かないときでも中身が消えないように、書いた record をそのまま残す。
// 暗号化しているときは暗号化されたまま残るので、ローカルにも平文は出ない。

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeCache(record) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(record))
  } catch {
    /* 容量超過は諦める。Bin側が正 */
  }
}

// ---------------------------------------------------------------- JSONBin

export class Jsonbin {
  constructor(settings = {}) {
    this.binId = String(settings.binId || '').trim()
    this.apiKey = String(settings.apiKey || '').trim()
    this.keyType = settings.keyType === 'access' ? 'access' : 'master'
  }

  get configured() {
    return Boolean(this.binId && this.apiKey)
  }

  headers(extra) {
    const h = { 'Content-Type': 'application/json', ...extra }
    h[this.keyType === 'access' ? 'X-Access-Key' : 'X-Master-Key'] = this.apiKey
    return h
  }

  async request(url, init) {
    let res
    try {
      res = await fetch(url, init)
    } catch {
      throw new Error('JSONBinに接続できませんでした(通信状態を確認してください)')
    }
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* JSON以外が返ることもある */
    }
    if (!res.ok) {
      const message = json?.message || json?.error || text || `HTTP ${res.status}`
      throw new Error(`JSONBin: ${message}`)
    }
    return json
  }

  /** Binの中身をそのまま取り出す(X-Bin-Meta:false で包み紙を外す) */
  async read() {
    if (!this.configured) throw new Error('Bin IDとAPIキーが未設定です')
    return this.request(`${API}/b/${this.binId}/latest`, {
      method: 'GET',
      headers: this.headers({ 'X-Bin-Meta': 'false' }),
    })
  }

  async write(record) {
    if (!this.configured) throw new Error('Bin IDとAPIキーが未設定です')
    return this.request(`${API}/b/${this.binId}`, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(record),
    })
  }

  /** 新しいBinを作って、そのIDを返す。作成は Master Key でしかできない */
  async create(record, name = 'mindmap2') {
    if (!this.apiKey) throw new Error('APIキーが未設定です')
    if (this.keyType !== 'master') throw new Error('Binの作成には Master Key が必要です')
    const json = await this.request(`${API}/b`, {
      method: 'POST',
      headers: this.headers({ 'X-Bin-Name': name, 'X-Bin-Private': 'true' }),
      body: JSON.stringify(record),
    })
    const id = json?.metadata?.id
    if (!id) throw new Error('Binを作成できましたが、IDを取得できませんでした')
    return id
  }
}
