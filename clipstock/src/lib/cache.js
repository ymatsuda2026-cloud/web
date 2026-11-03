const DETAIL_PREFIX = 'videos:detail:'
const SEEN_KEY = 'videos:seen'

/** @returns {object|null} fetchDetail の結果に cachedAt を足したもの */
export function getDetailCache(pageId) {
  try {
    const raw = localStorage.getItem(DETAIL_PREFIX + pageId)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setDetailCache(pageId, data) {
  const record = { ...data, cachedAt: new Date().toISOString() }
  try {
    localStorage.setItem(DETAIL_PREFIX + pageId, JSON.stringify(record))
  } catch {
    // 容量超過。キャッシュは無くても動くので黙って諦める
  }
  return record
}

export function clearDetailCache(pageId) {
  localStorage.removeItem(DETAIL_PREFIX + pageId)
}

/**
 * キャッシュが Notion 側の更新より新しければ再利用できる。
 * 比較基準は last_edited_time(updatedAt)。要約日時では手編集を検知できない。
 */
export function isCacheFresh(cache, remoteUpdatedAt) {
  if (!cache || !remoteUpdatedAt || !cache.updatedAt) return false
  return new Date(cache.updatedAt).getTime() >= new Date(remoteUpdatedAt).getTime()
}

// --- 既読の記録 ---
// 「溜めたものを掘り起こす」導線で、まだ目を通していない動画を優先して
// 出すために使う。Notionには書き戻さない(端末ごとの読書履歴のため)。

function loadSeenMap() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}')
  } catch {
    return {}
  }
}

export function markSeen(pageId) {
  const map = loadSeenMap()
  map[pageId] = new Date().toISOString()
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map))
  } catch {
    // 無視
  }
}

export function seenAt(pageId) {
  return loadSeenMap()[pageId] || null
}

export function isSeen(pageId) {
  return Boolean(loadSeenMap()[pageId])
}

// --- お気に入り ---
// 端末ごとの個人的な印付け。既読と同じ理由でNotionには書き戻さない。

const FAVORITE_KEY = 'videos:favorites'

function loadFavoriteMap() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITE_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveFavoriteMap(map) {
  try {
    localStorage.setItem(FAVORITE_KEY, JSON.stringify(map))
  } catch {
    // 容量超過などは黙って諦める。お気に入りが無くても動く
  }
}

export function isFavorite(pageId) {
  return Boolean(loadFavoriteMap()[pageId])
}

/** @returns {boolean} 切り替え後の状態 */
export function toggleFavorite(pageId) {
  const map = loadFavoriteMap()
  const next = !map[pageId]
  if (next) map[pageId] = new Date().toISOString()
  else delete map[pageId]
  saveFavoriteMap(map)
  return next
}
