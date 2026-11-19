// src/store.js — GitHub（読む）と GAS（書く・ログイン）
import { GAS_URL } from './config.js'

export async function gas(action, body = {}) {
  let r
  try {
    r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, ...body }), redirect: 'follow' })
  } catch {
    throw new Error('サーバーにつながりません。通信状態を確かめてください。')
  }
  if (!r.ok) throw new Error(`サーバーがエラーを返しました（${r.status}）`)
  const j = await r.json()
  if (!j.ok) throw new Error(j.error || 'サーバーがエラーを返しました')
  return j.data
}

/** 読み取り専用トークンで private リポジトリを読む */
export function repo(gh) {
  const base = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/`
  async function text(path) {
    const url = base + path.split('/').map(encodeURIComponent).join('/') + `?ref=${encodeURIComponent(gh.branch || 'main')}`
    let r
    try {
      r = await fetch(url, { cache: 'no-store', headers: { Authorization: 'Bearer ' + gh.token, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' } })
    } catch {
      throw new Error('GitHub につながりません。')
    }
    if (r.status === 404) return null
    if (r.status === 401 || r.status === 403) throw new Error('GitHub の読み取りトークンが使えません（管理者に連絡してください）')
    if (!r.ok) throw new Error(`GitHub の読み込みに失敗しました（${r.status}）`)
    return r.text()
  }
  return {
    text,
    async json(path) { const t = await text(path); return t == null ? null : JSON.parse(t) },
  }
}
