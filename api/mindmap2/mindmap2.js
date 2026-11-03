/*!
 * mindmap2.js — markmap でマインドマップを描き、キーボードで編集する共通API
 *
 *   import { renderMindmap } from '../api/mindmap2/mindmap2.js'
 *   renderMindmap(el, markdown, { onChange: (md) => save(md) })
 *
 * 扱う値は markmap 用の Markdown 文字列(`#` が中心、`##` が大項目、`-` が枝)。
 * HTMLやツリーJSONではなくMarkdownにしているのは、保存先(Notionなど)でそのまま読めて、
 * 描画ライブラリを差し替えても中身が生き残るため。
 *
 * 表示だけなら options は不要。onChange を渡したときだけ編集キーが効く。
 * アプリ固有の飾り(再生リンク、マーカーなど)は decorate / labelOf / lineOf で差し込む。
 */

/**
 * ファイル名を直接指定しないこと。
 * ブラウザ向けの実体は markmap-view が dist/browser/index.js なのに対し、
 * markmap-lib は dist/browser/index.iife.js と名前が違う。
 * パッケージ名だけを指定すれば、CDNが package.json の jsdelivr フィールドを見て
 * 正しいファイルを返す。読み込み順も lib(Transformer) -> view(Markmap) から変えない。
 */
const CDN = [
  { url: 'https://cdn.jsdelivr.net/npm/d3@7', check: () => Boolean(window.d3), name: 'd3' },
  {
    url: 'https://cdn.jsdelivr.net/npm/markmap-lib@0.18',
    check: () => Boolean(window.markmap?.Transformer),
    name: 'markmap-lib',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/markmap-view@0.18',
    check: () => Boolean(window.markmap?.Markmap),
    name: 'markmap-view',
  },
]

const NEW_LABEL = '新しい項目'

let loading = null

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve()
    const el = document.createElement('script')
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`読み込みに失敗しました: ${src}`))
    document.head.appendChild(el)
  })
}

/** markmap一式を読み込む。どれが欠けたか分かるよう1つずつ検証する */
function loadMarkmap() {
  if (!loading) {
    loading = (async () => {
      for (const dep of CDN) {
        await loadScript(dep.url)
        if (!dep.check()) throw new Error(`${dep.name} を読み込めませんでした (${dep.url})`)
      }
      return window.markmap
    })().catch((err) => {
      loading = null // 次回リトライできるようにする
      throw err
    })
  }
  return loading
}

/** 旧いスキルが書き込んだHTMLをそのまま持っている値か */
export function isLegacyHtml(value) {
  return String(value ?? '').trim().startsWith('<')
}

/** ノードになる行(空行以外)だけを並び順で返す。markmapの前順と一致する */
export function nodeLineIndexes(markdown) {
  const lines = String(markdown ?? '').split('\n')
  const indexes = []
  lines.forEach((line, i) => {
    if (line.trim()) indexes.push(i)
  })
  return { lines, indexes }
}

/** 行頭の "## " や "  - " と、そのあとのラベルを分ける */
export function splitPrefix(line) {
  const m = String(line).match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)?)([\s\S]*)$/)
  return { prefix: m[1], label: m[2] }
}

/** その行がマップの何段目になるか。見出しの数とリストのインデントから決まる */
function lineDepth(line) {
  const heading = line.match(/^(#{1,6})\s/)
  if (heading) return heading[1].length - 1
  const item = line.match(/^(\s*)[-*+]\s/)
  if (item) return 2 + Math.floor(item[1].length / 2)
  return 99
}

/** その枝の1段下に足すときの行頭 */
function childPrefixOf(line) {
  const heading = line.match(/^(#{1,6})\s/)
  if (heading) return heading[1].length < 2 ? '#'.repeat(heading[1].length + 1) + ' ' : '- '
  const item = line.match(/^(\s*)[-*+]\s/)
  return item ? ' '.repeat(item[1].length + 2) + '- ' : '- '
}

/** pos番目のノードの、ぶら下がりを含めた最後の位置 */
function subtreeEnd(lines, indexes, pos) {
  const depth = lineDepth(lines[indexes[pos]])
  let last = pos
  for (let i = pos + 1; i < indexes.length; i++) {
    if (lineDepth(lines[indexes[i]]) <= depth) break
    last = i
  }
  return last
}

/** 内容のあるノードを前順で。Markdownの非空行と同じ並びになる */
function contentNodes(root) {
  const out = []
  ;(function walk(node) {
    if (String(node?.content ?? '').trim()) out.push(node)
    ;(node?.children || []).forEach(walk)
  })(root)
  return out
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/**
 * container の中にマインドマップを描画する。
 * @param {HTMLElement} container
 * @param {string} markdown markmap用のMarkdown(旧形式のHTMLもそのまま出せる)
 * @param {{
 *   onChange?: (markdown: string) => void,
 *   onNodeClick?: (nodeIndex: number, labelEl: HTMLElement) => void,
 *   decorate?: (markdown: string) => string,
 *   labelOf?: (line: string) => string,
 *   lineOf?: (line: string, text: string) => string,
 *   initialExpandLevel?: number,
 *   autoFocus?: boolean,
 *   emptyText?: string,
 * }} [options]
 */
export async function renderMindmap(container, markdown, options = {}) {
  const raw = String(markdown ?? '').trim()
  container.innerHTML = ''
  container.classList.add('mm-host')

  if (!raw) {
    if (options.emptyText) container.innerHTML = `<p class="mm-empty">${escapeHtml(options.emptyText)}</p>`
    return
  }

  if (isLegacyHtml(raw)) {
    const frame = document.createElement('iframe')
    frame.className = 'mindmap-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.srcdoc = raw
    container.appendChild(frame)
    return
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('mindmap-svg')
  container.appendChild(svg)

  try {
    const { Markmap, Transformer } = await loadMarkmap()
    const transformer = new Transformer()
    const decorate = options.decorate || ((md) => md)
    const toRoot = (md) => transformer.transform(decorate(md)).root
    const state = { markdown: raw, root: toRoot(raw) }
    const mm = Markmap.create(
      svg,
      {
        duration: 200,
        spacingVertical: 6,
        paddingX: 12,
        initialExpandLevel: options.initialExpandLevel ?? -1,
      },
      state.root
    )
    if (options.onNodeClick) bindNodeClick(svg, state, options.onNodeClick)
    bindCursor(container, svg, mm, state, options, toRoot)
    return mm
  } catch (err) {
    // 描画できなくても内容は読めるようにしておく
    container.innerHTML = `
      <p class="mm-error">${escapeHtml(err.message || err)}</p>
      <pre class="mindmap-fallback">${escapeHtml(raw)}</pre>
    `
  }
}

/**
 * ノードのクリックを、そのノードが何行目から作られたかに変換して渡す。
 * 木を前順でたどった順番と、Markdownの空行を除いた行の順番は一致する。
 * 折りたたみの丸とリンクは markmap 側の操作なので拾わない。
 */
function bindNodeClick(svg, state, onNodeClick) {
  svg.addEventListener('click', (e) => {
    if (e.target.closest('a') || e.target.closest('circle')) return
    const g = e.target.closest('g.markmap-node')
    if (!g) return
    // 枝を足したあとは木が入れ替わるため、対応表は作り置きせずその都度たどる
    const index = contentNodes(state.root).indexOf(window.d3?.select(g).datum())
    if (index < 0) return
    const label = g.querySelector('.markmap-foreign') || g.querySelector('foreignObject div')
    if (label) onNodeClick(index, label)
  })
}

// ---- カーソル操作とその場編集 ----
//
// 位置は「非空行の何番目か」で持つ。markmapの木を前順でたどった順番と一致するので、
// 木を入れ替えても同じ枝に戻れる。行の中身の扱いは labelOf / lineOf に任せる。

function bindCursor(container, svg, mm, state, options, toRoot) {
  const editable = typeof options.onChange === 'function'
  const labelOf = options.labelOf || ((line) => splitPrefix(line).label.trim())
  const lineOf = options.lineOf || ((line, text) => splitPrefix(line).prefix + text)

  let all = contentNodes(state.root)
  if (!all.length) return

  let { lines, indexes } = nodeLineIndexes(state.markdown)
  let current = all[0]
  let editing = false

  container.tabIndex = 0
  const gOf = (node) =>
    [...svg.querySelectorAll('g.markmap-node')].find((g) => window.d3?.select(g).datum() === node)
  const posOf = (node) => all.indexOf(node)

  function paint() {
    svg.querySelectorAll('g.mm-current').forEach((g) => g.classList.remove('mm-current'))
    gOf(current)?.classList.add('mm-current')
  }

  // markmapは枝の大きさを測ってから描き、描き直しのたびにclassを付け直す。
  // 一度付けただけだとカーソルが消えるので、描画が落ち着くまで付け直す
  function paintSoon() {
    paint()
    requestAnimationFrame(paint)
    setTimeout(paint, 300)
  }

  /**
   * カーソルの枝が見えていなければ、見える位置まで盤面を動かす。
   * markmapのzoomをd3のtransition経由で動かすので、滑り込むように寄る。
   * 枝の遷移中は位置が定まらないため、呼び出し側が待ち時間を指定する。
   */
  let revealTimer = null
  function reveal(delay = 0) {
    clearTimeout(revealTimer)
    revealTimer = setTimeout(() => {
      const g = gOf(current)
      const d3 = window.d3
      if (!g || !d3 || !mm.svg || !mm.zoom) return
      const box = g.getBoundingClientRect()
      const view = container.getBoundingClientRect()
      const margin = 48
      let dx = 0
      let dy = 0
      if (box.left < view.left + margin) dx = view.left + margin - box.left
      else if (box.right > view.right - margin) dx = view.right - margin - box.right
      if (box.top < view.top + margin) dy = view.top + margin - box.top
      else if (box.bottom > view.bottom - margin) dy = view.bottom - margin - box.bottom
      if (!dx && !dy) return
      const t = d3.zoomTransform(mm.svg.node())
      mm.svg.transition().duration(320).call(mm.zoom.transform, t.translate(dx / t.k, dy / t.k))
    }, delay)
  }

  /**
   * Markdownを差し替える。描き直しではなく markmap にデータだけ渡すので、
   * 表示位置と拡大率はそのままで、変わった枝だけが動く。
   * setData は initialExpandLevel を当て直してしまうため、開閉は自分で持ち回して
   * 新しい木へ写し、以後は -1(データの指定に従う)に切り替える。
   */
  async function apply(nextMarkdown, cursorPos, opts = {}) {
    const folds = all.map((n) => (n.payload?.fold ? 1 : 0))
    const nextRoot = toRoot(nextMarkdown)
    // 入れ替え前の何番目にあたるかを引いて、開閉を新しい木へ写す
    const oldPos = (i) => {
      if (opts.insertedAt != null) return i < opts.insertedAt ? i : i === opts.insertedAt ? -1 : i - 1
      if (opts.removedAt != null) return i < opts.removedAt ? i : i + opts.removedCount
      return i
    }
    contentNodes(nextRoot).forEach((node, i) => {
      const from = oldPos(i)
      node.payload = { ...(node.payload || {}), fold: from >= 0 ? folds[from] || 0 : 0 }
    })

    state.markdown = nextMarkdown
    state.root = nextRoot
    if (opts.changed) options.onChange?.(nextMarkdown)

    // setData は大きさを測ってから描くため、終わるのを待たないと枝がまだDOMに無い
    await mm.setData(nextRoot, { initialExpandLevel: -1 })

    // setData はノードを複製するので、DOMに結び付いた実体を取り直す
    all = contentNodes(state.root)
    ;({ lines, indexes } = nodeLineIndexes(state.markdown))
    current = all[Math.min(Math.max(cursorPos, 0), all.length - 1)] || all[0]
    paintSoon()
    // 入力欄は枝の位置に重ねるので、枝の移動と盤面の寄せが終わってから出す
    if (opts.edit) {
      reveal(160)
      setTimeout(startEdit, 500)
    } else {
      reveal(260)
    }
  }

  function visible() {
    const out = []
    ;(function walk(node) {
      if (String(node?.content ?? '').trim()) out.push(node)
      if (node?.payload?.fold) return
      ;(node?.children || []).forEach(walk)
    })(state.root)
    return out
  }

  function move(delta) {
    const list = visible()
    const at = list.indexOf(current)
    current = list[Math.min(list.length - 1, Math.max(0, at + delta))] || current
    paint()
    reveal()
  }

  async function toggle() {
    if (!current.children?.length) return
    await mm.toggleNode(current)
    paintSoon()
    reveal(260)
  }

  function startEdit() {
    const g = gOf(current)
    const div = g?.querySelector('.markmap-foreign') || g?.querySelector('foreignObject div')
    if (!editable || editing || !div) return
    const pos = posOf(current)
    const at = indexes[pos]
    const original = labelOf(lines[at])

    // SVGのforeignObject内は文字入力を受け付けないブラウザがあるため、
    // 枝と同じ位置にHTMLの入力欄を重ねて編集する
    const rect = div.getBoundingClientRect()
    const base = container.getBoundingClientRect()
    const scale = div.offsetWidth ? rect.width / div.offsetWidth : 1
    const input = document.createElement('input')
    input.className = 'mm-editor'
    input.value = original
    input.style.left = `${rect.left - base.left}px`
    input.style.top = `${rect.top - base.top}px`
    input.style.minWidth = `${Math.max(rect.width + 16, 80)}px`
    input.style.height = `${Math.max(rect.height, 20)}px`
    input.style.fontSize = `${parseFloat(getComputedStyle(div).fontSize || '14') * scale}px`
    container.appendChild(input)

    editing = true
    input.focus()
    input.select()

    const finish = (commit) => {
      if (!editing) return
      editing = false
      const text = input.value.replace(/\s+/g, ' ').trim()
      input.remove()
      if (commit && text && text !== original) {
        const next = [...lines]
        next[at] = lineOf(next[at], text)
        apply(next.join('\n'), pos, { changed: true })
      }
      container.focus({ preventScroll: true })
    }

    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.isComposing) return // 変換中のEnterは入力の確定に使わせる
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
  }

  function addNode(kind) {
    if (!editable || editing) return
    const pos = posOf(current)
    const line = lines[indexes[pos]]
    // 中心テーマに兄弟を足すとh1が2つになり、根が分かれてしまうので子として足す
    const asChild = kind === 'child' || pos === 0
    const prefix = asChild ? childPrefixOf(line) : splitPrefix(line).prefix
    const endPos = subtreeEnd(lines, indexes, pos)
    const next = [...lines]
    next.splice(indexes[endPos] + 1, 0, prefix + NEW_LABEL)
    if (asChild && current.payload?.fold) current.payload = { ...current.payload, fold: 0 }
    apply(next.join('\n'), endPos + 1, { changed: true, edit: true, insertedAt: endPos + 1 })
  }

  /** カーソルの枝を、ぶら下がっている分ごと削除する */
  function removeNode() {
    if (!editable || editing) return
    const pos = posOf(current)
    if (pos <= 0) return // 中心テーマは消さない
    const endPos = subtreeEnd(lines, indexes, pos)
    const count = endPos - pos + 1
    if (count > 1 && !confirm(`この枝と、ぶら下がる${count - 1}件を削除します。よろしいですか?`)) return

    const next = [...lines]
    next.splice(indexes[pos], indexes[endPos] - indexes[pos] + 1)
    apply(next.join('\n'), pos - 1, { changed: true, removedAt: pos, removedCount: count })
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('g.markmap-node')
    const node = g && window.d3?.select(g).datum()
    if (node && posOf(node) !== -1) { current = node; paint() }
    if (!editing) container.focus({ preventScroll: true })
  })

  container.addEventListener('keydown', (e) => {
    if (editing) return
    // マップにカーソルがある間は、画面側のキー操作へ流さない
    e.stopPropagation()
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (current.payload?.fold) toggle()
      else if (current.children?.length) { current = current.children[0]; paint(); reveal() }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (!current.payload?.fold && current.children?.length) toggle()
      else {
        const parent = all.find((n) => (n.children || []).includes(current))
        if (parent) { current = parent; paint(); reveal() }
      }
    } else if (e.key === ' ') { e.preventDefault(); startEdit() }
    else if (e.key === 'Tab') { e.preventDefault(); addNode('child') }
    else if (e.key === 'Delete') { e.preventDefault(); removeNode() }
    // 編集中のEnterは入力欄側で「決定」に使う
    else if (e.key === 'Enter') { e.preventDefault(); addNode('sibling') }
  })

  paint()
  if (options.autoFocus !== false) container.focus({ preventScroll: true })
}
