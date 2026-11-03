import { plainTextOf } from './markers.js'

export const STATUS_NEW = '新規'
export const STATUS_RETRY = '再取得'
export const STATUS_RUNNING = '処理中'
export const STATUS_DONE = '完了'
export const STATUS_SUMMARIZED = '要約済み'
export const STATUS_EXCLUDED = '除外'

/** 一覧に出す状態と、その表示順 */
export const STATUS_ORDER = [STATUS_NEW, STATUS_RUNNING, STATUS_DONE, STATUS_SUMMARIZED]

/** 「除外」を除く。除外はNotionのページは残したままの論理削除 */
export function excludeExcluded(items) {
  return items.filter((i) => i.status !== STATUS_EXCLUDED)
}

export function filterByStatus(items, selected) {
  if (!selected.size) return items
  return items.filter((i) => selected.has(i.status))
}

/** 取り込み元で絞る。source が無い古いJSONは動画として扱う */
export function filterBySource(items, selected) {
  if (!selected.size) return items
  return items.filter((i) => selected.has(sourceOf(i)))
}

export function sourceOf(item) {
  return item.source || 'video'
}

/** 取り込み元ごとの件数 */
export function sourceCounts(items) {
  const counts = new Map()
  items.forEach((i) => {
    const s = sourceOf(i)
    counts.set(s, (counts.get(s) || 0) + 1)
  })
  return counts
}

/** 選択タグをすべて含む(AND)ものだけ */
export function filterByTags(items, selected) {
  if (!selected.size) return items
  return items.filter((i) => {
    const tags = i.tags || []
    return [...selected].every((t) => tags.includes(t))
  })
}

/**
 * タイトルとサマリを対象にした検索。原文は含まない。
 * サマリにはマーカーのタグが混ざっているので、外してから照合する
 * (そうしないと "m1" のような文字列が誤ってヒットする)。
 */
export function filterBySearch(items, query) {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (i) => i.title.toLowerCase().includes(q) || plainTextOf(i.summary || '').toLowerCase().includes(q)
  )
}

/**
 * タグ候補を選択可否付きで組み立てる。
 * 「そのタグを追加選択したら0件になる」組み合わせは選べないようにする。
 */
export function buildTagOptions(baseItems, selectedTags) {
  const counts = new Map()
  baseItems.forEach((i) => (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)))

  return [...counts.keys()]
    .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'ja'))
    .map((tag) => {
      const selected = selectedTags.has(tag)
      const candidate = new Set(selectedTags)
      candidate.add(tag)
      return {
        tag,
        count: counts.get(tag),
        selected,
        disabled: !selected && filterByTags(baseItems, candidate).length === 0,
      }
    })
}

/** 状態ごとの件数。ヘッダーのチップに出す */
export function statusCounts(items) {
  const map = new Map(STATUS_ORDER.map((s) => [s, 0]))
  items.forEach((i) => map.set(i.status, (map.get(i.status) || 0) + 1))
  return map
}
