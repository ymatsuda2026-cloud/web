import { loadConfig } from './videos-config.js'
import { dbOf } from './spaces.js'

/**
 * ページIDごとの書き戻し先。
 * web記事DBは動画DBと別のNotion(統合も別のことがある)なので、
 * 書き戻すときにどちらのトークンを使うかをGAS側へ伝える必要がある。
 */
const pageSources = new Map()

/** 一覧を読み込んだら呼ぶ。以降そのページへの操作に source が付く */
export function registerPageSources(items) {
  ;(items || []).forEach((item) => {
    if (item && item.key) pageSources.set(item.key, dbOf(item.source || 'video'))
  })
}

/**
 * GAS の doPost を呼ぶ。
 * Content-Type は必ず text/plain にすること — application/json にすると
 * ブラウザが CORS preflight (OPTIONS) を送るが、GAS は OPTIONS に応答できず
 * 常に失敗する。
 */
async function callGas(action, params = {}) {
  const config = loadConfig()
  if (!config.gasUrl || !config.accessToken) {
    throw new Error('GAS の接続設定が未入力です')
  }

  const source = params.pageId ? pageSources.get(params.pageId) : null
  const body = JSON.stringify({ action, token: config.accessToken, ...params, ...(source ? { source } : {}) })

  const json = await enqueue(() => postWithRetry(config.gasUrl, body))
  if (!json.ok) throw new Error(json.error || 'GAS がエラーを返しました')
  if (REBUILD_ACTIONS.has(action)) scheduleRebuild(action)
  return json.data
}

/**
 * GAS へのリクエストは1本ずつ、しかも一定の間隔を空けて流す。
 * 立て続けに投げると Google 側がリダイレクト先(script.googleusercontent.com/macros/echo)を
 * 404 で返すことがあり、ブラウザからは CORS エラーとして見えてしまう。
 * 「すべて生成」は段ごとに保存するため短時間に何本も飛ぶので、ここで間引く。
 */
const MIN_INTERVAL_MS = 2500
let queueTail = Promise.resolve()
let lastSentAt = 0

function enqueue(task) {
  const run = queueTail.then(async () => {
    const wait = lastSentAt + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await task()
    } finally {
      lastSentAt = Date.now()
    }
  })
  queueTail = run.catch(() => {})
  return run
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(url, body) {
  // 毎回URLを変える。同じURLだと壊れたリダイレクト(302→/exec)を掴んだまま繰り返すことがある
  const target = url + (url.includes('?') ? '&' : '?') + 'r=' + Date.now().toString(36)
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GAS HTTP ${res.status}`)
  return res.json()
}

/**
 * 通信そのものが失敗したときだけやり直す。
 * GAS はリダイレクト先(script.googleusercontent.com/macros/echo)を気まぐれに 404 で返すことがあり、
 * Notion への保存は成功しているのに失敗表示になっていた。
 * 一時的なもので投げ直せばほぼ通るため、まず短く1回、それでも駄目なら間を空ける。
 * どの action も同じ値を書き直すだけなので、投げ直しても副作用は増えない。
 * Notion 由来のエラーは ok:false で返ってくるため、ここでは再送しない。
 */
async function postWithRetry(url, body) {
  const waits = [400, 1500, 4000, 10000, 20000]
  for (let i = 0; ; i++) {
    try {
      return await post(url, body)
    } catch (err) {
      if (i >= waits.length) {
        console.warn('[clipstock] GAS通信に失敗しました(再送しきりました)', err.message || err)
        throw err
      }
      console.debug(`[clipstock] GAS通信をやり直します (${i + 1}/${waits.length})`, err.message || err)
      await sleep(waits[i])
    }
  }
}

/** 一覧を Notion から直接取得する(index-video.json のような中間ファイルは使わない) */
export function listVideos() {
  return callGas('listVideos')
}

/** 応用・活用アイデアだけを全件取得する(アイデア一覧画面用) */
export function listIdeas() {
  return callGas('listIdeas')
}

/**
 * 取り込み元×分類ごとの、状態別件数だけを取る。
 * GAS がプロパティに持っている集計を読むだけなので、Notion の全件走査は起きない。
 * refresh=true のときだけ GAS 側で集計を作り直す(遅いので手動更新のときだけ)。
 */
export function statusCounts(refresh = false) {
  return callGas('statusCounts', { refresh })
}

/** @returns {Promise<{text: string, updatedAt: string}>} */
export function fetchTranscript(pageId) {
  return callGas('fetchTranscript', { pageId })
}

/** AI生成物・メモ・メタをまとめて取得 */
export function fetchDetail(pageId) {
  return callGas('fetchDetail', { pageId })
}

/**
 * AI生成物を保存する。detail に入れたキーだけが更新される。
 * キー: summary / mindmap / fields / apply / ideas / tags
 */
export function saveGenerated(pageId, detail, model, rawCount) {
  return callGas('saveGenerated', { pageId, detail, model, rawCount })
}

/** 人手編集の保存。要約日時・モデル・状態は変更されない */
export function saveField(pageId, field, value) {
  return callGas('saveField', { pageId, field, value })
}

export function saveMemo(pageId, memo) {
  return callGas('saveMemo', { pageId, memo })
}

export function saveTags(pageId, tags) {
  return callGas('saveTags', { pageId, tags })
}

/** タグを統合する。from が付いている全ページを to に置き換える */
export function mergeTag(from, to) {
  return callGas('mergeTag', { from, to })
}

export function saveTitle(pageId, title) {
  return callGas('saveTitle', { pageId, title })
}

/** 分類。空文字で外せる。一覧JSONの分かれ先が変わるので作り直しを依頼する */
export function saveCategory(pageId, category) {
  return callGas('saveCategory', { pageId, category })
}

/** 状態変更。'再取得' に戻すと次回バッチで文字起こしをやり直す。'除外' は論理削除 */
export function setStatus(pageId, status) {
  return callGas('setStatus', { pageId, status })
}

export function updateRawCount(pageId, count) {
  return callGas('updateRawCount', { pageId, count })
}

/** マインドマップ一覧に出すかどうか(Notionの「公開」チェックボックス) */
export function setPublic(pageId, isPublic) {
  return callGas('setPublic', { pageId, isPublic })
}

/** Notionページをゴミ箱へ移す。Notion側からなら30日間は復元できる */
export function deleteVideo(pageId) {
  return callGas('deleteVideo', { pageId })
}

/**
 * 一覧JSON(index-*.json / idea-*.json)の作り直しを Mac 側に依頼する。
 * GAS にフラグを置くだけで、実際の生成は Mac の常駐スクリプトが拾って行う。
 *
 * 失敗しても画面の操作自体は成功しているため、投げっぱなしにする。
 * 一括生成のように連続で呼ばれる場面があるので、少し待ってまとめて1回にする。
 */
const REBUILD_ACTIONS = new Set([
  'saveGenerated',
  'saveField',
  'saveTags',
  'saveTitle',
  'saveCategory',
  'setStatus',
  'setPublic',
  'updateRawCount',
  'mergeTag',
  'deleteVideo',
])

let rebuildTimer = null
const rebuildReasons = new Set()
let rebuildSentAt = 0

// 生成は1段ごとに保存するので、静かになるのを待つだけだと一括処理の合間に何度も飛ぶ。
// 「静かになってから送る」に加えて「一定時間に1回まで」でも絞る。
const REBUILD_DEBOUNCE_MS = 30000
const REBUILD_MIN_GAP_MS = 5 * 60 * 1000

function scheduleRebuild(reason) {
  rebuildReasons.add(String(reason || 'unknown'))
  if (rebuildTimer) return

  const wait = Math.max(REBUILD_DEBOUNCE_MS, rebuildSentAt + REBUILD_MIN_GAP_MS - Date.now())
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    sendRebuild()
  }, wait)
}

function sendRebuild() {
  rebuildSentAt = Date.now()
  const label = [...rebuildReasons].join(',')
  rebuildReasons.clear()
  return callGas('requestRebuild', { reason: label })
    .then(() => console.info('[clipstock] 一覧JSONの作り直しを依頼しました:', label))
    .catch((err) => console.warn('[clipstock] 作り直しの依頼に失敗:', err.message || err))
}

/** 間引きを飛ばしてすぐ依頼する。★の付け直しのように一覧の並びへ即反映したい操作用 */
export function requestRebuildNow(reason) {
  rebuildReasons.add(String(reason || 'rank'))
  if (rebuildTimer) {
    clearTimeout(rebuildTimer)
    rebuildTimer = null
  }
  return sendRebuild()
}

/** 権限コードを検証する。共有トークンは不要(初回はまだ手元に無いため) */
export async function verifyCode(gasUrl, code) {
  const body = JSON.stringify({ action: 'verifyCode', code })
  const json = await enqueue(() => postWithRetry(gasUrl, body))
  if (!json.ok) throw new Error(json.error || 'GAS がエラーを返しました')
  return json.data
}
