import { parseSections, isSectionHidden, visibleHeading, sectionRank } from '../lib/sections.js'
import { splitLabel, splitTranscript, formatTimecode, youtubeUrlAt, parseTimecode, stripTimecode } from '../lib/timecode.js'
import { renderMarkedHtml, plainTextOf, MARKER_COLORS } from '../lib/markers.js'
import { addrAttrs } from '../lib/marker-target.js'
import { STATUS_SUMMARIZED, STATUS_DONE, STATUS_NEW } from '../lib/filters.js'

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

/** 検索語を大文字小文字区別なくハイライトしたhtmlを返す */
export function highlightText(text, query) {
  const safe = escapeHtml(text ?? '')
  const q = (query ?? '').trim()
  if (!q) return safe
  const escaped = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return safe.replace(new RegExp(escaped, 'gi'), (m) => `<mark>${m}</mark>`)
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** YouTubeのURLから動画IDを取り、サムネイルURLを組み立てる(サムネイル未設定の保険) */
function fallbackThumb(url) {
  const m = String(url ?? '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)
  return m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : ''
}

/** 動画(YouTube)なら動画ID。Web記事や、URLから取れないものは null */
function videoIdOf(item) {
  if (item.source === 'web') return null
  return String(item.url ?? '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)?.[1] ?? null
}

/**
 * 再生ボタン。押すと画面隅の小窓で再生する(配線は main.js が data-play を委譲で拾う)。
 * リンクの中に button は置けないので、サムネイルが <a> の中にある詳細画面では
 * thumbHtml に play:false を渡し、この関数の結果を <a> の外に並べる。
 */
function playButtonHtml(item) {
  const id = videoIdOf(item)
  if (!id) return ''
  return `<button type="button" class="thumb-play" data-play="${id}" aria-label="動画を再生"><i class="ti ti-player-play-filled" aria-hidden="true"></i></button>`
}

function thumbHtml(item, extraClass = '', { play = true } = {}) {
  const src = item.thumb || fallbackThumb(item.url)
  const btn = play ? playButtonHtml(item) : ''
  if (!src) {
    const icon = item.source === 'web' ? 'ti-world' : 'ti-video-off'
    return `<div class="thumb thumb-blank ${extraClass}"><i class="ti ${icon}" aria-hidden="true"></i>${btn}</div>`
  }
  return `<div class="thumb ${extraClass}"><img src="${escapeHtml(src)}" alt="" loading="lazy" />${btn}</div>`
}

// ============ タグレール ============

export function renderTagRail(container, state, handlers) {
  const { tagOptions, selectedTags } = state
  if (!tagOptions.length) {
    container.innerHTML = ''
    return
  }
  container.innerHTML = `
    <div class="tag-rail">
      ${selectedTags.size ? '<button class="chip chip-clear">絞り込みを外す</button>' : ''}
      ${tagOptions
        .map(
          (o) => `<button class="chip ${o.selected ? 'on' : ''} ${o.disabled ? 'off' : ''}" data-tag="${escapeHtml(o.tag)}" ${o.disabled ? 'disabled' : ''}>
            ${escapeHtml(o.tag)}<span class="chip-count">${o.count}</span>
          </button>`
        )
        .join('')}
    </div>
  `
  container.querySelector('.chip-clear')?.addEventListener('click', handlers.onClearTags)
  container.querySelectorAll('.chip[data-tag]').forEach((el) => {
    el.addEventListener('click', () => handlers.onToggleTag(el.dataset.tag))
  })
}

// ============ ライブラリ(サムネイルのグリッド) ============

/** 進捗の見え方。カードの帯とドットで「どこまで出来ているか」を出す */
function progressHtml(item) {
  const steps = [
    { on: item.status === STATUS_SUMMARIZED || Boolean(item.summary), label: 'サマリ' },
    { on: item.has?.mindmap, label: 'マインドマップ' },
    { on: item.has?.fields, label: '分野別' },
    { on: item.has?.apply, label: '応用' },
    { on: item.has?.ideas, label: '活用' },
  ]
  return `<span class="dots" title="${steps.map((s) => `${s.label}:${s.on ? '有' : '無'}`).join(' / ')}">${steps
    .map((s) => `<i class="dot ${s.on ? 'on' : ''}"></i>`)
    .join('')}</span>`
}

export function renderLibrary(container, items, state, handlers) {
  if (!items.length) {
    const empty = state.emptyState || {
      icon: 'ti-movie',
      text: '該当する動画がありません',
      hint: 'Notionの動画DBにURLを追加すると、次のバッチで文字起こしまで進みます',
    }
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ${empty.icon}" aria-hidden="true"></i>
        <p>${empty.text}</p>
        <p class="empty-hint">${empty.hint}</p>
      </div>`
    return
  }

  container.innerHTML = `
    <div class="grid">
      ${items
        .map((item) => {
          const fav = state.favorite(item.key)
          return `
        <article class="card ${state.seen(item.key) ? '' : 'unseen'}" data-key="${escapeHtml(item.key)}" tabindex="0">
          ${thumbHtml(item)}
          <div class="card-body">
            <h3 class="card-title">${highlightText(item.title, state.searchQuery)}</h3>
            <p class="card-summary">${item.summary ? highlightText(plainTextOf(item.summary).slice(0, 110), state.searchQuery) : '<span class="muted">要約はまだありません</span>'}</p>
            <div class="card-foot">
              ${item.source === 'web' ? '<span class="badge badge-web"><i class="ti ti-world" aria-hidden="true"></i>Web</span>' : ''}
              <span class="badge s-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
              ${progressHtml(item)}
              <span class="card-date">${fmtDate(item.createdAt)}</span>
              <button class="card-edit card-fav ${fav ? 'on' : ''}" data-key="${escapeHtml(item.key)}" aria-label="${fav ? 'お気に入りから外す' : 'お気に入りに追加'}" aria-pressed="${fav}"><i class="ti ti-star" aria-hidden="true"></i></button>
              ${state.canEdit ? `<button class="card-edit" data-key="${escapeHtml(item.key)}" aria-label="この動画の情報を編集"><i class="ti ti-pencil" aria-hidden="true"></i></button>` : ''}
              ${state.canEdit ? `<button class="card-edit card-delete" data-key="${escapeHtml(item.key)}" aria-label="この動画を削除"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
            </div>
            ${state.showTags && item.tags?.length ? `<div class="card-tags">${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
        </article>`
        })
        .join('')}
    </div>
  `

  container.querySelectorAll('.card').forEach((el) => {
    const open = () => handlers.onOpen(el.dataset.key)
    el.addEventListener('click', open)
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return // 中のボタン(再生・お気に入りなど)のキー操作ではカードを開かない
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
  })

  container.querySelectorAll('.card-fav').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation() // カードのクリック(詳細を開く)と競合させない
      handlers.onToggleFavorite(btn.dataset.key)
    })
  })

  container.querySelectorAll('.card-edit:not(.card-fav)').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation() // カードのクリック(詳細を開く)と競合させない
      if (btn.classList.contains('card-delete')) handlers.onDelete(btn.dataset.key)
      else handlers.onEdit(btn.dataset.key)
    })
  })
}

// ============ マインドマップ一覧(公開ONのものだけ) ============

export function renderMindmapGallery(container, items, state, handlers) {
  if (!items.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-sitemap" aria-hidden="true"></i>
        <p>公開中のマインドマップがありません</p>
        <p class="empty-hint">詳細のマインドマップタブで「公開する」を押すと、ここに並びます</p>
      </div>`
    return
  }

  container.innerHTML = `
    <div class="grid">
      ${items
        .map(
          (item) => `
        <article class="card mm-card" data-key="${escapeHtml(item.key)}" tabindex="0">
          ${thumbHtml(item)}
          <div class="card-body">
            <h3 class="card-title">${highlightText(item.title, state.searchQuery)}</h3>
            <div class="card-foot">
              ${item.source === 'web' ? '<span class="badge badge-web"><i class="ti ti-world" aria-hidden="true"></i>Web</span>' : ''}
              <span class="grow"></span>
              <span class="card-date">${fmtDate(item.createdAt)}</span>
              ${state.canEdit ? hideButtonHtml('card-edit') : ''}
            </div>
            ${state.showTags && item.tags?.length ? `<div class="card-tags">${item.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          </div>
        </article>`
        )
        .join('')}
    </div>
  `

  container.querySelectorAll('.card').forEach((el) => {
    const open = () => handlers.onOpen(el.dataset.key)
    el.addEventListener('click', open)
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return // 中のボタン(再生・お気に入りなど)のキー操作ではカードを開かない
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
  })

  container.querySelectorAll('.btn-hide').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation() // カードのクリック(大きく見る)と競合させない
      handlers.onHide(btn.closest('.card').dataset.key)
    })
  })
}

// ============ セクション表示(分野別 / 応用 / 活用アイデア) ============

/**
 * "[12:34]" を動画のその時刻へ飛ぶリンクにする。
 * 動画URLが無い、または時刻が無い項目には何も出さない
 * (リンクの有無自体が「根拠が原文で確認できたか」の印になっている)。
 */
function timeChip(at, videoUrl) {
  if (at === null || at === undefined) return ''
  const href = youtubeUrlAt(videoUrl, at)
  const label = formatTimecode(at)
  if (!href) return `<span class="tc">${label}</span>`
  return `<a class="tc tc-link" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${label} から再生"><i class="ti ti-player-play" aria-hidden="true"></i>${label}</a>`
}

function sectionsHtml(text, { numbered = false, videoUrl = '', field = null, publishable = false, ranked = false } = {}) {
  const parsed = parseSections(text)
  if (!parsed.length) return '<p class="empty-section">まだありません</p>'
  // 並べ替えても保存先の番号とずれないよう、元の位置を持たせておく
  const sections = parsed.map((s, i) => ({ ...s, at: i, rank: sectionRank(s.heading) }))
  if (ranked) sections.sort((a, b) => b.rank - a.rank)

  // field が渡されたときだけマーカーを引けるようにする(読み取り専用のときは付けない)
  const mark = (raw, kind, sec, point) =>
    field
      ? `<span class="marker-target" ${addrAttrs(field, kind, sec, point)}>${renderMarkedHtml(raw, escapeHtml)}</span>`
      : escapeHtml(plainTextOf(raw))

  return `<div class="sections">${sections
    .map((s, order) => {
      const i = s.at
      const hidden = isSectionHidden(s.heading)
      const head = splitLabel(visibleHeading(s.heading) || '(無題)')
      return `
    <section class="sec ${hidden ? 'sec-hidden' : ''}">
      <h4 class="sec-head">${numbered ? `<span class="sec-num">${order + 1}</span>` : ''}${escapeHtml(plainTextOf(head.text))}${timeChip(head.at, videoUrl)}${
        ranked ? rankHtml(i, s.rank, publishable) : ''
      }${publishable ? sectionPublishHtml(i, !hidden) : ''}</h4>
      ${s.body ? `<p class="sec-body">${mark(s.body, 'body', i, null).replace(/\n/g, '<br />')}</p>` : ''}
      ${s.points.length
        ? `<ul class="sec-points">${s.points
            .map((p, j) => {
              const point = splitLabel(p)
              return `<li>${mark(point.text, 'point', i, j)}${timeChip(point.at, videoUrl)}</li>`
            })
            .join('')}</ul>`
        : ''}
    </section>`
    })
    .join('')}</div>`
}

/** 選択したときに出るマーカーのツールバー。位置は選択範囲に合わせて動かす */
function markerToolbarHtml() {
  return `
    <div class="marker-toolbar" id="marker-toolbar" style="display:none">
      ${[1, 2, 3]
        .map((c) => `<span class="marker-swatch" data-color="${c}" style="background:${MARKER_COLORS[c]}"></span>`)
        .join('')}
      <span class="marker-sep"></span>
      <button class="marker-erase" aria-label="マーカーを消す"><i class="ti ti-eraser" aria-hidden="true"></i></button>
    </div>`
}

/** マインドマップ用。色を選んでから枝をクリックすると、その枝が塗られる */
function mindmapToolsHtml(current) {
  return `
    <span class="mm-tools" title="色を選んでから枝をクリックすると塗れます">
      ${[1, 2, 3]
        .map(
          (c) =>
            `<button class="mm-swatch ${current === c ? 'on' : ''}" data-color="${c}" style="background:${MARKER_COLORS[c]}" aria-label="マーカー${c}"></button>`
        )
        .join('')}
      <button class="mm-swatch mm-erase ${current ? '' : 'on'}" data-color="0" aria-label="マーカーを消す"><i class="ti ti-eraser" aria-hidden="true"></i></button>
    </span>`
}

/** アイデア1件の公開の入り切り。見出しの右に出す */
function sectionPublishHtml(index, isPublic) {
  return `<button class="sec-publish ${isPublic ? '' : 'off'}" data-sec="${index}" aria-pressed="${isPublic}" title="${isPublic ? 'アイデア一覧に出しています' : 'アイデア一覧に出しません'}"><i class="ti ${isPublic ? 'ti-eye' : 'ti-eye-off'}" aria-hidden="true"></i></button>`
}

/** 価値の目安の3つ星。編集できるときは星を押して変えられる */
function rankHtml(index, rank, editable = false) {
  const stars = [1, 2, 3]
    .map((n) =>
      editable
        ? `<button class="star ${n <= rank ? 'on' : ''}" data-sec="${index}" data-rank="${n === rank ? 0 : n}" aria-label="星${n}">★</button>`
        : `<span class="star ${n <= rank ? 'on' : ''}">★</span>`
    )
    .join('')
  return `<span class="rank" title="${rank ? `星${rank}` : '未設定'}">${stars}</span>`
}

/** 公開の入り切り。押すと反転する状態ボタン */
function publishButtonHtml(isPublic) {
  return `<button class="btn btn-publish ${isPublic ? 'on' : ''}" aria-pressed="${isPublic}"><i class="ti ${isPublic ? 'ti-eye' : 'ti-eye-off'}" aria-hidden="true"></i>${isPublic ? '公開中' : '非公開'}</button>`
}

/** 一覧のカードからその場で非公開にするスイッチ */
function hideButtonHtml(cls) {
  return `<button class="${cls} btn-hide" aria-label="非公開にする" title="非公開にする"><i class="ti ti-eye-off" aria-hidden="true"></i></button>`
}

/** 原文タブ。タイムスタンプがあれば各かたまりの頭を再生リンクにする */
function transcriptHtml(text, videoUrl) {
  const segments = splitTranscript(text)
  if (!segments.length) return '<p class="empty-section">原文がまだありません</p>'
  if (segments.every((seg) => seg.at === null)) {
    return `<pre class="raw-text">${escapeHtml(text)}</pre>`
  }
  return `<div class="tr-list">${segments
    .map(
      (seg) => `<div class="tr-row">
        ${timeChip(seg.at, videoUrl)}
        <p class="tr-text">${escapeHtml(seg.text)}</p>
      </div>`
    )
    .join('')}</div>`
}

/** チャプタータブ(music)。"[12:34] 曲名" の行を、時刻を押すとその曲がかかる一覧にする */
function chaptersHtml(text, videoUrl) {
  const rows = String(text ?? '')
    .split('\n')
    .map((line) => ({ at: parseTimecode(line), text: stripTimecode(line) }))
    .filter((r) => r.text)
  if (!rows.length) return '<p class="empty-section">まだありません</p>'
  return `<ol class="chapters">${rows
    .map(
      (r, i) => `<li class="chapter-row">
        <span class="chapter-num">${i + 1}</span>
        ${timeChip(r.at, videoUrl)}
        <span class="chapter-title">${escapeHtml(r.text)}</span>
      </li>`
    )
    .join('')}</ol>`
}

// ============ 詳細 ============

const TABS = [
  { id: 'summary', label: 'サマリ' },
  { id: 'mindmap', label: 'マインドマップ' },
  { id: 'fields', label: '分野別' },
  { id: 'apply', label: '応用' },
  { id: 'ideas', label: '活用' },
  { id: 'memo', label: 'メモ' },
  { id: 'chat', label: 'チャット' },
  { id: 'raw', label: '原文' },
]

/**
 * music スペースのタブ。原文がYouTubeの概要欄なので、文字起こしを前提にした
 * マインドマップ・応用・活用・チャットは出さない。保存先のカラムは使い回す。
 */
const MUSIC_TABS = [
  { id: 'summary', label: 'チャプター' },
  { id: 'fields', label: '概要' },
  { id: 'memo', label: 'メモ' },
  { id: 'raw', label: '原文' },
]

export function tabsOf(mode) {
  return mode === 'music' ? MUSIC_TABS : TABS
}

/** どのタブがAI生成物か。ここに載っているタブには「作り直す」ボタンを出す */
const STAGE_OF_TAB = { summary: 'summary', mindmap: 'mindmap', fields: 'fields', apply: 'apply', ideas: 'ideas' }

export function detailHtml(item, state) {
  const d = state.detail || {}
  const tab = state.activeTab
  const canEdit = state.canEdit
  const music = state.mode === 'music'
  const tabs = tabsOf(state.mode)

  const editable = ['summary', 'mindmap', 'fields', 'apply', 'ideas'].includes(tab)
  const stage = STAGE_OF_TAB[tab]

  const head = `
    <div class="detail-head">
      <button class="btn-ghost btn-back" aria-label="一覧に戻る"><i class="ti ti-arrow-left" aria-hidden="true"></i></button>
      <div class="detail-headline">
        <h2 class="detail-title">${escapeHtml(item.title)}</h2>
        <div class="detail-meta">
          <span class="badge s-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
          <span>${fmtDate(item.createdAt)}</span>
          ${d.rawCount ? `<span>原文 ${d.rawCount.toLocaleString()}字</span>` : ''}
          ${d.model ? `<span class="model-badge">${escapeHtml(d.model)}</span>` : ''}
        </div>
      </div>
      <button class="btn-ghost btn-done ${state.done ? 'on' : ''}" aria-label="${state.done ? '見終わった印を外す' : '見終わったことにする'}" aria-pressed="${Boolean(state.done)}"><i class="ti ti-circle-check" aria-hidden="true"></i></button>
      <button class="btn-ghost btn-fav ${state.favorite ? 'on' : ''}" aria-label="${state.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}" aria-pressed="${Boolean(state.favorite)}"><i class="ti ti-star" aria-hidden="true"></i></button>
      ${item.url ? `<a class="btn-ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noopener" aria-label="${item.source === 'web' ? '元記事を開く' : 'YouTubeで開く'}"><i class="ti ti-external-link" aria-hidden="true"></i></a>` : ''}
      ${canEdit ? '<button class="btn-ghost btn-more" aria-label="その他の操作"><i class="ti ti-dots" aria-hidden="true"></i></button>' : ''}
    </div>
  `

  // サムネイルとタグはスクロールで送れるように本文側に置き、タブ列だけ上端に貼り付ける
  const hero = `
    <div class="detail-hero">
      <div class="thumb-box">
        ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${thumbHtml(item, 'thumb-hero', { play: false })}</a>` : thumbHtml(item, 'thumb-hero', { play: false })}
        ${playButtonHtml(item)}
      </div>
      <div class="hero-side">
        <div class="tag-row">
          ${(state.tags || []).map((t) => `<span class="tag${canEdit ? ' tag-edit' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}${canEdit ? '<i class="ti ti-x" aria-hidden="true"></i>' : ''}</span>`).join('')}
          ${canEdit ? '<button class="btn-ghost btn-tag-add" aria-label="タグを追加"><i class="ti ti-plus" aria-hidden="true"></i></button>' : ''}
        </div>
        ${canEdit ? '<button class="btn btn-primary btn-generate-all"><i class="ti ti-sparkles" aria-hidden="true"></i>すべて生成</button>' : ''}
      </div>
    </div>
    <nav class="tabs">
      ${tabs.map((t) => `<button class="tab ${t.id === tab ? 'on' : ''}" data-tab="${t.id}">${t.label}${state.tabHasContent(t.id) ? '' : '<i class="tab-empty" aria-hidden="true"></i>'}</button>`).join('')}
    </nav>
  `

  let panel
  if (state.phase === 'loading') {
    panel = '<p class="muted">読み込み中...</p>'
  } else if (state.phase === 'error') {
    panel = `<p class="error-text">${escapeHtml(state.message)}</p><button class="btn btn-retry">もう一度読み込む</button>`
  } else if (state.busyStage) {
    panel = `
      <div class="gen-progress">
        <p class="muted">${escapeHtml(state.busyLabel || '生成中')}</p>
        <pre class="gen-stream">${escapeHtml((state.busyText || '').slice(-1200))}</pre>
      </div>`
  } else {
    panel = renderPanel(item, state, tab, d, music)
  }

  const foot =
    tab === 'memo'
      ? `<span class="foot-note" id="memo-status">${state.memoDirty ? '未保存の変更があります' : ''}</span>
         <span class="grow"></span>
         <button class="btn btn-memo-save">メモを保存</button>`
      : tab === 'chat'
        ? `<div class="composer">
             <div class="composer-row">
               <div class="ctx-switch">
                 <button class="ctx-btn" data-ctx="summary">要約</button>
                 <button class="ctx-btn on" data-ctx="raw">原文</button>
               </div>
               <span class="foot-note" id="ctx-count"></span>
             </div>
             <div class="composer-row">
               <textarea id="chat-input" class="chat-input" rows="1" placeholder="この動画について質問する(Shift+Enterで改行)"></textarea>
               <button id="chat-send" class="btn btn-primary" aria-label="送信"><i class="ti ti-send" aria-hidden="true"></i></button>
             </div>
           </div>`
        : `${canEdit && stage ? `<button class="btn btn-regen" data-stage="${stage}"><i class="ti ti-refresh" aria-hidden="true"></i>この項目を作り直す</button>` : ''}
           ${canEdit && editable ? '<button class="btn btn-edit-field"><i class="ti ti-edit" aria-hidden="true"></i>手で直す</button>' : ''}
           ${tab === 'mindmap' && canEdit && state.tabHasContent('mindmap') ? mindmapToolsHtml(state.mindmapColor) : ''}
           <span class="grow"></span>
           ${tab === 'mindmap' && canEdit && state.tabHasContent('mindmap') ? publishButtonHtml(Boolean(d.isPublic ?? item.isPublic)) : ''}
           ${tab === 'mindmap' && state.tabHasContent('mindmap') ? '<button class="btn btn-mm-full"><i class="ti ti-arrows-maximize" aria-hidden="true"></i>大きく見る</button>' : ''}
           ${['summary', 'mindmap', 'fields', 'apply', 'ideas', 'raw'].includes(tab) ? '<button class="btn btn-copy"><i class="ti ti-copy" aria-hidden="true"></i>コピー</button>' : ''}`

  return `
    <div class="detail">
      ${markerToolbarHtml()}
      <div class="detail-fixed">${head}</div>
      <div class="detail-scroll detail-scroll-flush" id="detail-scroll">
        ${hero}
        <div class="detail-panel">${panel}</div>
      </div>
      <div class="detail-foot">${foot}</div>
    </div>
  `
}

function renderPanel(item, state, tab, d, music = false) {
  switch (tab) {
    case 'summary':
      if (music) return d.summary ? chaptersHtml(d.summary, item.url) : emptyPanel(item, 'チャプター', 'summary')
      return d.summary
        ? `<p class="prose"><span class="marker-target" ${addrAttrs('summary', 'whole')}>${renderMarkedHtml(
            d.summary,
            escapeHtml
          ).replace(/\n/g, '<br />')}</span></p>`
        : emptyPanel(item, 'サマリ', 'summary')
    case 'mindmap':
      return '<div id="mindmap-host" class="mindmap-host"></div>'
    case 'fields':
      if (music) {
        return d.fields
          ? `<p class="prose"><span class="marker-target" ${addrAttrs('fields', 'whole')}>${renderMarkedHtml(
              d.fields,
              escapeHtml
            ).replace(/\n/g, '<br />')}</span></p>`
          : emptyPanel(item, '概要', 'fields')
      }
      return d.fields
        ? sectionsHtml(d.fields, { videoUrl: item.url, field: 'fields' })
        : emptyPanel(item, '分野別要約', 'fields')
    case 'apply':
      return d.apply
        ? sectionsHtml(d.apply, { numbered: true, videoUrl: item.url, field: 'apply', publishable: state.canEdit, ranked: true })
        : emptyPanel(item, '応用', 'apply')
    case 'ideas':
      return d.ideas
        ? sectionsHtml(d.ideas, { videoUrl: item.url, field: 'ideas', publishable: state.canEdit, ranked: true })
        : emptyPanel(item, '活用アイデア', 'ideas')
    case 'memo':
      return `<textarea id="memo-input" class="memo-input" placeholder="気づいたこと、あとで試すこと、関連する話などを自由に">${escapeHtml(state.memoDraft ?? d.memo ?? '')}</textarea>`
    case 'chat':
      return '<div id="chat-log" class="chat-log"></div>'
    case 'raw':
      return state.transcript === null || state.transcript === undefined
        ? '<p class="muted">原文を読み込んでいます...</p>'
        : state.transcript
          ? transcriptHtml(state.transcript, item.url)
          : state.transcriptError
            ? `<p class="error-text">原文を取得できませんでした: ${escapeHtml(state.transcriptError)}</p>`
            : emptyRawHtml(d.rawCount || item.rawCount)
    default:
      return ''
  }
}

function emptyPanel(item, label, stage) {
  if (item.status === STATUS_NEW) {
    return `<p class="empty-section">${escapeHtml(label)}はまだありません。まず文字起こしが必要です(状態が「完了」になるまで待つ)</p>`
  }
  if (item.status === STATUS_DONE) {
    return `<p class="empty-section">${escapeHtml(label)}はまだありません。下の「この項目を作り直す」で生成できます</p>`
  }
  return `<p class="empty-section">${escapeHtml(label)}はまだありません</p>`
}

/** 原文タブの空表示。字数だけ残っているのは Notion のページ本文が消えている状態 */
function emptyRawHtml(rawCount) {
  if (rawCount) {
    return `<p class="empty-section">Notionのページ本文が空です(記録上は ${rawCount.toLocaleString()}字)。状態を「再取得」にすると取り込み直します</p>`
  }
  return '<p class="empty-section">原文がまだありません。状態が「完了」になるとここに入ります</p>'
}

// ============ アイデア一覧(横断して掘り起こす画面) ============

/**
 * 応用と活用アイデアを動画をまたいで1本のフィードにする。
 * 動画単位で見ていると「あの話、何かに使えそう」で終わってしまうため、
 * アイデア側から入って動画に戻れる導線を作るのがこの画面の役目。
 */
export function renderIdeas(container, entries, state, handlers) {
  if (state.phase === 'loading') {
    container.innerHTML = '<p class="muted">アイデアを集めています...</p>'
    return
  }
  if (state.phase === 'error') {
    container.innerHTML = `<p class="error-text">${escapeHtml(state.message)}</p><button class="btn btn-retry">もう一度読み込む</button>`
    return
  }
  if (!entries.length) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-bulb" aria-hidden="true"></i>
        <p>まだアイデアがありません</p>
        <p class="empty-hint">ライブラリで動画を開いて「すべて生成」すると、ここに応用と活用アイデアが集まります</p>
      </div>`
    return
  }

  const selected = state.selected || new Set()
  const bulkHtml = state.canEdit && selected.size
    ? `<div class="idea-bulk">
         <span class="idea-bulk-count">${selected.size}件選択</span>
         <span class="rank">${[1, 2, 3]
           .map((n) => `<button class="star bulk-star" data-rank="${n}" aria-label="星${n}をまとめて付ける">★</button>`)
           .join('')}</span>
         <button class="btn btn-bulk-clear">★を外す</button>
         <button class="btn btn-bulk-cancel">選択解除</button>
       </div>`
    : ''

  container.innerHTML = `
    <div class="idea-toolbar">
      <div class="seg">
        <button class="seg-btn ${state.kind === 'all' ? 'on' : ''}" data-kind="all">すべて</button>
        <button class="seg-btn ${state.kind === 'apply' ? 'on' : ''}" data-kind="apply">ビジネス</button>
        <button class="seg-btn ${state.kind === 'ideas' ? 'on' : ''}" data-kind="ideas">面白い活用</button>
      </div>
      <button class="btn btn-shuffle"><i class="ti ti-dice" aria-hidden="true"></i>掘り起こす</button>
      ${bulkHtml}
    </div>
    <div class="idea-feed">
      ${entries
        .map((e) => {
          const body = e.body ? `<p class="idea-body">${escapeHtml(plainTextOf(e.body))}</p>` : ''
          const points = e.points.length
            ? `<ul class="sec-points">${e.points.map((p) => `<li>${escapeHtml(plainTextOf(splitLabel(p).text))}</li>`).join('')}</ul>`
            : ''
          return `
        <article class="idea ${selected.has(e.id) ? 'selected' : ''}" data-key="${escapeHtml(e.key)}" data-kind="${e.kind}" data-sec="${e.sec}" data-id="${escapeHtml(e.id)}">
          <div class="idea-kind ${e.kind}">
            ${state.canEdit ? `<input type="checkbox" class="idea-select" ${selected.has(e.id) ? 'checked' : ''} aria-label="このアイデアを選ぶ" />` : ''}
            ${e.kind === 'apply' ? 'ビジネス' : '活用'}${rankHtml(e.sec, e.rank, state.canEdit)}
          </div>
          ${state.canEdit ? hideButtonHtml('idea-hide') : ''}
          <button class="idea-toggle" aria-expanded="false" ${body || points ? '' : 'disabled'}>
            <h4 class="idea-title">${escapeHtml(plainTextOf(e.heading))}</h4>
            ${body || points ? '<i class="ti ti-chevron-down idea-caret" aria-hidden="true"></i>' : ''}
          </button>
          <div class="idea-detail"><div class="idea-detail-inner">${body}${points}</div></div>
          <button class="idea-source">
            <i class="ti ti-movie" aria-hidden="true"></i>${escapeHtml(e.videoTitle)}
          </button>
        </article>`
        })
        .join('')}
    </div>
  `

  container.querySelectorAll('.seg-btn').forEach((el) => {
    el.addEventListener('click', () => handlers.onKind(el.dataset.kind))
  })
  container.querySelector('.btn-shuffle')?.addEventListener('click', handlers.onShuffle)
  container.querySelectorAll('.idea-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const open = btn.closest('.idea').classList.toggle('open')
      btn.setAttribute('aria-expanded', String(open))
    })
  })
  container.querySelectorAll('.idea-source').forEach((el) => {
    el.addEventListener('click', () => handlers.onOpen(el.closest('.idea').dataset.key))
  })
  container.querySelectorAll('.idea .rank button.star').forEach((btn) => {
    const idea = btn.closest('.idea')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      handlers.onRank(idea.dataset.key, idea.dataset.kind, Number(idea.dataset.sec), Number(btn.dataset.rank))
    })
  })
  container.querySelectorAll('.btn-hide').forEach((btn) => {
    const idea = btn.closest('.idea')
    btn.addEventListener('click', () => handlers.onHide(idea.dataset.key, idea.dataset.kind, Number(idea.dataset.sec)))
  })
  container.querySelectorAll('.idea-select').forEach((el) => {
    el.addEventListener('change', () => handlers.onSelect(el.closest('.idea').dataset.id, el.checked))
  })
  container.querySelectorAll('.bulk-star').forEach((btn) => {
    btn.addEventListener('click', () => handlers.onBulkRank(Number(btn.dataset.rank)))
  })
  container.querySelector('.btn-bulk-clear')?.addEventListener('click', () => handlers.onBulkRank(0))
  container.querySelector('.btn-bulk-cancel')?.addEventListener('click', handlers.onClearSelect)
  if (state.canEdit) bindMarquee(container.querySelector('.idea-feed'), handlers)
}

/**
 * カードの上をマウスでなぞって範囲選択する。
 * 枠はclient座標のまま body に置く(フィード自身に置くとスクロール量の補正が要る)。
 * 5px動くまではドラッグと見なさないので、カードのクリックはそのまま通る。
 */
function bindMarquee(feed, handlers) {
  if (!feed) return

  feed.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, a, input')) return
    const startX = e.clientX
    const startY = e.clientY
    let box = null

    const areaOf = (x, y) => ({
      left: Math.min(startX, x),
      top: Math.min(startY, y),
      right: Math.max(startX, x),
      bottom: Math.max(startY, y),
    })

    const move = (ev) => {
      if (!box && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      if (!box) {
        box = document.createElement('div')
        box.className = 'marquee'
        document.body.appendChild(box)
        feed.classList.add('selecting')
      }
      ev.preventDefault()
      const a = areaOf(ev.clientX, ev.clientY)
      box.style.left = `${a.left}px`
      box.style.top = `${a.top}px`
      box.style.width = `${a.right - a.left}px`
      box.style.height = `${a.bottom - a.top}px`
      feed.querySelectorAll('.idea').forEach((el) => {
        const r = el.getBoundingClientRect()
        const hit = r.left < a.right && r.right > a.left && r.top < a.bottom && r.bottom > a.top
        el.classList.toggle('marquee-hit', hit)
      })
    }

    const up = (ev) => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      if (!box) return
      box.remove()
      feed.classList.remove('selecting')
      const hits = [...feed.querySelectorAll('.idea.marquee-hit')]
      hits.forEach((el) => el.classList.remove('marquee-hit'))
      handlers.onSelectMany(hits.map((el) => el.dataset.id), ev.shiftKey || ev.ctrlKey || ev.metaKey)
    }

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  })
}

/** listIdeas の結果を1件1アイデアのフィード用配列に展開する */
export function flattenIdeas(items) {
  const out = []
  items.forEach((v) => {
    ;['apply', 'ideas'].forEach((kind) => {
      parseSections(v[kind]).forEach((s, i) => {
        out.push({
          key: v.key,
          source: v.source,
          videoTitle: v.title,
          tags: v.tags || [],
          kind,
          sec: i,
          isPublic: !isSectionHidden(s.heading),
          rank: sectionRank(s.heading),
          heading: visibleHeading(s.heading) || '(無題)',
          body: s.body,
          points: s.points,
          id: `${v.key}:${kind}:${i}`,
        })
      })
    })
  })
  return out
}
