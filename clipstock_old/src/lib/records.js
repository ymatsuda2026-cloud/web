/**
 * 閲覧の記録。
 *
 * 「どれだけ見たか」は Notion に書き戻さない。既読やお気に入りと同じで、
 * 端末ごとの個人的な記録だからで、他の端末と混ぜると数が合わなくなる。
 *
 * 数えているのは「詳細を開いて画面が前面にある時間」。タブを裏に回したり、
 * 一覧に戻ったりしたら止まる。ping が途切れた分(閉じ忘れ・スリープ)は
 * IDLE_MS で頭打ちにして、寝ている間ぶんが入らないようにしている。
 *
 * 種別(取り込み元)ごとに分けて持つ。あとから「Webだけ」「otherだけ」を
 * 出せるようにするためで、集計のときに足し合わせる。
 */

const KEY = 'videos:records'
const KEEP_DAYS = 400
/** ping の間隔(main.js 側)より十分長く。これを超えた分は離席とみなして捨てる */
const IDLE_MS = 90_000

function emptyDb() {
  return { v: 1, days: {}, opens: {}, items: {}, done: {} }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    const db = emptyDb()
    for (const k of ['days', 'opens', 'items', 'done']) {
      if (raw[k] && typeof raw[k] === 'object') db[k] = raw[k]
    }
    return db
  } catch {
    return emptyDb()
  }
}

function save(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // 容量超過。記録が無くても本体は動くので黙って諦める
  }
}

/** ローカル時刻の YYYY-MM-DD。UTCで切ると日本時間の朝が前日に入る */
export function dayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function prune(db) {
  const limit = dayKey(new Date(Date.now() - KEEP_DAYS * 86400_000))
  for (const map of [db.days, db.opens]) {
    for (const k of Object.keys(map)) if (k < limit) delete map[k]
  }
}

export function sourceOfItem(item) {
  return item?.source || 'video'
}

// ---- 計測 ----

let session = null

/** 詳細を開いたときに呼ぶ。開いた件数もここで数える */
export function beginView(item) {
  if (!item?.key) return
  endView()
  session = { key: item.key, source: sourceOfItem(item), title: item.title || '', last: Date.now() }

  const db = load()
  const day = dayKey()
  const opens = (db.opens[day] ||= {})
  const list = (opens[session.source] ||= [])
  if (!list.includes(item.key)) list.push(item.key)

  const rec = (db.items[item.key] ||= { source: session.source, title: session.title, sec: 0, firstAt: null, lastAt: null })
  rec.source = session.source
  rec.title = session.title
  rec.firstAt ||= new Date().toISOString()
  rec.lastAt = new Date().toISOString()
  prune(db)
  save(db)
}

/** 開いている間、一定間隔で呼ぶ。経過したぶんを今日の記録に足す */
export function pingView() {
  if (!session) return
  const now = Date.now()
  const delta = Math.min(now - session.last, IDLE_MS)
  session.last = now
  if (delta < 1000) return

  const db = load()
  const day = dayKey()
  const byDay = (db.days[day] ||= {})
  byDay[session.source] = (byDay[session.source] || 0) + Math.round(delta / 1000)

  const rec = (db.items[session.key] ||= { source: session.source, title: session.title, sec: 0, firstAt: null, lastAt: null })
  rec.sec = (rec.sec || 0) + Math.round(delta / 1000)
  rec.lastAt = new Date().toISOString()
  save(db)
}

/** 詳細を閉じたときに呼ぶ */
export function endView() {
  if (!session) return
  pingView()
  session = null
}

// ---- 見終わった印 ----

export function isDone(key) {
  return Boolean(load().done[key])
}

/** @returns {boolean} 切り替え後の状態 */
export function toggleDone(item) {
  const db = load()
  const next = !db.done[item.key]
  if (next) db.done[item.key] = { source: sourceOfItem(item), title: item.title || '', at: new Date().toISOString() }
  else delete db.done[item.key]
  save(db)
  return next
}

// ---- 集計 ----

function inSources(source, sources) {
  return !sources || !sources.size || sources.has(source)
}

function sumDay(byDay, sources) {
  if (!byDay) return 0
  return Object.entries(byDay).reduce((n, [src, sec]) => (inSources(src, sources) ? n + sec : n), 0)
}

/**
 * 画面に出す数をまとめて作る。
 * @param {Set<string>|null} sources 絞り込む種別。空/未指定なら全部
 * @param {number} weeks ヒートマップの週数
 */
export function recordSummary(sources, { weeks = 20 } = {}) {
  const db = load()
  const today = new Date()
  const monthPrefix = dayKey(today).slice(0, 7)

  let monthSec = 0
  let totalSec = 0
  const bySource = new Map()
  for (const [day, byDay] of Object.entries(db.days)) {
    for (const [src, sec] of Object.entries(byDay)) {
      if (!inSources(src, sources)) continue
      totalSec += sec
      if (day.startsWith(monthPrefix)) {
        monthSec += sec
        bySource.set(src, (bySource.get(src) || 0) + sec)
      }
    }
  }

  const monthKeys = new Set()
  for (const [day, byDay] of Object.entries(db.opens)) {
    if (!day.startsWith(monthPrefix)) continue
    for (const [src, keys] of Object.entries(byDay)) {
      if (!inSources(src, sources)) continue
      keys.forEach((k) => monthKeys.add(k))
    }
  }

  // ヒートマップ。今週の土曜までを右端にして、週ごとの列を左へ並べる
  const end = new Date(today)
  end.setDate(end.getDate() + (6 - end.getDay()))
  const cells = []
  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 6; d >= 0; d--) {
      const date = new Date(end)
      date.setDate(date.getDate() - (w * 7 + d))
      const key = dayKey(date)
      cells.push({ date: key, sec: sumDay(db.days[key], sources), future: date > today })
    }
  }

  // 続けて見た日数。今日まだなら昨日から数える(その日のうちは途切れさせない)
  let streak = 0
  const cursor = new Date(today)
  if (!sumDay(db.days[dayKey(cursor)], sources)) cursor.setDate(cursor.getDate() - 1)
  while (sumDay(db.days[dayKey(cursor)], sources) > 0) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  const doneAll = Object.entries(db.done).filter(([, v]) => inSources(v.source, sources))
  const doneMonth = doneAll.filter(([, v]) => String(v.at || '').slice(0, 7) === monthPrefix)

  const recent = Object.entries(db.items)
    .filter(([, v]) => inSources(v.source, sources) && v.lastAt)
    .map(([key, v]) => ({ key, ...v, done: Boolean(db.done[key]) }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, 12)

  return {
    monthSec,
    totalSec,
    monthOpens: monthKeys.size,
    streak,
    doneMonth: doneMonth.length,
    doneAll: doneAll.length,
    cells,
    weeks,
    bySource: [...bySource.entries()].map(([source, sec]) => ({ source, sec })).sort((a, b) => b.sec - a.sec),
    recent,
    empty: totalSec === 0 && !recent.length,
  }
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (!h && !m) return s ? '1分未満' : '0分'
  return h ? `${h}時間${m}分` : `${m}分`
}

/** 開発・検証用。設定画面などから全部消したいとき */
export function clearRecords() {
  localStorage.removeItem(KEY)
  session = null
}
