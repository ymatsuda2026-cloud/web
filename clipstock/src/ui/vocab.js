import { escapeHtml } from './render.js'
import { tagStats, vocabSummary, mergeCandidates, TAIL_MAX } from '../lib/vocab.js'

/**
 * 語彙の整理パネル。
 *
 * 見て終わる画面にしないため、候補の隣に必ず操作(まとめる/残す)を置く。
 * 度数の棒は「そのタグで絞り込めるか」を見るためのもので、
 * 下位(TAIL_MAX回以下)は破線から下にまとめて、掃除待ちの列として見せる。
 */
export function openVocabPanel(items, handlers) {
  const root = document.getElementById('modal-root')

  function paint(state = {}) {
    const stats = tagStats(items)
    const summary = vocabSummary(items)
    const candidates = mergeCandidates(items, handlers.dismissed())
    const head = stats.filter((s) => !s.tail)
    const tail = stats.filter((s) => s.tail)
    const max = stats[0]?.count || 1

    const bar = (s) => `
      <div class="vb-row">
        <span class="vb-label ${s.tail ? 'tail' : ''}">${escapeHtml(s.tag)}</span>
        <span class="vb-track"><span class="vb-fill ${s.tail ? 'tail' : ''}" style="width:${Math.max(3, (s.count / max) * 100)}%"></span></span>
        <span class="vb-count">${s.count}</span>
      </div>`

    const candidateCard = (c) => `
      <div class="vc-card" data-key="${escapeHtml(c.key)}">
        <div class="vc-pair">
          <span class="tag">${escapeHtml(c.from)} <span class="muted">${c.fromCount}</span></span>
          <i class="ti ti-arrow-right" aria-hidden="true"></i>
          <span class="chip on">${escapeHtml(c.to)} <span style="opacity:.7">${c.toCount}</span></span>
        </div>
        <p class="vc-why">共起 ${Math.round(c.co * 100)}%${
          c.sameWord
            ? ' ・ 綴りが違うだけの同じ語'
            : c.fromCount === 1
              ? ' ・ 1本だけなので根拠は弱い'
              : c.co >= 1
                ? ` ・ ${c.fromCount}本すべてに ${escapeHtml(c.to)} が付いている`
                : ' ・ 判断が要る'
        }</p>
        <div class="row">
          <button class="btn btn-sm vc-merge" data-from="${escapeHtml(c.from)}" data-to="${escapeHtml(c.to)}" data-key="${escapeHtml(c.key)}">まとめる</button>
          <button class="btn btn-sm vc-keep" data-key="${escapeHtml(c.key)}">別物として残す</button>
        </div>
      </div>`

    root.innerHTML = `
      <div class="overlay">
        <div class="modal modal-wide">
          <div class="modal-head">
            <h2 class="modal-title">語彙の整理</h2>
            <button id="vocab-close" class="btn-ghost" aria-label="閉じる"><i class="ti ti-x" aria-hidden="true"></i></button>
          </div>

          <p class="foot-note">全${summary.videos}本 ／ タグ${summary.tags}語${summary.tailTags ? ` ／ ${TAIL_MAX}回以下 ${summary.tailTags}語` : ''}${summary.untagged ? ` ／ タグなし ${summary.untagged}本` : ''}</p>

          ${state.busy ? `<p class="foot-note" style="margin-top:8px">${escapeHtml(state.busy)}</p>` : ''}
          ${state.error ? `<p class="error-text" style="margin-top:8px">${escapeHtml(state.error)}</p>` : ''}

          <label class="field-label">タグの使われ方</label>
          ${stats.length
            ? `<div class="vb-list">
                 ${head.map(bar).join('')}
                 ${tail.length
                   ? `<div class="vb-divider">
                        <span>ここから下は絞り込みに使えていない</span>
                      </div>
                      ${tail.map(bar).join('')}`
                   : ''}
               </div>`
            : '<p class="empty-section">まだタグがありません</p>'}

          <label class="field-label">統合の候補</label>
          <p class="foot-note">いつも一緒に付いている組は、別の観点ではなく言い換えの疑いがあります</p>
          ${candidates.length
            ? `<div class="vc-list">${candidates.map(candidateCard).join('')}</div>`
            : '<p class="empty-section">候補はありません</p>'}

          <div class="modal-foot">
            <button id="vocab-reset" class="btn">残すと決めた組を戻す</button>
            <button id="vocab-done" class="btn btn-primary">閉じる</button>
          </div>
        </div>
      </div>
    `

    const close = () => (root.innerHTML = '')
    document.getElementById('vocab-close').addEventListener('click', close)
    document.getElementById('vocab-done').addEventListener('click', close)
    document.getElementById('vocab-reset').addEventListener('click', () => {
      handlers.onResetDismissed()
      paint()
    })

    root.querySelectorAll('.vc-keep').forEach((btn) =>
      btn.addEventListener('click', () => {
        handlers.onKeep(btn.dataset.key)
        paint()
      })
    )
    root.querySelectorAll('.vc-merge').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const { from, to } = btn.dataset
        if (!confirm(`「${from}」が付いている動画すべてを「${to}」に置き換えます。元に戻すには手作業が必要です。`)) return
        paint({ busy: `「${from}」を「${to}」にまとめています...` })
        try {
          const res = await handlers.onMerge(from, to)
          paint({ busy: `${res.updated}本を更新しました${res.failed ? `（${res.failed}本失敗）` : ''}` })
        } catch (err) {
          paint({ error: `まとめられませんでした: ${err.message || err}` })
        }
      })
    )
  }

  paint()
}
