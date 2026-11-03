import { fetchBin, updateBin, createBin } from './jsonbin.js'
import { loadSettings, saveSettings } from './llm-settings.js'
import { exportPromptOverrides, importPromptOverrides } from './prompts.js'
import { encryptConfig, decryptConfig, isEnvelope } from './jsonbin-crypto.js'

const KEY = 'videos:config'
const PASS_KEY = 'videos:jsonbin-pass' // Binの中身を暗号化するパスフレーズ。configには含めない(この端末にだけ置く)

const DEFAULTS = {
  gasUrl: '',
  accessToken: '', // GASの ACCESS_TOKEN と一致させる共有トークン(Notionのシークレットではない)
  code: '', // 権限コード。GAS側スクリプトプロパティ "code" と照合する
  role: '', // 検証済みの権限。'xYz' は管理者、'err' は権限なし
  dataUrl: '', // 一覧JSONの置き場所。空なら同じリポジトリの data/clipstock/ を見る
  useJsonbin: false, // trueなら、この設定オブジェクト自体をJSONBinとも同期する(他端末と共有するため)
  jsonbinBinId: '', // jsonbin.io のBin ID
  jsonbinApiKey: '', // jsonbin.io のAPIキー(X-Master-Key)
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(c) {
  localStorage.setItem(KEY, JSON.stringify(c))
}

/** JSONBinへ同期しに行けるだけの情報が揃っているか */
export function jsonbinReady(c = loadConfig()) {
  return Boolean(c.useJsonbin && c.jsonbinBinId && c.jsonbinApiKey)
}

/** Binを暗号化するパスフレーズ。configには含めず、この端末のブラウザにだけ保存する */
export function loadJsonbinPassphrase() {
  try {
    return localStorage.getItem(PASS_KEY) || ''
  } catch {
    return ''
  }
}

export function saveJsonbinPassphrase(p) {
  try {
    if (p) localStorage.setItem(PASS_KEY, p)
    else localStorage.removeItem(PASS_KEY)
  } catch {
    // 保存できなくてもこのセッションの同期自体は続ける
  }
}

/**
 * アプリ起動時に呼ぶ。JSONBinを使う設定になっていれば、クラウド側の内容で
 * localStorageの設定を上書きしてから返す。使っていない/取得に失敗したときは
 * ローカルの設定をそのまま返す(オフラインでも今まで通り動かすため)。
 *
 * useJsonbin・jsonbinBinId・jsonbinApiKey はクラウドへ聞きに行くための鍵なので、
 * クラウド側の値では上書きしない(常にこの端末で入力したものを使う)。
 *
 * Binには config だけでなく、AI接続(llm-settings.js)とAIへの指示(prompts.jsの上書き)も
 * 並べて入れてあるので、そちらも合わせて取り込む。
 * 中身が暗号文(封筒)なら、この端末のパスフレーズで復号してから取り込む。
 */
export async function syncConfigFromJsonbin() {
  const local = loadConfig()
  if (!jsonbinReady(local)) return local
  try {
    return await pullFromJsonbin(local, loadJsonbinPassphrase())
  } catch (err) {
    console.warn('JSONBinから設定を取得できなかったため、この端末の設定を使います:', err)
    return local
  }
}

/** Binを読み、(暗号文なら復号して)中身を3つに分けて返す。この端末には何も書かない */
async function readRemote(c, passphrase) {
  let remote = await fetchBin(c.jsonbinBinId, c.jsonbinApiKey)
  if (isEnvelope(remote)) {
    if (!passphrase) throw new Error('JSONBinの中身は暗号化されています。パスフレーズを入力してください')
    remote = await decryptConfig(remote, passphrase)
  }
  const { llmSettings, promptOverrides, ...config } = remote || {}
  return { config, llmSettings, promptOverrides }
}

/** readRemote の中身をこの端末のlocalStorageへ取り込む */
function applyRemote(local, { config, llmSettings, promptOverrides }) {
  const merged = {
    ...local,
    ...config,
    useJsonbin: local.useJsonbin,
    jsonbinBinId: local.jsonbinBinId,
    jsonbinApiKey: local.jsonbinApiKey,
  }
  saveConfig(merged)
  if (llmSettings) saveSettings(llmSettings)
  if (promptOverrides) importPromptOverrides(promptOverrides)
  return merged
}

/** 起動時の同期(失敗してもローカルで続行)から使う。失敗したら例外を投げる */
async function pullFromJsonbin(local, passphrase) {
  return applyRemote(local, await readRemote(local, passphrase))
}

/** Binに置く中身。config に AI接続とAIへの指示を並べ、パスフレーズがあれば暗号化する */
async function buildBinBody(c) {
  const payload = {
    ...c,
    llmSettings: loadSettings(),
    promptOverrides: exportPromptOverrides(),
  }
  const passphrase = loadJsonbinPassphrase()
  return passphrase ? await encryptConfig(payload, passphrase) : payload
}

/**
 * 初回設定画面から使う。入力された GAS URL・共有トークンなどをJSONBinに保存し、
 * 以降の変更もJSONBinへ書く状態(useJsonbin)にする。
 *
 * - binId があれば、そのBinを先に読む(読めなければ何も書かずに例外)。Binに入っている設定を土台にして、
 *   入力欄が空でない項目(overrides)だけ上書きする。空欄の項目はBinの値がそのまま残る。
 * - binId が空なら、新しいBinを作ってそこへ保存し、そのIDを設定に入れる。
 *
 * @param {object} o
 * @param {string} o.binId 空なら新規作成
 * @param {string} o.apiKey
 * @param {string} o.passphrase
 * @param {object} o.overrides { gasUrl, accessToken, dataUrl, code, role }。空文字は「指定なし」
 * @param {() => void} [o.beforeSave] この端末へ書く直前に呼ぶ(AI接続の登録などに使う)
 * @returns {Promise<object>} 保存した設定
 */
export async function setupJsonbin({ binId, apiKey, passphrase, overrides = {}, beforeSave }) {
  let base = { ...loadConfig() }
  let remote = null
  if (binId) {
    remote = await readRemote({ jsonbinBinId: binId, jsonbinApiKey: apiKey }, passphrase)
  }
  const typed = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v))
  const config = {
    ...base,
    ...(remote?.config || {}),
    ...typed,
    useJsonbin: true,
    jsonbinBinId: binId,
    jsonbinApiKey: apiKey,
  }
  if (!config.gasUrl || !config.accessToken) {
    throw new Error('GAS URLと共有トークンを入力してください(Binにも入っていませんでした)')
  }

  // ここまで来たら書き込む。パスフレーズは buildBinBody が使うので先に置く
  saveJsonbinPassphrase(passphrase)
  if (remote?.llmSettings) saveSettings(remote.llmSettings)
  if (remote?.promptOverrides) importPromptOverrides(remote.promptOverrides)
  beforeSave?.()
  saveConfig(config)

  const body = await buildBinBody(config)
  if (binId) {
    await updateBin(binId, apiKey, body)
    return config
  }
  config.jsonbinBinId = await createBin(apiKey, body, { name: 'clipstock-config' })
  saveConfig(config) // 新しいBin IDを残す
  return config
}

/**
 * 設定を保存したときに呼ぶ。JSONBinを使う設定なら、いま保存した内容をクラウド側にも書き込む。
 * 使わない設定なら何もしない。失敗したときは例外を投げるので、呼び出し側で状況を伝えること
 * (この端末への保存はすでに済んでいるので、ここで失敗してもデータは失われない)。
 *
 * config に加えて llmSettings(AI接続)と promptOverrides(AIへの指示)もまとめて書き込む。
 * パスフレーズが設定されていれば暗号化して登録する。
 */
export async function pushConfigToJsonbin(c) {
  if (!jsonbinReady(c)) return
  await updateBin(c.jsonbinBinId, c.jsonbinApiKey, await buildBinBody(c))
}

export function isConfigured(c) {
  return Boolean(c.gasUrl && c.accessToken)
}

export const ADMIN_ROLE = 'xYz'

/** 全機能(生成・編集・状態変更)を使える管理者か */
export function isAdmin(c) {
  return c.role === ADMIN_ROLE
}

/** 権限が無い(未入力または未登録コード)か */
export function isDenied(c) {
  return !c.role || c.role === 'err'
}

/**
 * 生成・編集ができるか。
 * コードを使わない運用(個人で使う場合)でも触れるように、
 * 「明示的に弾かれたときだけ読み取り専用」にしている。
 */
export function canEdit(c) {
  return c.role !== 'err'
}
