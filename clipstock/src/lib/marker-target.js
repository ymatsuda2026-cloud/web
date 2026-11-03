import { parseSections, serializeSections } from './sections.js'
import { splitLabel, withTimecode } from './timecode.js'
import { plainTextOf } from './markers.js'

/**
 * マーカーを「分野別/応用/活用アイデア」の中の1項目に対して読み書きする。
 *
 * マーカーは <m1>text</m1> の形で本文の文字列そのものに埋め込む方式なので、
 * 保存先は既存のテキストプロパティのままでよく、新しいカラムは要らない。
 * ただし保存形式が「## 見出し / 本文 / - 箇条書き」の組み立て文字列なので、
 * 項目1つを書き換えたら必ずセクション全体を組み直してから保存する。
 *
 * 住所(addr)の形:
 *   { kind: 'whole' }                        … サマリのように単一のテキスト
 *   { kind: 'body',  sec: 0 }                … セクションの説明文
 *   { kind: 'point', sec: 0, point: 2 }      … セクションの箇条書き1件
 *
 * 見出しは対象にしない。末尾のタイムコードと隣り合っていて誤爆しやすいわりに、
 * 見出しにマーカーを引きたい場面がほとんど無いため。
 */

/** DOMのdata属性から住所を復元する */
export function addrOf(el) {
  const kind = el.dataset.mkind
  if (!kind) return null
  return {
    field: el.dataset.mfield,
    kind,
    sec: el.dataset.msec === undefined ? null : Number(el.dataset.msec),
    point: el.dataset.mpoint === undefined ? null : Number(el.dataset.mpoint),
  }
}

/** 住所をdata属性の文字列にする(描画側で使う) */
export function addrAttrs(field, kind, sec = null, point = null) {
  return [
    `data-mfield="${field}"`,
    `data-mkind="${kind}"`,
    sec === null ? '' : `data-msec="${sec}"`,
    point === null ? '' : `data-mpoint="${point}"`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * その住所のマーカー付き生テキストを取り出す。
 * 箇条書きは末尾のタイムコードを外した部分だけを対象にする
 * (タイムコードごとマーカーで塗ると、書き戻しで壊れるため)。
 */
export function getMarkedText(fieldRaw, addr) {
  if (addr.kind === 'whole') return String(fieldRaw ?? '')
  const sections = parseSections(fieldRaw)
  const sec = sections[addr.sec]
  if (!sec) return ''
  if (addr.kind === 'body') return sec.body
  return splitLabel(sec.points[addr.point] ?? '').text
}

/** getMarkedText の書き込み版。フィールド全体の新しい文字列を返す */
export function setMarkedText(fieldRaw, addr, value) {
  if (addr.kind === 'whole') return value
  const sections = parseSections(fieldRaw)
  const sec = sections[addr.sec]
  if (!sec) return String(fieldRaw ?? '')

  if (addr.kind === 'body') {
    sec.body = value
  } else {
    // タイムコードは本文から切り離してあるので、書き戻すときに付け直す
    const { at } = splitLabel(sec.points[addr.point] ?? '')
    sec.points[addr.point] = withTimecode(value, at)
  }
  return serializeSections(sections)
}

/**
 * マーカーを取り除いたテキスト。
 * AIへ渡す文脈・一覧カード・アイデア一覧など、タグが見えては困る場所で使う。
 */
export function stripMarkers(raw) {
  return plainTextOf(raw)
}
