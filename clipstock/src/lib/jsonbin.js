/**
 * JSONBin.io (https://jsonbin.io) との連携。
 *
 * clipstockの設定(videos-config.js)は基本この端末のlocalStorageだけに閉じているが、
 * 複数端末・複数ブラウザで同じ設定を使いたいときのために、外部のJSON保管先として
 * JSONBinを選べるようにする。Bin ID・APIキー(X-Master-Key)は各自のJSONBinアカウントで
 * 発行したものを設定画面にそのまま入力してもらう想定で、このファイルはAPI呼び出しだけを担う。
 */

const API_BASE = 'https://api.jsonbin.io/v3/b'

/**
 * 新しいBinを作り、中身をdataにする。
 * @returns {Promise<string>} 作成されたBinのID
 */
export async function createBin(apiKey, data, { name } = {}) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': apiKey,
      ...(name ? { 'X-Bin-Name': name } : {}),
    },
    body: JSON.stringify(data ?? {}),
  })
  if (!res.ok) throw new Error(`JSONBinの作成に失敗しました (HTTP ${res.status})`)
  const json = await res.json()
  const id = json?.metadata?.id
  if (!id) throw new Error('JSONBinの作成応答にBin IDが含まれていません')
  return id
}

/** Binの中身(最新バージョン)を取得する */
export async function fetchBin(binId, apiKey) {
  if (!binId || !apiKey) throw new Error('Bin IDとAPIキーの両方が必要です')
  const res = await fetch(`${API_BASE}/${encodeURIComponent(binId)}/latest`, {
    headers: {
      'X-Master-Key': apiKey,
      'X-Bin-Meta': 'false',
    },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`JSONBinの取得に失敗しました (HTTP ${res.status})`)
  return res.json()
}

/** Binの中身を丸ごと書き換える(新しいバージョンとして保存される) */
export async function updateBin(binId, apiKey, data) {
  if (!binId || !apiKey) throw new Error('Bin IDとAPIキーの両方が必要です')
  const res = await fetch(`${API_BASE}/${encodeURIComponent(binId)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': apiKey,
    },
    body: JSON.stringify(data ?? {}),
  })
  if (!res.ok) throw new Error(`JSONBinへの保存に失敗しました (HTTP ${res.status})`)
  return res.json()
}
