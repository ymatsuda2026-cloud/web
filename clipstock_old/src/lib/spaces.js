import { loadConfig } from './videos-config.js'

/**
 * 表示対象(スペース)の切り替え。
 *
 * 「どの一覧JSONを読むか」と「どのNotionDBへ書き戻すか」は対になっているので、
 * spaces.json に取り込み元としてまとめて書き、その組み合わせに名前を付けたものを
 * スペースと呼ぶ。URLの ?space=<id> で選ぶ。
 *
 * 取り込み元を増やすときはコードではなく spaces.json を足す。
 * 画面をブックマークやリンクで配れるよう、選択は localStorage ではなくURLに置く。
 */

const PARAM = 'space'
const FILE = 'spaces.json'

// 既定は同じリポジトリの data/clipstock/。設定で別の場所を指せる
const DEFAULT_BASE = new URL('../../../data/clipstock/', import.meta.url).href

/** spaces.json が読めないときに使う、分割前からの取り込み元 */
const BUILTIN = {
  default: 'all',
  sources: {
    video: { label: '動画', list: 'index-video.json', idea: 'idea-video.json', db: 'video' },
    web: { label: 'Web', list: 'index-web.json', idea: 'idea-web.json', db: 'web' },
  },
  spaces: [
    { id: 'all', label: 'すべて', sources: ['video', 'web'] },
    { id: 'video', label: '動画', sources: ['video'] },
    { id: 'web', label: 'Web記事', sources: ['web'] },
  ],
}

export function baseUrl() {
  const raw = String(loadConfig().dataUrl || '').trim()
  if (!raw) return DEFAULT_BASE
  return new URL(raw.endsWith('/') ? raw : raw + '/', location.href).href
}

let config = BUILTIN
let active = BUILTIN.spaces[0]

/**
 * spaces.json を読んで、URLのパラメータから表示対象を決める。
 * 一覧を読む前に1度だけ呼ぶこと。
 */
export async function initSpaces() {
  try {
    const url = new URL(FILE, baseUrl())
    url.searchParams.set('t', Date.now())
    const res = await fetch(url, { cache: 'no-store' })
    if (res.ok) config = normalize(await res.json())
  } catch (err) {
    console.warn('spaces.json を読めないため既定の取り込み元を使います:', err)
  }
  const wanted = new URLSearchParams(location.search).get(PARAM)
  active = config.spaces.find((s) => s.id === wanted)
    || config.spaces.find((s) => s.id === config.default)
    || config.spaces[0]
  return active
}

/** 壊れた定義でも画面が出るように、使えるものだけ残す */
function normalize(raw) {
  const sources = raw?.sources && typeof raw.sources === 'object' ? raw.sources : BUILTIN.sources
  const spaces = (Array.isArray(raw?.spaces) ? raw.spaces : BUILTIN.spaces)
    .map((s) => ({
      id: String(s?.id ?? ''),
      label: String(s?.label ?? s?.id ?? ''),
      mode: String(s?.mode ?? ''),
      sources: (Array.isArray(s?.sources) ? s.sources : []).filter((id) => sources[id]),
    }))
    .filter((s) => s.id && s.sources.length)
  if (!spaces.length) return BUILTIN
  return { default: String(raw?.default ?? spaces[0].id), sources, spaces }
}

export function activeSpace() {
  return active
}

/**
 * URLを介さずに表示対象を切り替える。
 * ダッシュボードなど、?space= を持てない別ページから使う。
 * initSpaces() のあとに呼ぶこと。
 */
export function selectSpace(id) {
  const found = config.spaces.find((s) => s.id === id)
  if (found) active = found
  return active
}

/**
 * そのスペースの見せ方。
 * 既定('')は動画の要約向け。'music' は曲目リスト向けにタブと生成内容を差し替える。
 */
export function spaceMode(space = active) {
  return space?.mode || ''
}

export function spaceList() {
  return config.spaces
}

/** そのスペースが読む取り込み元。{id, label, list, idea, db} の配列 */
export function sourcesOf(space = active) {
  return (space?.sources || []).map((id) => ({ id, ...config.sources[id] }))
}

export function sourceIdsOf(space = active) {
  return space?.sources || []
}

/** GAS に伝える書き戻し先。未定義の取り込み元は動画DBとして扱う */
export function dbOf(sourceId) {
  return config.sources[sourceId]?.db || 'video'
}

/** いまのURLのパラメータだけ差し替えたURL。リンクやブックマークに使う */
export function spaceHref(id) {
  const url = new URL(location.href)
  url.searchParams.set(PARAM, id)
  return url.pathname + url.search
}
