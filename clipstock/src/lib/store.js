import { listVideos as gasListVideos, listIdeas as gasListIdeas, registerPageSources } from './gas.js'
import { baseUrl, sourcesOf } from './spaces.js'

/**
 * 一覧・アイデア一覧の読み込み口。
 *
 * これまでは開くたびに GAS 経由で Notion を全件クエリしていて、件数が増えるほど
 * 最初の描画までが遅くなっていた。Mac 側の cron が書き出した静的JSONを先に読み、
 * 取れなかったときだけ従来どおり Notion に問い合わせる。
 * 詳細画面(タブごとの本文)は鮮度が要るので、これまでどおり Notion から取る。
 *
 * どのJSONを読むかは spaces.json で決まる(URLの ?space= で切り替わる)。
 * 取り込み元ごとにファイルが分かれているのは、元のNotionが別で更新も別々に走るため。
 * 片方が古くても・落ちても、もう片方はそのまま出せるようにしている。
 */

// 分割前は1本だけだった頃のファイル名。取り込み元を全部見るスペースでだけ使う
const LIST_LEGACY = 'index.json'
const IDEA_LEGACY = 'ideas.json'

async function fetchJson(name) {
  const url = new URL(name, baseUrl())
  // GitHub Pages / CDN のキャッシュに引っかかると更新が反映されないため毎回変える
  url.searchParams.set('t', Date.now())
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 取れなければ null。片方のファイルが無くても、もう片方だけで一覧を出すため */
async function fetchOptionalJson(name) {
  try {
    const json = await fetchJson(name)
    return Array.isArray(json.items) ? json : null
  } catch {
    return null
  }
}

/**
 * 取り込み元ごとのJSONを1つにまとめる。
 * 同じページが複数のファイルに出たら先勝ちで落とす。
 *
 * source はファイル側の値ではなく、読んだファイルの取り込み元IDで上書きする。
 * 分類ごとのファイルの中身は source:"video" のままなので、そのままだと
 * 絞り込みチップや書き戻し先の対応が取れなくなる。
 */
function mergeParts(parts) {
  const byKey = new Map()
  parts.forEach(({ json, source }) => {
    if (!json) return
    json.items.forEach((item) => {
      if (!item || !item.key || byKey.has(item.key)) return
      byKey.set(item.key, { ...item, source })
    })
  })
  return [...byKey.values()]
}

/** 分割後のファイルを読む。どれも無ければ分割前の1本を読む(無ければ例外) */
async function loadParts(pick, legacyName) {
  const files = sourcesOf().map((s) => ({ name: pick(s), source: s.id }))
  const parts = await Promise.all(
    files.map(async (f) => ({ ...f, json: f.name ? await fetchOptionalJson(f.name) : null }))
  )
  if (parts.some((p) => p.json)) {
    return { items: mergeParts(parts), generatedAt: (parts.find((p) => p.json).json || {}).generatedAt || null }
  }
  // 分割前の1本には全部入っている。分類は持っていないので、分類なしのスペースでだけ使える
  const plain = plainSources()
  if (!plain.length) throw new Error(`${legacyName} には分類ぶんが入っていません`)
  const legacy = await fetchJson(legacyName)
  if (!Array.isArray(legacy.items)) throw new Error(`${legacyName} の形式が不正です`)
  return { items: adoptByDb(legacy.items, plain), generatedAt: legacy.generatedAt || null }
}

/** 分類で絞っていない取り込み元。JSONが無いときの受け皿になれるのはこれだけ */
function plainSources() {
  return sourcesOf().filter((s) => !s.category)
}

/**
 * source が 'video' / 'web' しか入っていない一覧(分割前のJSON、GASの応答)を、
 * いまのスペースの取り込み元に割り当てる。受け皿が無いものは落とす。
 */
function adoptByDb(items, targets) {
  const byDb = new Map(targets.map((s) => [s.db || 'video', s.id]))
  return (items || []).flatMap((item) => {
    const id = byDb.get(item.source || 'video')
    return id ? [{ ...item, source: id }] : []
  })
}

/**
 * GASの応答をいまのスペースに割り当てる。
 * adoptByDb と違って分類も見るので、分類で絞るスペースでも使える。
 */
function adoptToSpace(items) {
  const targets = sourcesOf()
  return (items || []).flatMap((item) => {
    const db = item.source || 'video'
    const same = (s) => (s.db || 'video') === db
    const hit = targets.find((s) => same(s) && s.category && s.category === (item.category || ''))
      || targets.find((s) => same(s) && !s.category)
    return hit ? [{ ...item, source: hit.id }] : []
  })
}

/**
 * Notion から直接読む。静的JSONは cron の書き出し待ちで遅れるので、
 * 件数をその場で正しく知りたいときはこちらを使う。
 */
export async function listVideosFromNotion() {
  const data = await gasListVideos()
  const items = adoptToSpace(data.items)
  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  registerPageSources(items)
  return { ...data, items, source: 'notion' }
}

export async function listVideos() {
  try {
    const { items, generatedAt } = await loadParts((s) => s.list, LIST_LEGACY)
    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    registerPageSources(items)
    return { items, fetchedAt: generatedAt, source: 'json' }
  } catch (err) {
    console.warn('一覧JSONを使えないため Notion から直接読み込みます:', err)
    const data = await gasListVideos()
    // GASは分類を見ないので、分類で絞るスペースはJSONが無いと出せない
    const items = adoptByDb(data.items, plainSources())
    registerPageSources(items)
    return { ...data, items, source: 'notion' }
  }
}

export async function listIdeas() {
  try {
    const { items } = await loadParts((s) => s.idea, IDEA_LEGACY)
    registerPageSources(items)
    return { items, source: 'json' }
  } catch (err) {
    console.warn('アイデアJSONを使えないため Notion から直接読み込みます:', err)
    const data = await gasListIdeas()
    const items = adoptByDb(data.items, plainSources())
    registerPageSources(items)
    return { ...data, items, source: 'notion' }
  }
}
