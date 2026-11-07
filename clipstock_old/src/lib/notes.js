/**
 * ノート(引いたマーカーの集まり)。
 *
 * マーカーは本文の文字列に <m1>…</m1> として埋まっている(markers.js)。
 * そのため「ノート」という実体を別に持つ必要はなく、本文から拾い直せる。
 * 新しく表を作らずに拾う形にしたのは、本文を直したときにノート側が
 * 置いていかれて食い違う、という壊れ方を避けるため。
 *
 * 拾い先は2つ。
 *  - 一覧JSONの summary(開いたことが無い項目でも出せる)
 *  - 詳細キャッシュ(localStorage)の各タブ本文。開いた項目ぶんだけ
 *
 * ただし本文には「いつ引いたか」が入らない。期間で絞れるように、
 * 引いた時刻だけは別に控える(stampNotes)。控えが無い古いマーカーは
 * その項目の更新日時で代用する。
 */

import { getDetailCache } from './cache.js'
import { plainTextOf } from './markers.js'

const STAMP_KEY = 'videos:notes:at'

/** 拾う本文。idは詳細のフィールド名と同じ */
export const NOTE_FIELDS = [
  { id: 'summary', label: '要約' },
  { id: 'fields', label: '分野別' },
  { id: 'apply', label: '応用' },
  { id: 'ideas', label: 'アイデア' },
  { id: 'mindmap', label: 'マインドマップ' },
  { id: 'memo', label: 'メモ' },
]

/** マーカーの色の意味。色の値は markers.js の MARKER_COLORS と対になっている */
export const NOTE_KINDS = [
  { color: 1, label: '重要' },
  { color: 2, label: '使える' },
  { color: 3, label: '疑問' },
]

export function kindLabel(color) {
  return NOTE_KINDS.find((k) => k.color === color)?.label || 'その他'
}

/**
 * マーカーの範囲を、プレーンテキスト上の位置つきで取り出す。
 * 位置は「本文のどのあたりに線が集まっているか」を出すのに使う。
 */
export function runsOf(raw) {
  const s = String(raw ?? '')
  const re = /<m([123])>([\s\S]*?)<\/m\1>/g
  const runs = []
  let plain = 0
  let last = 0
  let m
  while ((m = re.exec(s))) {
    plain += m.index - last
    runs.push({ color: Number(m[1]), text: m[2], start: plain })
    plain += m[2].length
    last = re.lastIndex
  }
  return { runs, total: plain + (s.length - last) }
}

// ---- 引いた時刻の控え ----

function loadStamps() {
  try {
    return JSON.parse(localStorage.getItem(STAMP_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveStamps(map) {
  try {
    localStorage.setItem(STAMP_KEY, JSON.stringify(map))
  } catch {
    // 控えが無くても一覧は出る(更新日時で代用する)
  }
}

/** 本文とフィールドから、1本のマーカーを指す名前を作る */
export function noteId(key, field, text) {
  return `${key}|${field}|${text}`
}

/**
 * その本文のマーカーに、まだ控えが無いものだけ「いま」を入れる。
 * マーカーを保存した直後に呼ぶ。消したぶんの控えも落とす。
 */
export function stampNotes(key, field, raw) {
  const map = loadStamps()
  const now = new Date().toISOString()
  const prefix = `${key}|${field}|`
  const alive = new Set()
  runsOf(raw).runs.forEach((r) => {
    const id = noteId(key, field, r.text)
    alive.add(id)
    if (!map[id]) map[id] = now
  })
  for (const id of Object.keys(map)) {
    if (id.startsWith(prefix) && !alive.has(id)) delete map[id]
  }
  saveStamps(map)
}

// ---- 集める ----

/**
 * 画面に出すノートを組み立てる。
 * @param {Array} items 対象の項目(種別での絞り込みは呼ぶ側で済ませる)
 */
export function collectNotes(items) {
  const stamps = loadStamps()
  const notes = []
  const seen = new Set()
  let memoCount = 0

  items.forEach((item) => {
    const cache = getDetailCache(item.key) || {}
    if (plainTextOf(cache.memo || '').trim()) memoCount++

    NOTE_FIELDS.forEach((field) => {
      // summary は一覧JSONにも入っている。開いたことが無い項目でも拾えるよう両方見る
      const raw = field.id === 'summary' ? cache.summary || item.summary || '' : cache[field.id] || ''
      if (!raw) return
      const { runs, total } = runsOf(raw)
      runs.forEach((run) => {
        const text = run.text.trim()
        if (!text) return
        const id = noteId(item.key, field.id, run.text)
        if (seen.has(id)) return
        seen.add(id)
        notes.push({
          id,
          key: item.key,
          title: item.title || '',
          source: item.source || 'video',
          field: field.id,
          fieldLabel: field.label,
          color: run.color,
          text,
          at: stamps[id] || item.editedAt || item.createdAt || '',
          pos: total ? run.start / total : 0,
        })
      })
    })
  })

  notes.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return { notes, memoCount }
}

// ---- 絞り込み ----

export function filterNotes(notes, { colors, period, itemKey, query }) {
  const since = periodSince(period)
  const q = String(query || '').trim().toLowerCase()
  return notes.filter((n) => {
    if (colors?.size && !colors.has(n.color)) return false
    if (itemKey && n.key !== itemKey) return false
    if (since && !(n.at && new Date(n.at) >= since)) return false
    if (q && !n.text.toLowerCase().includes(q) && !n.title.toLowerCase().includes(q)) return false
    return true
  })
}

function periodSince(period) {
  const now = new Date()
  if (period === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - d.getDay())
    d.setHours(0, 0, 0, 0)
    return d
  }
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1)
  if (period === 'quarter') {
    const d = new Date(now)
    d.setMonth(d.getMonth() - 3)
    return d
  }
  return null
}

// ---- 集計 ----

export function noteStats(notes) {
  const byItem = new Map()
  const byColor = new Map()
  notes.forEach((n) => {
    const row = byItem.get(n.key) || { key: n.key, title: n.title, source: n.source, total: 0, colors: new Map() }
    row.total++
    row.colors.set(n.color, (row.colors.get(n.color) || 0) + 1)
    byItem.set(n.key, row)
    byColor.set(n.color, (byColor.get(n.color) || 0) + 1)
  })
  const top = [...byColor.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    total: notes.length,
    itemCount: byItem.size,
    byItem: [...byItem.values()].sort((a, b) => b.total - a.total),
    byColor,
    topColor: top ? top[0] : null,
  }
}

/** 種別ごとの件数。種別チップに出す */
export function noteSourceCounts(notes) {
  const counts = new Map()
  notes.forEach((n) => counts.set(n.source, (counts.get(n.source) || 0) + 1))
  return counts
}

/** 絞り込んだぶんの書き出し。項目ごとにまとめる */
export function notesMarkdown(notes) {
  const groups = new Map()
  notes.forEach((n) => {
    if (!groups.has(n.key)) groups.set(n.key, { title: n.title, rows: [] })
    groups.get(n.key).rows.push(n)
  })
  const out = []
  for (const { title, rows } of groups.values()) {
    out.push(`## ${title}`)
    rows.forEach((n) => out.push(`- [${kindLabel(n.color)}/${n.fieldLabel}] ${n.text.replace(/\n+/g, ' ')}`))
    out.push('')
  }
  return out.join('\n').trim()
}
