import { escapeHtml } from './render.js'
import { formatDuration } from '../lib/records.js'

/**
 * 閲覧の記録。
 * 数字そのものより「続いているか」が分かるほうが役に立つので、
 * 合計より先に今月と連続日数を置き、下にカレンダーの濃淡を敷いている。
 */

/** 濃淡の段。10分・30分・60分で色が変わる */
function level(sec) {
  if (!sec) return 0
  if (sec < 600) return 1
  if (sec < 1800) return 2
  if (sec < 3600) return 3
  return 4
}

function statCard(label, value, sub = '') {
  return `
    <div class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`
}

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const w = '日月火水木金土'[d.getDay()]
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * @param {HTMLElement} el
 * @param {object} data recordSummary() の戻り
 * @param {object} ctx { sourceLabel(id), title }
 * @param {object} handlers { onOpen(key) }
 */
export function renderRecords(el, data, ctx, handlers) {
  if (data.empty) {
    el.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-chart-dots" aria-hidden="true"></i>
        <p>まだ記録がありません</p>
        <p class="empty-hint">詳細を開いている時間を数えます。いくつか開くと、ここに溜まっていきます(この端末だけの記録です)</p>
      </div>`
    return
  }

  const heat = data.cells
    .map((c) =>
      c.future
        ? '<span class="heat-cell heat-void" aria-hidden="true"></span>'
        : `<span class="heat-cell heat-l${level(c.sec)}" title="${escapeHtml(c.date)} ${escapeHtml(formatDuration(c.sec))}"></span>`
    )
    .join('')

  const maxSec = Math.max(1, ...data.bySource.map((r) => r.sec))
  const breakdown = data.bySource.length
    ? `
    <h3 class="panel-head">種別ごとの時間(今月)</h3>
    <div class="bar-list">
      ${data.bySource
        .map(
          (r) => `
        <div class="bar-row">
          <span class="bar-name">${escapeHtml(ctx.sourceLabel(r.source))}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.round((r.sec / maxSec) * 100)}%"></span></span>
          <span class="bar-num">${escapeHtml(formatDuration(r.sec))}</span>
        </div>`
        )
        .join('')}
    </div>`
    : ''

  const recent = data.recent.length
    ? `
    <h3 class="panel-head">最近ひらいたもの</h3>
    <div class="rec-list">
      ${data.recent
        .map(
          (r) => `
        <button class="rec-row" data-key="${escapeHtml(r.key)}">
          <span class="rec-when">${escapeHtml(fmtWhen(r.lastAt))}</span>
          <span class="rec-title">${escapeHtml(r.title || '(題名なし)')}</span>
          <span class="rec-meta">${r.done ? '<i class="ti ti-check" aria-hidden="true"></i>' : ''}${escapeHtml(formatDuration(r.sec))}</span>
        </button>`
        )
        .join('')}
    </div>`
    : ''

  el.innerHTML = `
    <section class="panel">
      <h2 class="panel-title">${escapeHtml(ctx.title || '閲覧の記録')}</h2>
      <div class="stat-row">
        ${statCard('今月見た時間', formatDuration(data.monthSec))}
        ${statCard('今月ひらいた数', `${data.monthOpens}件`)}
        ${statCard('続けて見た日数', `${data.streak}日`)}
        ${statCard('見終わった(今月 / 全部)', `${data.doneMonth} / ${data.doneAll}件`)}
      </div>

      <h3 class="panel-head">この${data.weeks}週間</h3>
      <div class="heat" style="grid-template-rows: repeat(7, 11px);">${heat}</div>
      <div class="heat-legend">
        少ない
        <span class="heat-cell heat-l0"></span>
        <span class="heat-cell heat-l1"></span>
        <span class="heat-cell heat-l2"></span>
        <span class="heat-cell heat-l3"></span>
        <span class="heat-cell heat-l4"></span>
        多い<span class="muted">(10分・30分・60分で色が変わります)</span>
      </div>

      ${breakdown}
      ${recent}

      <p class="foot-note">詳細を開いて前面にある時間を数えています(全部で ${escapeHtml(formatDuration(data.totalSec))})。記録はこの端末だけに残ります。</p>
    </section>`

  el.querySelectorAll('.rec-row').forEach((row) =>
    row.addEventListener('click', () => handlers.onOpen(row.dataset.key))
  )
}
