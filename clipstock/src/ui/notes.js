import { escapeHtml, highlightText } from './render.js'
import { MARKER_COLORS } from '../lib/markers.js'
import { NOTE_KINDS, kindLabel, noteStats } from '../lib/notes.js'

/**
 * 引いたマーカーを横断で並べる画面。
 * 左に絞り込み、右に「どれだけ引いたか」と一覧。
 * 位置の帯は、本文のどのあたりに線が集まっているかを見るためのもの。
 */

const PERIODS = [
  { id: 'week', label: '今週' },
  { id: 'month', label: '今月' },
  { id: 'quarter', label: '3か月' },
  { id: 'all', label: '全部' },
]

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const w = '日月火水木金土'[d.getDay()]
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function statCard(label, value) {
  return `<div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div></div>`
}

function colorDot(color) {
  return `<span class="note-dot" style="background:${MARKER_COLORS[color] || '#ccc'}"></span>`
}

/**
 * @param {HTMLElement} el
 * @param {object} view { all, shown, state, memoCount, sourceLabel(id) }
 * @param {object} handlers { onChange(patch), onOpen(key), onCopy(), onSave() }
 */
export function renderNotes(el, view, handlers) {
  const { all, shown, state, memoCount } = view
  if (!all.length) {
    el.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-highlight" aria-hidden="true"></i>
        <p>まだノートがありません</p>
        <p class="empty-hint">詳細で文章を選んでマーカーを引くと、ここに集まります</p>
      </div>`
    return
  }

  const stats = noteStats(shown)
  const titles = [...new Map(all.map((n) => [n.key, n.title])).entries()]

  const kinds = NOTE_KINDS.map(
    (k) => `<button class="chip ${state.colors.has(k.color) ? 'on' : ''}" data-color="${k.color}">
      ${colorDot(k.color)}${escapeHtml(k.label)}
    </button>`
  ).join('')

  const periods = PERIODS.map(
    (p) => `<button class="chip ${state.period === p.id ? 'on' : ''}" data-period="${p.id}">${escapeHtml(p.label)}</button>`
  ).join('')

  const books = [`<button class="chip ${state.itemKey ? '' : 'on'}" data-item="">すべて</button>`]
    .concat(
      titles.map(
        ([key, title]) =>
          `<button class="chip ${state.itemKey === key ? 'on' : ''}" data-item="${escapeHtml(key)}">${escapeHtml((title || '(題名なし)').slice(0, 18))}</button>`
      )
    )
    .join('')

  const maxTotal = Math.max(1, ...stats.byItem.map((r) => r.total))
  const breakdown = stats.byItem
    .slice(0, 12)
    .map(
      (r) => `
      <div class="bar-row">
        <span class="bar-name" title="${escapeHtml(r.title)}">${escapeHtml((r.title || '(題名なし)').slice(0, 16))}</span>
        <span class="bar-track">
          <span class="bar-group" style="width:${Math.round((r.total / maxTotal) * 100)}%">
            ${NOTE_KINDS.map((k) => {
              const n = r.colors.get(k.color) || 0
              return n ? `<span class="bar-seg" style="flex:${n};background:${MARKER_COLORS[k.color]}"></span>` : ''
            }).join('')}
          </span>
        </span>
        <span class="bar-num">${r.total}</span>
      </div>`
    )
    .join('')

  // 位置の帯。1つの項目に絞っているときだけ意味があるので、そのときだけ出す
  const focus = state.itemKey ? shown.filter((n) => n.key === state.itemKey) : []
  const posBar = focus.length
    ? `
    <h3 class="panel-head">本文のどこに線を引いたか</h3>
    <div class="pos-bar">
      ${focus
        .map(
          (n) => `<button class="pos-tick" data-note="${escapeHtml(n.id)}" style="left:${(n.pos * 100).toFixed(2)}%;background:${MARKER_COLORS[n.color]}" title="${escapeHtml(n.text.slice(0, 40))}"></button>`
        )
        .join('')}
    </div>
    <p class="foot-note">印が集まっている所が、よく引いた所です。</p>`
    : ''

  const list = shown.length
    ? shown
        .map(
          (n) => `
        <div class="note-row" data-note="${escapeHtml(n.id)}">
          ${colorDot(n.color)}
          <div class="note-body">
            <p class="note-text">${highlightText(n.text, state.query)}</p>
            <button class="note-src" data-key="${escapeHtml(n.key)}">
              ${escapeHtml(n.title || '(題名なし)')} ・ ${escapeHtml(n.fieldLabel)} ・ ${escapeHtml(kindLabel(n.color))}${n.at ? ` ・ ${escapeHtml(fmtWhen(n.at))}` : ''}
            </button>
          </div>
        </div>`
        )
        .join('')
    : '<p class="muted">この絞り込みに合うノートはありません</p>'

  el.innerHTML = `
    <section class="notes-layout">
      <aside class="notes-side">
        <h2 class="panel-title">ノート</h2>
        <div class="field-label">種類</div>
        <div class="chip-wrap">${kinds}</div>
        <div class="field-label">期間</div>
        <div class="chip-wrap">${periods}</div>
        <div class="field-label">項目</div>
        <div class="chip-wrap">${books}</div>
        <div class="field-label">言葉で探す</div>
        <input id="note-q" class="input sm" placeholder="引用から探す" value="${escapeHtml(state.query || '')}" />
        <div class="field-label">書き出し(絞り込んだ分)</div>
        <div class="row">
          <button id="note-save" class="btn btn-sm">Markdown で保存</button>
          <button id="note-copy" class="btn btn-sm">コピー</button>
        </div>
      </aside>

      <div class="notes-main">
        <div class="stat-row">
          ${statCard('記録', String(stats.total))}
          ${statCard('メモ', String(memoCount))}
          ${statCard('記録した項目', `${stats.itemCount}件`)}
          ${statCard('いちばん多い色', stats.topColor ? `${colorDot(stats.topColor)}${escapeHtml(kindLabel(stats.topColor))}` : '—')}
        </div>

        <h3 class="panel-head">項目ごとの数と色の内訳</h3>
        <div class="bar-list">${breakdown || '<p class="muted">なし</p>'}</div>

        ${posBar}

        <h3 class="panel-head">一覧(新しい順)</h3>
        <div class="note-list">${list}</div>
      </div>
    </section>`

  el.querySelectorAll('.chip[data-color]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const c = Number(chip.dataset.color)
      const colors = new Set(state.colors)
      colors.has(c) ? colors.delete(c) : colors.add(c)
      handlers.onChange({ colors })
    })
  )
  el.querySelectorAll('.chip[data-period]').forEach((chip) =>
    chip.addEventListener('click', () => handlers.onChange({ period: chip.dataset.period }))
  )
  el.querySelectorAll('.chip[data-item]').forEach((chip) =>
    chip.addEventListener('click', () => handlers.onChange({ itemKey: chip.dataset.item || null }))
  )
  el.querySelectorAll('.note-src').forEach((btn) =>
    btn.addEventListener('click', () => handlers.onOpen(btn.dataset.key))
  )
  el.querySelectorAll('.pos-tick').forEach((tick) =>
    tick.addEventListener('click', () => {
      const row = el.querySelector(`.note-row[data-note="${CSS.escape(tick.dataset.note)}"]`)
      row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      row?.classList.add('note-flash')
      setTimeout(() => row?.classList.remove('note-flash'), 1200)
    })
  )
  el.querySelector('#note-copy')?.addEventListener('click', () => handlers.onCopy())
  el.querySelector('#note-save')?.addEventListener('click', () => handlers.onSave())

  const q = el.querySelector('#note-q')
  q?.addEventListener('input', () => handlers.onChange({ query: q.value }, { keepFocus: true }))
}
