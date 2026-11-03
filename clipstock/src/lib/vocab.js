import { tagKey } from './tags.js'

/**
 * タグ語彙の集計。
 *
 * 統合候補の抽出にAIは使わない。「いつも一緒に付いている」は数えれば出るし、
 * 数えて出る答えを毎回LLMに聞くと、実行ごとに提案が変わって信用できなくなる。
 * AIに向くのは「どちらの語に寄せるか」の助言までで、判断は人が押す。
 */

/** これ以下の回数のタグは、絞り込みの役に立っていないと見なす */
export const TAIL_MAX = 2

/** 共起率がこれ以上なら統合候補として出す */
const CO_THRESHOLD = 0.6

/** 一度に出す統合候補の上限。多すぎると結局どれも判断されない */
const MAX_CANDIDATES = 12

/** @returns {{tag: string, count: number, tail: boolean}[]} 多い順 */
export function tagStats(items) {
  const counts = new Map()
  items.forEach((i) => (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)))
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([tag, count]) => ({ tag, count, tail: count <= TAIL_MAX }))
}

export function vocabSummary(items) {
  const stats = tagStats(items)
  return {
    videos: items.length,
    tags: stats.length,
    tailTags: stats.filter((s) => s.tail).length,
    untagged: items.filter((i) => !(i.tags || []).length).length,
  }
}

/** ペアを順序に依存しないキーにする。却下の記録に使う */
export function pairKey(a, b) {
  return [a, b].sort((x, y) => x.localeCompare(y, 'ja')).join('\u0000')
}

/**
 * 統合候補を出す。
 *
 * 「少ない方(from)が、多い方(to)といつも一緒に付いている」ものを候補にする。
 * from が単独で使われていないなら、それは別の観点ではなく言い換えの疑いが濃い。
 * 件数が同じ組は寄せる方向が決まらないので、綴りが同じ場合を除いて出さない。
 *
 * @returns {{from: string, to: string, fromCount: number, toCount: number,
 *            together: number, co: number, sameWord: boolean, key: string}[]}
 */
export function mergeCandidates(items, dismissed = new Set()) {
  const counts = new Map()
  const together = new Map()

  items.forEach((item) => {
    const tags = [...new Set(item.tags || [])]
    tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1))
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const k = pairKey(tags[i], tags[j])
        together.set(k, (together.get(k) || 0) + 1)
      }
    }
  })

  const out = []
  for (const [key, n] of together) {
    const [x, y] = key.split('\u0000')
    if (dismissed.has(key)) continue

    const cx = counts.get(x) || 0
    const cy = counts.get(y) || 0
    const sameWord = tagKey(x) === tagKey(y)

    // 少ない方を吸収される側にする
    let from = cx <= cy ? x : y
    let to = cx <= cy ? y : x
    if (cx === cy && !sameWord) continue

    const fromCount = Math.min(cx, cy)
    const toCount = Math.max(cx, cy)
    const co = fromCount ? n / fromCount : 0
    if (!sameWord && co < CO_THRESHOLD) continue

    out.push({ from, to, fromCount, toCount, together: n, co, sameWord, key })
  }

  // 1回しか使われていないタグは、同じ動画に付いた全タグと共起100%になる。
  // そのまま出すと同じ from の候補が並んで判断できないので、
  // from ごとに「最も有力な寄せ先」1つだけに絞る。
  const best = new Map()
  out.forEach((c) => {
    const cur = best.get(c.from)
    if (!cur || c.co > cur.co || (c.co === cur.co && c.toCount > cur.toCount)) best.set(c.from, c)
  })

  return [...best.values()]
    .sort(
      (a, b) =>
        Number(b.sameWord) - Number(a.sameWord) ||
        b.co - a.co ||
        a.fromCount - b.fromCount ||
        a.from.localeCompare(b.from, 'ja')
    )
    .slice(0, MAX_CANDIDATES)
}

// --- 却下の記録 ---
// 「別物として残す」は本人の判断なので、Notionにカラムを足さず端末に置く。
// 端末を変えると候補が再び出るが、無害な再確認なのでその代償は取る。

const DISMISS_KEY = 'videos:vocabDismissed'

export function loadDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

export function dismissPair(key) {
  const set = loadDismissed()
  set.add(key)
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...set]))
  } catch {
    // 無視
  }
  return set
}

export function clearDismissed() {
  localStorage.removeItem(DISMISS_KEY)
}
