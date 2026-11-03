/**
 * AI生成のプロンプト。
 *
 * 既定値は data/clipstock/setting.json から読む。コードに埋め込まず
 * ファイルに出しているのは、文言を直すたびにJSを触らなくて済むようにするため。
 * 画面から編集した内容は localStorage に上書きとして持ち、setting.json より優先する
 * (既定に戻せば上書きは消える)。
 */

import { baseUrl } from './spaces.js'

const KEY = 'videos:prompts'
const SETTING_FILE = 'setting.json'

export const PROMPT_IDS = ['summary', 'mindmap', 'fields', 'apply', 'ideas', 'musicChapters', 'musicOverview']

let defaults = {}
let loading = null
let overrides = loadOverrides()

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides))
  } catch {
    // 容量超過。保存できなくてもこのセッションの編集内容は生きている
  }
}

/** setting.json を読む。失敗しても画面は動かす(生成しようとしたときに取り直す) */
export function initPrompts() {
  if (!loading) loading = load()
  return loading
}

async function load() {
  try {
    const res = await fetch(new URL(SETTING_FILE, baseUrl()), { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    defaults = json?.prompts || {}
  } catch (err) {
    console.error('setting.json を読み込めませんでした:', err)
    loading = null // 失敗は覚えない。次の生成で読み直せるようにする
  }
}

/** 生成の直前に呼ぶ。読み込み中なら待ち、前回失敗していれば取り直す */
export async function ensurePrompts() {
  if (Object.keys(defaults).length) return
  await initPrompts()
}

export function promptLabel(id) {
  return defaults[id]?.label || id
}

export function defaultPromptOf(id) {
  return defaults[id]?.system ?? ''
}

export function promptOf(id) {
  return typeof overrides[id] === 'string' ? overrides[id] : defaultPromptOf(id)
}

export function isCustomPrompt(id) {
  return typeof overrides[id] === 'string' && overrides[id] !== defaultPromptOf(id)
}

/** 既定と同じ内容なら上書きを持たない。setting.json を直したときに追従させるため */
export function savePrompt(id, text) {
  const value = String(text ?? '')
  if (!value.trim() || value === defaultPromptOf(id)) delete overrides[id]
  else overrides[id] = value
  persist()
}

export function resetPrompt(id) {
  delete overrides[id]
  persist()
}

/** JSONBin同期用。いまの上書き内容をまとめて返す */
export function exportPromptOverrides() {
  return { ...overrides }
}

/** JSONBin同期用。他端末の上書き内容をまとめて取り込む */
export function importPromptOverrides(obj) {
  if (!obj || typeof obj !== 'object') return
  overrides = { ...obj }
  persist()
}
