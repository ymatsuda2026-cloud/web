// マーカーは <m1>text</m1> のように文字列内へ直接埋め込んで保存する。
// 位置指定の座標情報を別途持たない設計にしたのは、サマリ本文が編集される
// たびに座標がずれて壊れる問題を避けるため。文字列そのものに埋め込めば、
// Notionのプロパティ1つに収まり、他のフィールドと同じ仕組みで保存できる。

export const MARKER_COLORS = {
  1: '#FAC775', // 黄系
  2: '#9FE1CB', // 緑系
  3: '#F4C0D1', // ピンク系
}

/** raw文字列を「1文字ごとにマーカー番号を持つ配列」に展開する */
function parseToFlat(raw) {
  const flat = []
  const re = /<m([123])>([\s\S]*?)<\/m\1>|([^<]+)|(<)/g
  let m
  while ((m = re.exec(String(raw ?? '')))) {
    if (m[1]) {
      for (const ch of m[2]) flat.push({ ch, marker: Number(m[1]) })
    } else if (m[3]) {
      for (const ch of m[3]) flat.push({ ch, marker: null })
    } else if (m[4]) {
      flat.push({ ch: '<', marker: null })
    }
  }
  return flat
}

function serializeFromFlat(flat) {
  let out = ''
  let i = 0
  while (i < flat.length) {
    const marker = flat[i].marker
    let j = i
    while (j < flat.length && flat[j].marker === marker) j++
    const seg = flat.slice(i, j).map((f) => f.ch).join('')
    out += marker ? `<m${marker}>${seg}</m${marker}>` : seg
    i = j
  }
  return out
}

/**
 * タグを除いたプレーンテキストを返す。
 * 編集画面に出すときのほか、AIへ渡す文脈・一覧カード・検索対象など、
 * 「マーカーが混ざっていては困る場所」すべてでこれを通すこと。
 */
export function plainTextOf(raw) {
  return parseToFlat(raw).map((f) => f.ch).join('')
}

/** [start, end) の範囲にマーカーを適用する。既存のマーカーは上書きされる */
export function applyMarkerRange(raw, start, end, colorIndex) {
  const flat = parseToFlat(raw)
  for (let i = start; i < end && i < flat.length; i++) flat[i].marker = colorIndex
  return serializeFromFlat(flat)
}

/** [start, end) の範囲のマーカーを消す */
export function eraseMarkerRange(raw, start, end) {
  const flat = parseToFlat(raw)
  for (let i = start; i < end && i < flat.length; i++) flat[i].marker = null
  return serializeFromFlat(flat)
}

/**
 * マーカー付きテキストをhtmlに変換する。マーカー部分は
 * data-start/data-end(プレーンテキスト上の位置)を持つspanにする。
 */
export function renderMarkedHtml(raw, escapeHtml) {
  const flat = parseToFlat(raw)
  let html = ''
  let i = 0
  while (i < flat.length) {
    const marker = flat[i].marker
    let j = i
    while (j < flat.length && flat[j].marker === marker) j++
    const seg = escapeHtml(flat.slice(i, j).map((f) => f.ch).join(''))
    if (marker) {
      html += `<span class="marker" data-start="${i}" data-end="${j}" style="background:${MARKER_COLORS[marker]}">${seg}</span>`
    } else {
      html += seg
    }
    i = j
  }
  return html
}

/**
 * 編集後の新しいプレーンテキストに、旧テキストのマーカー範囲を
 * 可能な限り引き継ぐ。完全一致する文字列が見つかった場合のみ引き継ぎ、
 * 文言が変わった箇所のマーカーは外れる(座標がずれて誤爆するのを防ぐため)。
 */
export function reconcileMarkers(oldRaw, newPlainText) {
  const oldFlat = parseToFlat(oldRaw)
  const runs = []
  let i = 0
  while (i < oldFlat.length) {
    const marker = oldFlat[i].marker
    let j = i
    while (j < oldFlat.length && oldFlat[j].marker === marker) j++
    if (marker) runs.push({ text: oldFlat.slice(i, j).map((f) => f.ch).join(''), marker })
    i = j
  }

  const flat = [...newPlainText].map((ch) => ({ ch, marker: null }))
  for (const run of runs) {
    if (!run.text) continue
    const idx = newPlainText.indexOf(run.text)
    if (idx === -1) continue
    for (let k = idx; k < idx + run.text.length; k++) flat[k].marker = run.marker
  }
  return serializeFromFlat(flat)
}
