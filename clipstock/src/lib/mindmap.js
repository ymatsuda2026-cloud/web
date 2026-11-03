/**
 * マインドマップの描画。本体は共通API(api/mindmap2)にあり、
 * ここには動画ナレッジ固有の飾り(再生リンクとマーカー)だけを置く。
 *
 * Notionには「markmap用のMarkdown」を保存する方針にしている。
 * HTMLを丸ごと保存する方式だと、
 *  - CDNのscriptタグ分だけで文字数を食う
 *  - Notion上で開いても中身が読めない
 *  - 描画ライブラリを差し替えられない
 * ため。ただし旧スキルがHTMLを書き込んだページも残っているので、
 * '<' で始まる値は旧形式としてiframeにそのまま流し込む(API側で処理)。
 */

import { renderMindmap as renderMap, splitPrefix, nodeLineIndexes } from '../../../api/mindmap2/mindmap2.js'
import { parseTimecode, youtubeUrlAt, splitLabel, withTimecode } from './timecode.js'
import { MARKER_COLORS } from './markers.js'

export { isLegacyHtml } from '../../../api/mindmap2/mindmap2.js'

/**
 * マインドマップ内の "[12:34]" をMarkdownリンクに変える。
 * markmapはMarkdownのリンクをそのままクリック可能にするので、
 * 描画側に手を入れずに枝から動画へ飛べる。
 */
function linkTimecodes(markdown, videoUrl) {
  if (!videoUrl) return markdown
  return String(markdown).replace(/\[((?:\d{1,2}:)?\d{1,3}:\d{2})\]/g, (m, label) => {
    const at = parseTimecode(m)
    const href = at === null ? null : youtubeUrlAt(videoUrl, at)
    return href ? `[${label}](${href})` : m
  })
}

// ---- ノードのマーカー ----
//
// 他のタブと同じ <m1>…</m1> を行のラベルに直接埋める。座標を別に持たないので
// あとでMarkdownを直しても壊れず、既存の plainTextOf でそのまま外せる。

const MARKER_TAG = /<m([123])>([\s\S]*?)<\/m\1>/g

/** nodeIndex 番目のノードに今引かれている色。無ければ null */
export function nodeMarkerOf(markdown, nodeIndex) {
  const { lines, indexes } = nodeLineIndexes(markdown)
  const at = indexes[nodeIndex]
  if (at === undefined) return null
  const m = splitPrefix(lines[at]).label.match(/<m([123])>/)
  return m ? Number(m[1]) : null
}

/**
 * nodeIndex 番目のノードにマーカーを引く。colorIndex が null なら消す。
 * 末尾のタイムコードは外してから包む(包むとリンク化が壊れるため)。
 */
export function markNodeLine(markdown, nodeIndex, colorIndex) {
  const { lines, indexes } = nodeLineIndexes(markdown)
  const at = indexes[nodeIndex]
  if (at === undefined) return String(markdown ?? '')

  const { prefix, label } = splitPrefix(lines[at])
  const { text, at: seconds } = splitLabel(label)
  const bare = text.replace(MARKER_TAG, '$2')
  const marked = colorIndex ? `<m${colorIndex}>${bare}</m${colorIndex}>` : bare
  lines[at] = prefix + withTimecode(marked, seconds)
  return lines.join('\n')
}

/** markmapに渡す前に、マーカーのタグを色付きのspanにする */
function markerToHtml(markdown) {
  return String(markdown).replace(
    MARKER_TAG,
    (_, color, text) => `<span class="mm-mark" style="background:${MARKER_COLORS[color]}">${text}</span>`
  )
}

/** 編集欄に出す、マーカーもタイムコードも外した文言 */
function bareLabel(line) {
  return splitLabel(splitPrefix(line).label).text.replace(MARKER_TAG, '$2').trim()
}

/**
 * container の中にマインドマップを描画する。
 * @param {HTMLElement} container
 * @param {string} value Notionの「マインドマップ」プロパティの生値
 * @param {string} videoUrl
 * @param {{onNodeClick?: (nodeIndex: number, el: HTMLElement) => void, onChange?: (markdown: string) => void, autoFocus?: boolean}} options
 */
export function renderMindmap(container, value, videoUrl = '', options = {}) {
  return renderMap(container, value, {
    ...options,
    emptyText: 'マインドマップはまだありません',
    decorate: (markdown) => markerToHtml(linkTimecodes(markdown, videoUrl)),
    labelOf: bareLabel,
    // 末尾のタイムコードは編集で消さずに引き継ぐ
    lineOf: (line, text) => {
      const { prefix, label } = splitPrefix(line)
      return prefix + withTimecode(text, splitLabel(label).at)
    },
  })
}
