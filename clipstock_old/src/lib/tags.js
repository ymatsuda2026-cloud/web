/**
 * タグの語彙を揃える。
 *
 * 生成は動画1本ずつ独立に走るので、プロンプトで既存タグを渡して縛っても
 * 「AI」「Ａｉ」「 AI 」「生成AI」のような表記ゆれは残る。
 * そこでモデルの出力をそのまま信じず、ここで既存タグへ寄せ直す。
 *
 * 寄せられるのは「書き方が違うだけの同じ語」だけ。意味が近いだけの語
 * (生成AI と LLM など)は別物として残す。意味の統合は人が判断すること。
 */

/** 比較用のキー。全角/半角・大小文字・区切り記号の差を吸収する */
export function tagKey(tag) {
  return String(tag ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・･\-_/｜|]/g, '')
    .trim()
}

/** タグとして受け付けない文字列(文になっているもの、長すぎるもの)を弾く */
function isUsable(tag) {
  const t = String(tag ?? '').trim()
  if (!t) return false
  if (t.length > 20) return false
  if (/[。、．,]/.test(t)) return false
  return true
}

/**
 * モデルが返したタグを既存の語彙に合わせて整える。
 *
 * @param {string[]} returned モデルの出力
 * @param {string[]} known 既存タグ(この綴りに寄せる)
 * @param {{maxNew?: number, max?: number}} [opts]
 *   maxNew: 新語として認める上限。既存語彙が空のときは max まで許す
 *   max: 最終的なタグ件数の上限
 * @returns {{tags: string[], reused: string[], created: string[], dropped: string[]}}
 */
export function reconcileTags(returned, known = [], opts = {}) {
  const max = opts.max ?? 6
  const maxNew = known.length ? (opts.maxNew ?? 1) : max

  // 既存タグは「キー -> 正式な綴り」の対応表にする。
  // 同じキーの既存タグが複数ある場合は、先に出てきた綴りを正とする。
  const canonical = new Map()
  known.forEach((k) => {
    const key = tagKey(k)
    if (key && !canonical.has(key)) canonical.set(key, k)
  })

  const tags = []
  const reused = []
  const created = []
  const dropped = []
  const seen = new Set()

  for (const raw of Array.isArray(returned) ? returned : []) {
    const trimmed = String(raw ?? '').trim()
    if (!isUsable(trimmed)) {
      if (trimmed) dropped.push(trimmed)
      continue
    }
    const key = tagKey(trimmed)
    if (!key || seen.has(key)) continue

    const hit = canonical.get(key)
    if (hit) {
      seen.add(key)
      tags.push(hit)
      reused.push(hit)
      continue
    }

    if (created.length >= maxNew || tags.length >= max) {
      dropped.push(trimmed)
      continue
    }
    seen.add(key)
    tags.push(trimmed)
    created.push(trimmed)
  }

  return { tags: tags.slice(0, max), reused, created, dropped }
}

/**
 * プロンプトに載せる語彙リストを作る。
 * 全件渡すとタグが増えるほどプロンプトが膨らむので、よく使われている順に絞る。
 * @param {{tags?: string[]}[]} items 一覧のアイテム
 */
export function knownTagsOf(items, limit = 60) {
  const counts = new Map()
  items.forEach((i) => (i.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)))
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .slice(0, limit)
    .map(([tag]) => tag)
}
