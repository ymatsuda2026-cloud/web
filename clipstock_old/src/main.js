import {
  escapeHtml,
  renderTagRail,
  renderLibrary,
  detailHtml,
  renderIdeas,
  renderMindmapGallery,
  flattenIdeas,
  tabsOf,
} from './ui/render.js'
import { openSettings, openEditor } from './ui/settings.js'
import { openSetup } from './ui/setup.js'
import { openVocabPanel } from './ui/vocab.js'
import { openMiniPlayer, seekTargetOf } from './ui/player.js'
import { renderRecords } from './ui/records.js'
import { renderNotes } from './ui/notes.js'
import {
  fetchDetail,
  fetchTranscript,
  saveGenerated,
  saveField,
  saveMemo,
  saveTags,
  saveTitle,
  saveCategory,
  setStatus,
  setPublic,
  updateRawCount,
  mergeTag,
  deleteVideo,
  registerPageSources,
  requestRebuildNow,
} from './lib/gas.js'
import { listVideos, listIdeas } from './lib/store.js'
import { loadConfig, isConfigured, canEdit, syncConfigFromJsonbin } from './lib/videos-config.js'
import { loadSettings, saveSettings, activeModelName, allModels, connectionOf } from './lib/llm-settings.js'
import { initPrompts } from './lib/prompts.js'
import { initSpaces, activeSpace, spaceList, sourcesOf, spaceHref, spaceMode } from './lib/spaces.js'
import { generateAll, generateStage, needsTranscript, stagesOf } from './lib/generate.js'
import { renderMindmap, markNodeLine, nodeMarkerOf } from './lib/mindmap.js'
import { hasTimecodes } from './lib/timecode.js'
import { applyMarkerRange, eraseMarkerRange, plainTextOf, reconcileMarkers, MARKER_COLORS } from './lib/markers.js'
import { addrOf, getMarkedText, setMarkedText, stripMarkers } from './lib/marker-target.js'
import {
  parseSections,
  isSectionHidden,
  visibleHeading,
  sectionRank,
  setSectionHidden,
  setSectionHiddenByHeading,
  setSectionRank,
  setSectionRankByHeading,
} from './lib/sections.js'
import { getDetailCache, setDetailCache, clearDetailCache, isCacheFresh, markSeen, isSeen, isFavorite, toggleFavorite } from './lib/cache.js'
import {
  excludeExcluded,
  filterByStatus,
  filterByTags,
  filterBySearch,
  filterBySource,
  sourceCounts,
  buildTagOptions,
  statusCounts,
  STATUS_ORDER,
  STATUS_DONE,
  STATUS_RETRY,
  STATUS_SUMMARIZED,
  STATUS_EXCLUDED,
} from './lib/filters.js'
import { knownTagsOf } from './lib/tags.js'
import { beginView, endView, pingView, recordSummary, isDone, toggleDone } from './lib/records.js'
import { collectNotes, filterNotes, notesMarkdown, noteSourceCounts, stampNotes } from './lib/notes.js'
import { loadDismissed, dismissPair, clearDismissed } from './lib/vocab.js'
import { streamChat } from './lib/llm-client.js'
import {
  loadChat,
  saveChat,
  renderQA,
  wireComposer,
  loadSpaces,
  saveSpaces,
  newSpace,
  MAX_CROSS_ITEMS,
  WARN_CHARS,
} from './lib/chat.js'

const $ = (id) => document.getElementById(id)
const stageEl = $('stage')
const railEl = $('tag-rail')
const syncEl = $('sync-status')

// ---- アプリの状態 ----
let items = []
// 表示中の一覧がいつ時点のものか。設定画面でJSONを見せるときに使う
let listMeta = { generatedAt: null }
let view = 'library' // 'library' | 'favorites' | 'detail' | 'ideas' | 'mindmaps' | 'notes' | 'records' | 'crosschat'
let selectedKey = null
// 詳細を開く直前の一覧スクロール位置。戻ったときに復元する
let libraryScrollTop = 0
let searchQuery = ''
let showTags = true
const selectedStatuses = new Set()
const selectedTags = new Set()
// 取り込み元(動画DB / web記事DB)の絞り込み。空なら全部出す
const selectedSources = new Set()

// 詳細画面の状態。動画を切り替えるたび作り直す
let detail = null

// ノート画面の絞り込み。種別(取り込み元)は上のチップと共通
const notesState = { colors: new Set(), period: 'all', itemKey: null, query: '' }

// アイデア一覧の状態
const ideasState = { phase: 'idle', items: [], kind: 'all', shuffleSeed: 0, message: '', selected: new Set() }

// ============ 一覧の取得 ============

async function loadList() {
  const config = loadConfig()
  syncEl.textContent = '読み込み中...'
  try {
    const data = await listVideos()
    items = data.items
    listMeta = { generatedAt: data.fetchedAt || null }
    syncEl.textContent = `${items.length}件${sourceNote(data)}`
  } catch (err) {
    items = []
    syncEl.textContent = ''
    stageEl.innerHTML = !isConfigured(config)
      ? `
      <div class="empty-state">
        <i class="ti ti-plug-connected-x" aria-hidden="true"></i>
        <p>まず接続の設定が必要です</p>
        <p class="empty-hint">右上の歯車から GAS URL と共有トークンを入れるか、JSONBinから設定を読み込んでください</p>
      </div>`
      : `
      <div class="empty-state">
        <i class="ti ti-alert-triangle" aria-hidden="true"></i>
        <p>一覧を取得できませんでした</p>
        <p class="empty-hint">${escapeHtml(String(err.message || err))}</p>
      </div>`
    return
  }
  refresh()
}

/** 表示内容がいつ時点のものかを出す。JSONは cron が書き出した時刻で止まっている */
function sourceNote(data) {
  if (data.source !== 'json') return ''
  if (!data.fetchedAt) return ' ・JSON'
  const d = new Date(data.fetchedAt)
  return ` ・JSON ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「除外」を外し、取り込み元で絞った、この端末で見る対象の全件 */
function visibleItems() {
  return filterBySource(excludeExcluded(items), selectedSources)
}

function currentItems() {
  const byStatus = filterByStatus(visibleItems(), selectedStatuses)
  const bySearch = filterBySearch(byStatus, searchQuery)
  return filterByTags(bySearch, selectedTags)
}

function itemOf(key) {
  return items.find((i) => i.key === key)
}

// ============ 画面の描画 ============

function refresh() {
  paintStatusChips()
  paintSourceChips()
  paintActiveModel()

  // 詳細・横断チャットは内側でスクロールさせるので、外側のスクロールは切る
  stageEl.classList.toggle('no-scroll', view === 'detail' || view === 'crosschat')

  if (view === 'detail') {
    railEl.innerHTML = ''
    paintDetail()
    return
  }
  if (view === 'crosschat') {
    railEl.innerHTML = ''
    paintCrossChat()
    return
  }
  if (view === 'records') {
    railEl.innerHTML = ''
    paintRecords()
    return
  }
  if (view === 'notes') {
    railEl.innerHTML = ''
    paintNotes()
    return
  }

  const base = filterBySearch(filterByStatus(visibleItems(), selectedStatuses), searchQuery)
  renderTagRail(railEl, { tagOptions: buildTagOptions(base, selectedTags), selectedTags }, {
    onToggleTag: (tag) => {
      selectedTags.has(tag) ? selectedTags.delete(tag) : selectedTags.add(tag)
      refresh()
    },
    onClearTags: () => {
      selectedTags.clear()
      refresh()
    },
  })

  if (view === 'ideas') {
    paintIdeas()
    return
  }

  if (view === 'mindmaps') {
    paintMindmaps()
    return
  }

  if (view === 'favorites') {
    renderLibrary(
      stageEl,
      currentItems().filter((i) => isFavorite(i.key)),
      {
        searchQuery,
        showTags,
        seen: isSeen,
        favorite: isFavorite,
        canEdit: canEdit(loadConfig()),
        emptyState: {
          icon: 'ti-star',
          text: 'お気に入りはまだありません',
          hint: 'カードの星アイコンを押すと、ここに集まります(この端末だけの印です)',
        },
      },
      { onOpen: openDetail, onEdit: openCardEditor, onDelete: deleteCard, onToggleFavorite: onToggleFavoriteCard }
    )
    return
  }

  renderLibrary(
    stageEl,
    currentItems(),
    { searchQuery, showTags, seen: isSeen, favorite: isFavorite, canEdit: canEdit(loadConfig()) },
    { onOpen: openDetail, onEdit: openCardEditor, onDelete: deleteCard, onToggleFavorite: onToggleFavoriteCard }
  )
}

/** カード上の星ボタン。押した瞬間にその場で見た目を変え、一覧全体は作り直さない */
function onToggleFavoriteCard(key) {
  const fav = toggleFavorite(key)
  const btn = stageEl.querySelector(`.card-fav[data-key="${CSS.escape(key)}"]`)
  if (btn) {
    btn.classList.toggle('on', fav)
    btn.setAttribute('aria-pressed', String(fav))
    btn.setAttribute('aria-label', fav ? 'お気に入りから外す' : 'お気に入りに追加')
  }
  // お気に入りタブで外したときは、その場でカードごと消す
  if (view === 'favorites' && !fav) refresh()
}

/** 設定モーダルに渡す、いま画面に出ている一覧JSON(index-video.json / index-web.json と同じ形) */
function listJsonContext() {
  return {
    json: () => JSON.stringify({ generatedAt: listMeta.generatedAt, items }, null, 2),
    onApply: (parsed) => {
      items = parsed.items
      registerPageSources(items)
      listMeta = { generatedAt: parsed.generatedAt || null }
      syncEl.textContent = `${items.length}件 ・貼り付け`
      ideasState.phase = 'idle'
      refresh()
    },
  }
}

// ============ カードの編集 ============

/** 一覧からその場で消す。Notionではゴミ箱なので30日間は復元できる */
async function deleteCard(key) {
  const item = itemOf(key)
  if (!item) return
  if (!confirm(`「${item.title}」をNotionのゴミ箱へ移します。このアプリからは戻せません。続けますか?`)) return
  try {
    await deleteVideo(key)
    clearDetailCache(key)
    items = items.filter((i) => i.key !== key)
    ideasState.phase = 'idle' // 一覧JSONは次のcronまで古いままなので手元だけ先に揃える
    refresh()
  } catch (err) {
    alert('削除できませんでした: ' + (err.message || err))
  }
}

/**
 * 一覧のカードから直接直す。詳細を開かずに直せるようにするためのもので、
 * 変更した項目だけを Notion に投げる(触っていない項目の更新日時を動かさない)。
 */
function openCardEditor(key) {
  const item = itemOf(key)
  if (!item) return

  let tags = [...(item.tags || [])]
  const known = knownTagsOf(items)
  const statuses = [...new Set([...STATUS_ORDER, STATUS_EXCLUDED, item.status].filter(Boolean))]
  // いま使われている分類。表記ゆれで別グループにならないよう、まず選ばせる
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))
  const root = $('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal modal-sticky">
        <h2 class="modal-title">カードの情報を直す</h2>
        <div class="modal-body">
          <label class="field-label">タイトル</label>
          <input id="ce-title" class="input" value="${escapeHtml(item.title || '')}" />

          <label class="field-label">分類</label>
          <input id="ce-category" class="input" list="ce-category-list" placeholder="空欄なら分類なし" value="${escapeHtml(item.category || '')}" />
          <datalist id="ce-category-list">
            ${categories.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}
          </datalist>
          <div class="foot-note">一覧JSONの分かれ先が変わります。反映は次回の作り直しのあとです</div>

          <label class="field-label">状態</label>
          <select id="ce-status" class="input">
            ${statuses.map((s) => `<option value="${escapeHtml(s)}" ${s === item.status ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>

          <label class="field-label">タグ</label>
          <div id="ce-tags" class="tag-row"></div>
          <div class="row">
            <input id="ce-tag-new" class="input sm grow" placeholder="タグを追加" />
            <button id="ce-tag-add" class="btn">追加</button>
          </div>
          ${known.length ? `<div id="ce-tag-known" class="tag-row picker"></div>` : ''}

          <label class="field-label">要約</label>
          <textarea id="ce-summary" class="input" rows="10">${escapeHtml(plainTextOf(item.summary || ''))}</textarea>
          <div class="foot-note">変更した項目だけ Notion に書き戻します</div>
        </div>
        <div class="modal-foot">
          <span id="ce-msg" class="foot-note grow"></span>
          <button id="ce-cancel" class="btn">キャンセル</button>
          <button id="ce-save" class="btn btn-primary">保存</button>
        </div>
      </div>
    </div>
  `

  function paintTags() {
    $('ce-tags').innerHTML = tags.length
      ? tags.map((t) => `<span class="tag tag-edit" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<i class="ti ti-x" aria-hidden="true"></i></span>`).join('')
      : '<span class="muted">タグなし</span>'
    $('ce-tags').querySelectorAll('.tag-edit i').forEach((x) =>
      x.addEventListener('click', () => {
        tags = tags.filter((t) => t !== x.parentElement.dataset.tag)
        paintTags()
      })
    )
    const pick = $('ce-tag-known')
    if (!pick) return
    pick.innerHTML = known
      .map((t) => `<button class="chip ${tags.includes(t) ? 'on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
      .join('')
    pick.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        const t = chip.dataset.tag
        tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]
        paintTags()
      })
    )
  }
  paintTags()

  const addTagFromInput = () => {
    const name = $('ce-tag-new').value.trim()
    if (name && !tags.includes(name)) tags = [...tags, name]
    $('ce-tag-new').value = ''
    paintTags()
  }
  $('ce-tag-add').addEventListener('click', addTagFromInput)
  $('ce-tag-new').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    addTagFromInput()
  })

  $('ce-cancel').addEventListener('click', () => (root.innerHTML = ''))

  $('ce-save').addEventListener('click', async () => {
    const title = $('ce-title').value.trim()
    const status = $('ce-status').value
    const category = $('ce-category').value.trim()
    // マーカーは画面に出していないので、文言が一致する範囲だけ引き継ぐ
    const summary = reconcileMarkers(item.summary || '', $('ce-summary').value)
    if (!title) {
      $('ce-msg').innerHTML = '<span class="error-text">タイトルは空にできません</span>'
      return
    }

    const btn = $('ce-save')
    btn.disabled = true
    $('ce-msg').textContent = '保存中...'
    try {
      if (title !== item.title) {
        await saveTitle(key, title)
        item.title = title
      }
      if (summary !== (item.summary || '')) {
        await saveField(key, 'summary', summary)
        item.summary = summary
        item.has = { ...(item.has || {}), summary: Boolean(summary) }
      }
      if (tags.join('\u0000') !== (item.tags || []).join('\u0000')) {
        await saveTags(key, tags)
        item.tags = tags
      }
      if (status !== item.status) {
        await setStatus(key, status)
        item.status = status
      }
      if (category !== (item.category || '')) {
        await saveCategory(key, category)
        item.category = category
      }
      // 詳細のキャッシュは古くなる。開いたときに取り直させる
      clearDetailCache(key)
      ideasState.phase = 'idle'
      root.innerHTML = ''
      refresh()
    } catch (err) {
      btn.disabled = false
      $('ce-msg').innerHTML = `<span class="error-text">${escapeHtml(String(err.message || err))}</span>`
    }
  })
}

function paintStatusChips() {
  const counts = statusCounts(visibleItems())
  const el = $('status-filter')
  el.innerHTML = STATUS_ORDER.map(
    (s) => `<button class="chip ${selectedStatuses.has(s) ? 'on' : ''}" data-status="${escapeHtml(s)}">
      ${escapeHtml(s)}<span class="chip-count">${counts.get(s) || 0}</span>
    </button>`
  ).join('')
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const s = chip.dataset.status
      selectedStatuses.has(s) ? selectedStatuses.delete(s) : selectedStatuses.add(s)
      refresh()
    })
  })
}

/** 取り込み元の絞り込み。件数は「除外」を外した全件から数える(自分自身の絞りは効かせない) */
function paintSourceChips() {
  const counts = sourceCounts(excludeExcluded(items))
  const shown = sourcesOf().filter((s) => counts.get(s.id))
  const el = $('source-filter')
  // 片方しか無いなら絞る意味が無い
  if (shown.length < 2) {
    el.innerHTML = ''
    return
  }
  el.innerHTML = shown
    .map(
      (s) => `<button class="chip ${selectedSources.has(s.id) ? 'on' : ''}" data-source="${s.id}">
        ${escapeHtml(s.label)}<span class="chip-count">${counts.get(s.id)}</span>
      </button>`
    )
    .join('')
  el.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const s = chip.dataset.source
      selectedSources.has(s) ? selectedSources.delete(s) : selectedSources.add(s)
      refresh()
    })
  })
}

function paintActiveModel() {
  const model = activeModelName(loadSettings())
  $('active-model').textContent = model ? `AI: ${model}` : 'AI未設定'
}

function setView(next) {
  const from = view
  if (next !== 'detail') endView()
  view = next
  selectedKey = view === 'detail' ? selectedKey : null
  document.querySelectorAll('.viewtab').forEach((t) => t.classList.toggle('on', t.dataset.view === next))
  refresh()
  // 詳細から一覧に戻ったときだけ、開く前のスクロール位置を戻す
  if (from === 'detail' && next === 'library') stageEl.scrollTop = libraryScrollTop
}

// ============ 詳細 ============

async function openDetail(key) {
  const item = itemOf(key)
  if (!item) return
  if (view === 'library') libraryScrollTop = stageEl.scrollTop
  selectedKey = key
  view = 'detail'
  transcriptInFlight = null
  markSeen(key)
  beginView(item)

  detail = {
    phase: 'loading',
    detail: null,
    tags: item.tags || [],
    activeTab: 'summary',
    mode: spaceMode(),
    transcript: undefined, // undefined=未取得 / null=取得中 / string=取得済み
    mindmapColor: 1, // 枝をクリックしたときに塗る色。null なら消しゴム
    memoDraft: null,
    memoDirty: false,
    busyStage: null,
    busyLabel: '',
    busyText: '',
    message: '',
    canEdit: canEdit(loadConfig()),
  }
  refresh()

  // キャッシュが Notion の更新より新しければそれを使う
  const cached = getDetailCache(key)
  if (isCacheFresh(cached, item.editedAt)) {
    detail.detail = cached
    detail.tags = cached.tags || item.tags || []
    detail.phase = 'ready'
    paintDetail()
    return
  }

  try {
    const d = await fetchDetail(key)
    if (selectedKey !== key) return
    setDetailCache(key, d)
    detail.detail = d
    detail.tags = d.tags || []
    detail.phase = 'ready'
  } catch (err) {
    detail.phase = 'error'
    detail.message = String(err.message || err)
  }
  paintDetail()
}

function tabHasContent(id) {
  const d = detail?.detail || {}
  if (id === 'chat') return loadChat(selectedKey).length > 0
  if (id === 'raw') return Boolean(itemOf(selectedKey)?.rawCount)
  if (id === 'memo') return Boolean(detail?.memoDraft || d.memo)
  return Boolean(d[id])
}

function paintDetail() {
  const item = itemOf(selectedKey)
  if (!item) {
    setView('library')
    return
  }
  stageEl.innerHTML = detailHtml(item, { ...detail, tabHasContent, favorite: isFavorite(item.key), done: isDone(item.key) })
  wireDetail(item)
}

function switchTab(id) {
  detail.activeTab = id
  paintDetail()
}

function wireDetail(item) {
  stageEl.querySelector('.btn-back')?.addEventListener('click', () => setView('library'))
  stageEl.querySelector('.btn-fav')?.addEventListener('click', (e) => {
    const fav = toggleFavorite(item.key)
    const btn = e.currentTarget
    btn.classList.toggle('on', fav)
    btn.setAttribute('aria-pressed', String(fav))
    btn.setAttribute('aria-label', fav ? 'お気に入りから外す' : 'お気に入りに追加')
  })
  stageEl.querySelector('.btn-done')?.addEventListener('click', (e) => {
    const done = toggleDone(item)
    const btn = e.currentTarget
    btn.classList.toggle('on', done)
    btn.setAttribute('aria-pressed', String(done))
    btn.setAttribute('aria-label', done ? '見終わった印を外す' : '見終わったことにする')
  })
  stageEl.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)))
  stageEl.querySelector('.btn-retry')?.addEventListener('click', () => openDetail(item.key))
  stageEl.querySelector('.btn-generate-all')?.addEventListener('click', () => runGenerateAll(item))
  stageEl.querySelector('.btn-regen')?.addEventListener('click', (e) => runStage(item, e.currentTarget.dataset.stage))
  stageEl.querySelector('.btn-edit-field')?.addEventListener('click', () => editCurrentField(item))
  stageEl.querySelector('.btn-more')?.addEventListener('click', (e) => openMoreMenu(e.currentTarget, item))
  stageEl.querySelector('.btn-tag-add')?.addEventListener('click', () => addTag(item))
  stageEl.querySelector('.btn-copy')?.addEventListener('click', () => copyCurrentTab())
  stageEl.querySelector('.btn-mm-full')?.addEventListener('click', () => openMindmapFull())
  stageEl.querySelector('.btn-publish')?.addEventListener('click', (e) => togglePublic(item, e.currentTarget))
  stageEl.querySelectorAll('.mm-swatch').forEach((el) =>
    el.addEventListener('click', () => {
      detail.mindmapColor = Number(el.dataset.color) || null
      // 塗り替えだけなので、マップを描き直して表示位置を戻さないよう手で付け替える
      stageEl.querySelectorAll('.mm-swatch').forEach((b) => b.classList.toggle('on', b === el))
    })
  )
  stageEl.querySelectorAll('.sec-publish').forEach((btn) =>
    btn.addEventListener('click', () =>
      toggleSectionPublic(item, detail.activeTab, Number(btn.dataset.sec), btn.getAttribute('aria-pressed') !== 'true')
    )
  )
  stageEl.querySelectorAll('.rank .star[data-sec]').forEach((btn) =>
    btn.addEventListener('click', () =>
      changeSectionRank(item, detail.activeTab, Number(btn.dataset.sec), Number(btn.dataset.rank))
    )
  )
  stageEl.querySelectorAll('.tag-edit i').forEach((x) =>
    x.addEventListener('click', (e) => removeTag(item, e.target.closest('.tag').dataset.tag))
  )

  if (detail.phase !== 'ready' || detail.busyStage) return

  setupMarkers(item)

  if (detail.activeTab === 'mindmap') {
    const host = stageEl.querySelector('#mindmap-host')
    if (host) {
      renderMindmap(host, detail.detail?.mindmap, item.url, {
        onNodeClick: detail.canEdit ? (index, el) => commitNodeMarker(item, index, el) : null,
        onChange: detail.canEdit ? (markdown) => saveMindmapEdit(item, markdown) : null,
      })
    }
  }
  if (detail.activeTab === 'memo') setupMemo(item)
  if (detail.activeTab === 'chat') setupChat(item)
  if (detail.activeTab === 'raw') ensureTranscript(item)
}

// ---- タブごとの仕込み ----

function setupMemo(item) {
  const input = stageEl.querySelector('#memo-input')
  const saveBtn = stageEl.querySelector('.btn-memo-save')
  if (!input || !saveBtn) return
  input.addEventListener('input', () => {
    detail.memoDraft = input.value
    const dirty = input.value !== (detail.detail?.memo ?? '')
    if (dirty !== detail.memoDirty) {
      detail.memoDirty = dirty
      $('memo-status').textContent = dirty ? '未保存の変更があります' : ''
    }
  })
  saveBtn.addEventListener('click', async () => {
    const value = input.value
    saveBtn.disabled = true
    saveBtn.textContent = '保存中...'
    try {
      await saveMemo(item.key, value)
      detail.detail = { ...detail.detail, memo: value }
      setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
      detail.memoDraft = value
      detail.memoDirty = false
      item.has = { ...(item.has || {}), memo: Boolean(value) }
      saveBtn.textContent = '保存しました'
      $('memo-status').textContent = ''
      setTimeout(() => {
        saveBtn.textContent = 'メモを保存'
        saveBtn.disabled = false
      }, 1200)
    } catch (err) {
      alert('保存できませんでした: ' + (err.message || err))
      saveBtn.textContent = 'メモを保存'
      saveBtn.disabled = false
    }
  })
}

let transcriptInFlight = null

async function ensureTranscript(item) {
  if (typeof detail.transcript === 'string') return detail.transcript
  if (transcriptInFlight) return transcriptInFlight
  detail.transcript = null
  transcriptInFlight = (async () => {
    try {
      const { text } = await fetchTranscript(item.key)
      detail.transcript = text
      detail.transcriptError = ''
      if (!item.rawCount && text.length) {
        item.rawCount = text.length
        updateRawCount(item.key, text.length).catch(() => {})
      }
    } catch (err) {
      detail.transcript = ''
      detail.transcriptError = String(err.message || err)
      console.error('原文の取得に失敗しました:', err)
    }
    transcriptInFlight = null
    if (detail.activeTab === 'raw' && !detail.busyStage) paintDetail()
    return detail.transcript
  })()
  return transcriptInFlight
}

/** 要約タブ相当のテキスト。チャットの軽いコンテキスト用 */
/** チャットや横断チャットに渡す文脈。マーカーのタグは必ず落とす */
function summaryContext(d) {
  return ['# サマリ', d.summary || '', '', '# 分野別要約', d.fields || '', '', '# 応用', d.apply || '']
    .map(stripMarkers)
    .join('\n')
    .trim()
}

function setupChat(item) {
  const logEl = stageEl.querySelector('#chat-log')
  const inputEl = stageEl.querySelector('#chat-input')
  const sendBtn = stageEl.querySelector('#chat-send')
  const countEl = stageEl.querySelector('#ctx-count')
  if (!logEl || !inputEl || !sendBtn) return

  const messages = loadChat(item.key)
  renderQA(logEl, messages, item.url)

  let ctxMode = 'raw'
  let busy = false

  function paintCount() {
    const sum = summaryContext(detail.detail || {}).length
    const raw = typeof detail.transcript === 'string' ? detail.transcript.length : item.rawCount || 0
    countEl.textContent = `要約 約${sum.toLocaleString()}字 ／ 原文 ${raw ? `約${raw.toLocaleString()}字` : '未取得'}`
  }
  paintCount()

  stageEl.querySelectorAll('.ctx-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      ctxMode = btn.dataset.ctx
      stageEl.querySelectorAll('.ctx-btn').forEach((b) => b.classList.toggle('on', b === btn))
    })
  })

  wireComposer(inputEl, sendBtn, async () => {
    if (busy) return
    const text = inputEl.value.trim()
    if (!text) return
    inputEl.value = ''
    inputEl.style.height = 'auto'

    messages.push({ role: 'user', content: text })
    saveChat(item.key, messages)
    renderQA(logEl, messages, item.url)

    const connection = connectionOf(loadSettings())
    if (!connection) {
      messages.push({ role: 'assistant', content: 'AI接続が未設定です。設定から接続先とモデルを追加してください。' })
      saveChat(item.key, messages)
      renderQA(logEl, messages, item.url)
      return
    }

    busy = true
    // 本文取得より先にプレースホルダーを積んで「考え中」を即座に見せる
    messages.push({ role: 'assistant', content: '' })
    renderQA(logEl, messages, item.url)

    try {
      let context
      if (ctxMode === 'summary') {
        context = summaryContext(detail.detail || {})
      } else {
        context = (await ensureTranscript(item)) || summaryContext(detail.detail || {})
        paintCount()
      }

      // 原文にタイムスタンプがあるときだけ引用元の時刻を添えさせる。
      // 時刻の無い原文で頼むと、それらしい数字を作られるだけになる
      const citeRule = hasTimecodes(context)
        ? `
根拠になった箇所には、原文にあるタイムスタンプを [12:34] の形でそのまま添えてください。
原文に無い時刻を書いてはいけません。該当が分からなければ時刻は書かないでください。`
        : ''

      const system = `あなたは動画の内容について質問に答えるアシスタントです。
以下は「${item.title}」の${ctxMode === 'summary' ? '要約' : '文字起こし全文'}です。この内容の範囲で答え、書かれていないことは「分かりません」と答えてください。
Markdown(見出し・箇条書き・強調)を使って読みやすく整理して構いません。日本語で回答してください。${citeRule}

${context.slice(0, 30000)}`

      let full = ''
      for await (const chunk of streamChat(connection, [
        { role: 'system', content: system },
        ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      ])) {
        if (chunk.delta) {
          full += chunk.delta
          messages[messages.length - 1].content = full
          renderQA(logEl, messages, item.url)
        }
      }
      if (!full) messages[messages.length - 1].content = '(応答がありませんでした)'
    } catch (err) {
      messages[messages.length - 1].content = 'エラーが発生しました: ' + (err.message || err)
    }
    saveChat(item.key, messages)
    renderQA(logEl, messages, item.url)
    busy = false
  })
}


// ============ マーカー ============
//
// マーカーは本文の文字列に <m1>…</m1> として埋め込まれ、既存のテキスト
// プロパティにそのまま保存される。座標を別に持たないので、あとから本文を
// 編集しても位置がずれて壊れることがない。

let markerCtx = null
let markerDocBound = false

function setupMarkers(item) {
  const toolbar = stageEl.querySelector('#marker-toolbar')
  const targets = stageEl.querySelectorAll('.marker-target')
  if (!toolbar || !targets.length) {
    markerCtx = null
    return
  }
  markerCtx = { item, toolbar, pending: null }

  toolbar.querySelectorAll('.marker-swatch').forEach((el) =>
    el.addEventListener('click', () => commitMarker(Number(el.dataset.color)))
  )
  toolbar.querySelector('.marker-erase')?.addEventListener('click', () => commitMarker(null))

  targets.forEach((el) => {
    const handler = () => onMarkerSelect(el)
    el.addEventListener('mouseup', handler)
    el.addEventListener('touchend', handler)
  })

  if (!markerDocBound) {
    markerDocBound = true
    document.addEventListener('click', (e) => {
      if (!markerCtx) return
      if (markerCtx.toolbar.contains(e.target)) return
      if (e.target.closest?.('.marker-target')) return
      markerCtx.toolbar.style.display = 'none'
    })
  }
}

/**
 * 選択範囲を、その要素のプレーンテキスト上の [start, end) に直す。
 * 要素の中はマーカーでspanに分かれているので、テキストノードを順に
 * 辿って通し位置を数える。
 */
function selectionOffsets(container) {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let offset = 0
  let start = null
  let end = null
  let node
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) start = offset + range.startOffset
    if (node === range.endContainer) end = offset + range.endOffset
    offset += node.textContent.length
  }
  if (start === null || end === null || start === end) return null
  return { start: Math.min(start, end), end: Math.max(start, end), rect: range.getBoundingClientRect() }
}

function onMarkerSelect(el) {
  if (!markerCtx) return
  // ブラウザが選択を確定させてから読む
  setTimeout(() => {
    const offsets = selectionOffsets(el)
    const addr = addrOf(el)
    if (!offsets || !addr) {
      markerCtx.toolbar.style.display = 'none'
      markerCtx.pending = null
      return
    }
    markerCtx.pending = { addr, start: offsets.start, end: offsets.end }
    const bar = markerCtx.toolbar
    bar.style.display = 'flex'
    bar.style.position = 'fixed'
    bar.style.left = `${Math.max(8, Math.min(offsets.rect.left, window.innerWidth - 150))}px`
    bar.style.top = `${Math.max(8, offsets.rect.top - 40)}px`
  }, 0)
}

/** colorIndex が null なら消去 */
async function commitMarker(colorIndex) {
  if (!markerCtx?.pending) return
  const { item, pending } = markerCtx
  const field = pending.addr.field
  const before = detail.detail?.[field] ?? ''

  const current = getMarkedText(before, pending.addr)
  const marked =
    colorIndex === null
      ? eraseMarkerRange(current, pending.start, pending.end)
      : applyMarkerRange(current, pending.start, pending.end, colorIndex)
  const next = setMarkedText(before, pending.addr, marked)

  markerCtx.toolbar.style.display = 'none'
  window.getSelection()?.removeAllRanges()

  // 先に画面へ反映してから保存する。失敗したら元に戻す
  detail.detail = { ...detail.detail, [field]: next }
  paintDetail()
  try {
    await saveField(item.key, field, next)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
    stampNotes(item.key, field, next)
    if (field === 'summary') item.summary = next
  } catch (err) {
    detail.detail = { ...detail.detail, [field]: before }
    paintDetail()
    alert('マーカーを保存できませんでした: ' + (err.message || err))
  }
}

/**
 * マインドマップの枝を塗る。選んでいる色をもう一度押したら外す。
 * 描き直すと拡大位置が戻ってしまうので、クリックされた枝のDOMだけ直に塗る。
 */
async function commitNodeMarker(item, nodeIndex, el) {
  const before = detail.detail?.mindmap ?? ''
  const current = nodeMarkerOf(before, nodeIndex)
  const color = detail.mindmapColor && detail.mindmapColor !== current ? detail.mindmapColor : null
  const next = markNodeLine(before, nodeIndex, color)
  if (next === before) return

  el.classList.toggle('mm-marked', Boolean(color))
  el.style.background = color ? MARKER_COLORS[color] : ''

  detail.detail = { ...detail.detail, mindmap: next }
  try {
    await saveField(item.key, 'mindmap', next)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
    stampNotes(item.key, 'mindmap', next)
  } catch (err) {
    detail.detail = { ...detail.detail, mindmap: before }
    paintDetail()
    alert('マーカーを保存できませんでした: ' + (err.message || err))
  }
}

/** キーボードで直した枝を保存する。マップは描き直し済みなのでここでは触らない */
async function saveMindmapEdit(item, markdown) {
  const before = detail.detail?.mindmap ?? ''
  if (markdown === before) return

  detail.detail = { ...detail.detail, mindmap: markdown }
  try {
    await saveField(item.key, 'mindmap', markdown)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
  } catch (err) {
    detail.detail = { ...detail.detail, mindmap: before }
    paintDetail()
    alert('マインドマップを保存できませんでした: ' + (err.message || err))
  }
}

/** マインドマップ一覧に出すかどうか。ボタンだけ差し替えて、マップは描き直さない */
async function togglePublic(item, btn) {
  const before = Boolean(detail.detail?.isPublic ?? item.isPublic)
  const next = !before
  const paint = (on) => {
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-pressed', String(on))
    btn.innerHTML = `<i class="ti ${on ? 'ti-eye' : 'ti-eye-off'}" aria-hidden="true"></i>${on ? '公開中' : '非公開'}`
  }

  paint(next)
  detail.detail = { ...detail.detail, isPublic: next }
  item.isPublic = next
  try {
    await setPublic(item.key, next)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
  } catch (err) {
    paint(before)
    detail.detail = { ...detail.detail, isPublic: before }
    item.isPublic = before
    alert('公開の切り替えができませんでした: ' + (err.message || err))
  }
}

/**
 * 応用 / 活用の1件をアイデア一覧に出すかどうか。
 * 印は見出しに入るので、保存先は本文そのもの(新しい列は要らない)。
 */
async function toggleSectionPublic(item, field, index, isPublic) {
  const before = detail.detail?.[field] ?? ''
  const next = setSectionHidden(before, index, !isPublic)
  if (next === before) return

  detail.detail = { ...detail.detail, [field]: next }
  paintDetail()
  try {
    await saveField(item.key, field, next)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
    syncIdeaFeed(item.key, field, next)
  } catch (err) {
    detail.detail = { ...detail.detail, [field]: before }
    paintDetail()
    alert('公開の切り替えができませんでした: ' + (err.message || err))
  }
}

/** 応用 / 活用の1件に★を付け直す。0 を渡すと未設定に戻る */
async function changeSectionRank(item, field, index, rank) {
  const before = detail.detail?.[field] ?? ''
  const next = setSectionRank(before, index, rank)
  if (next === before) return

  detail.detail = { ...detail.detail, [field]: next }
  paintDetail()
  try {
    await saveField(item.key, field, next)
    setDetailCache(item.key, { ...detail.detail, updatedAt: new Date().toISOString() })
    syncIdeaFeed(item.key, field, next)
    requestRebuildNow('rank')
  } catch (err) {
    detail.detail = { ...detail.detail, [field]: before }
    paintDetail()
    alert('ランクを変えられませんでした: ' + (err.message || err))
  }
}

/** 読み込み済みのアイデア一覧にも反映する。JSONは次のバッチまで古いままのため */
function syncIdeaFeed(key, kind, text) {
  const state = new Map(
    parseSections(text).map((s) => [
      visibleHeading(s.heading),
      { hidden: isSectionHidden(s.heading), rank: sectionRank(s.heading) },
    ])
  )
  ideasState.items.forEach((e) => {
    const found = state.get(e.heading)
    if (e.key === key && e.kind === kind && found) {
      e.isPublic = !found.hidden
      e.rank = found.rank
    }
  })
}

// ---- 生成 ----

/**
 * 一時的なお知らせ。一括生成のバーと同じ場所を使い回す。
 * 新語が増えたことに気づけないと語彙が静かに膨らんでいくため、その通知に使う。
 */
let noticeTimer = null
function notice(text) {
  const bar = $('bulk')
  bar.innerHTML = `<div class="bulk"><span>${escapeHtml(text)}</span><span class="grow"></span><button class="btn btn-sm" id="notice-close">閉じる</button></div>`
  $('notice-close').addEventListener('click', () => {
    bar.innerHTML = ''
    clearTimeout(noticeTimer)
  })
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    if (bar.querySelector('#notice-close')) bar.innerHTML = ''
  }, 8000)
}

/** 新しいタグが作られたときだけ知らせる。既存タグへ寄せられた分は黙って通す */
function reportTags(tagReport) {
  if (tagReport?.created?.length) {
    notice(`新しいタグを追加しました: ${tagReport.created.join('、')}`)
  }
}

function paintBusy(label, text) {
  detail.busyLabel = label
  detail.busyText = text
  const pre = stageEl.querySelector('.gen-stream')
  const p = stageEl.querySelector('.gen-progress .muted')
  if (pre && p) {
    p.textContent = label
    pre.textContent = (text || '').slice(-1200)
    pre.scrollTop = pre.scrollHeight
  } else {
    paintDetail()
  }
}

/** 段が終わるたびにNotionへ保存する。途中で失敗しても手前の段は残る */
async function persistStage(item, stageDetail, model) {
  const rawCount = typeof detail.transcript === 'string' ? detail.transcript.length : item.rawCount || 0
  await saveGenerated(item.key, stageDetail, model, rawCount)

  const next = { ...(detail.detail || {}), ...stageDetail, model, generatedAt: new Date().toISOString() }
  if (Array.isArray(stageDetail.tags)) {
    next.tags = stageDetail.tags
    detail.tags = stageDetail.tags
    item.tags = stageDetail.tags
  }
  detail.detail = next
  setDetailCache(item.key, { ...next, updatedAt: new Date().toISOString() })

  // 一覧カードの表示も追従させる
  item.status = STATUS_SUMMARIZED
  item.model = model
  if (typeof stageDetail.summary === 'string') item.summary = stageDetail.summary
  item.has = {
    ...(item.has || {}),
    mindmap: Boolean(next.mindmap),
    fields: Boolean(next.fields),
    apply: Boolean(next.apply),
    ideas: Boolean(next.ideas),
  }
}

async function generateContext(item) {
  const transcript = (await ensureTranscript(item)) || ''
  return {
    title: item.title,
    transcript,
    mode: detail.mode,
    summary: stripMarkers(detail.detail?.summary || ''),
    fields: stripMarkers(detail.detail?.fields || ''),
    // 既存のタグを渡して語彙を縛る。渡さないと動画ごとに表記が増えていく
    knownTags: knownTagsOf(items),
  }
}

async function runGenerateAll(item) {
  if (detail.busyStage) return
  detail.busyStage = stagesOf(detail.mode)[0].id
  paintBusy('原文を読み込んでいます', '')
  try {
    const ctx = await generateContext(item)
    if (!ctx.transcript) throw new Error('原文がありません。状態が「完了」になるまで待ってください')

    const { tagReport } = await generateAll(ctx, {
      onStageStart: (stage) => paintBusy(`${stage.label} を生成中`, ''),
      onProgress: (stage, text) => paintBusy(`${stage.label} を生成中`, text),
      onStage: async (stageId, stageDetail, model) => {
        paintBusy('Notionに保存中', '')
        await persistStage(item, stageDetail, model)
      },
    })
    detail.busyStage = null
    paintDetail()
    reportTags(tagReport)
  } catch (err) {
    detail.busyStage = null
    paintDetail()
    alert('生成できませんでした: ' + (err.message || err))
  }
}

async function runStage(item, stageId) {
  if (detail.busyStage) return
  const stage = stagesOf(detail.mode).find((s) => s.id === stageId)
  detail.busyStage = stageId
  paintBusy(`${stage?.label ?? stageId} を生成中`, '')
  try {
    const ctx = await generateContext(item)
    if (needsTranscript(stageId, detail.mode) && !ctx.transcript) {
      throw new Error('原文がありません。状態が「完了」になるまで待ってください')
    }
    const { detail: stageDetail, model, tagReport } = await generateStage(stageId, ctx, (text) =>
      paintBusy(`${stage?.label ?? stageId} を生成中`, text)
    )
    paintBusy('Notionに保存中', '')
    await persistStage(item, stageDetail, model)
    detail.busyStage = null
    paintDetail()
    reportTags(tagReport)
  } catch (err) {
    detail.busyStage = null
    paintDetail()
    alert('生成できませんでした: ' + (err.message || err))
  }
}

// ---- 手編集・タグ・状態 ----

const FIELD_LABEL = {
  summary: 'サマリ',
  mindmap: 'マインドマップ',
  fields: '分野別要約',
  apply: '応用',
  ideas: '活用アイデア',
}

// musicスペースは同じカラムを別の用途で使っているので、見出しと書き方の説明も差し替える
const MUSIC_FIELD_LABEL = { summary: 'チャプター', fields: '概要' }
const MUSIC_FIELD_HINT = {
  summary: '1行1曲で「[12:34] 曲名」の形です。時刻は動画の再生位置になります',
  fields: '見出しや箇条書きにせず、文章で書きます',
}

function editCurrentField(item) {
  const field = detail.activeTab
  const music = detail.mode === 'music'
  const label = music ? MUSIC_FIELD_LABEL[field] : FIELD_LABEL[field]
  if (!label) return
  const hint = music
    ? MUSIC_FIELD_HINT[field]
    : field === 'mindmap'
      ? 'markmap用のMarkdownです。# が中心、## が大項目、- が枝になります'
      : field === 'summary'
        ? ''
        : '## で項目名、次の行に説明、- で箇条書きです'

  openEditor({
    title: `${label}を直す`,
    // マーカーのタグは見せない。保存時に、文言が一致した範囲だけ引き継ぐ
    value: plainTextOf(detail.detail?.[field] ?? ''),
    hint,
    onSave: async (plain) => {
      const value = reconcileMarkers(detail.detail?.[field] ?? '', plain)
      try {
        await saveField(item.key, field, value)
        const next = { ...(detail.detail || {}), [field]: value }
        detail.detail = next
        setDetailCache(item.key, { ...next, updatedAt: new Date().toISOString() })
        if (field === 'summary') item.summary = value
        item.has = { ...(item.has || {}), [field]: Boolean(value) }
        paintDetail()
      } catch (err) {
        alert('保存できませんでした: ' + (err.message || err))
      }
    },
  })
}

async function commitTags(item, next) {
  const before = detail.tags
  detail.tags = next
  item.tags = next
  paintDetail()
  try {
    await saveTags(item.key, next)
    setDetailCache(item.key, { ...(detail.detail || {}), tags: next, updatedAt: new Date().toISOString() })
  } catch (err) {
    detail.tags = before
    item.tags = before
    paintDetail()
    alert('タグを保存できませんでした: ' + (err.message || err))
  }
}

function addTag(item) {
  const known = [...new Set(items.flatMap((i) => i.tags || []))].sort((a, b) => a.localeCompare(b, 'ja'))
  const root = $('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <h2 class="modal-title">タグを追加</h2>
        <div class="row">
          <input id="tag-new" class="input grow" placeholder="新しいタグ" />
          <button id="tag-add" class="btn btn-primary">追加</button>
        </div>
        ${known.length ? `<div class="tag-row picker">${known.map((t) => `<button class="chip ${(detail.tags || []).includes(t) ? 'on' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div>` : ''}
        <div class="modal-foot"><button id="tag-close" class="btn">閉じる</button></div>
      </div>
    </div>
  `
  const close = () => (root.innerHTML = '')
  $('tag-close').addEventListener('click', close)
  $('tag-add').addEventListener('click', () => {
    const name = $('tag-new').value.trim()
    if (!name || (detail.tags || []).includes(name)) return close()
    commitTags(item, [...(detail.tags || []), name])
    close()
  })
  root.querySelectorAll('.chip[data-tag]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const t = chip.dataset.tag
      const cur = detail.tags || []
      commitTags(item, cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t])
      close()
    })
  )
}

function removeTag(item, tag) {
  commitTags(item, (detail.tags || []).filter((t) => t !== tag))
}

function openMoreMenu(anchor, item) {
  document.querySelector('.popmenu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'popmenu'
  menu.innerHTML = `
    <button data-act="title"><i class="ti ti-edit" aria-hidden="true"></i>タイトルを直す</button>
    <button data-act="retry"><i class="ti ti-microphone" aria-hidden="true"></i>文字起こしをやり直す</button>
    <button data-act="exclude" class="danger"><i class="ti ti-archive" aria-hidden="true"></i>一覧から除外する</button>
    <button data-act="delete" class="danger"><i class="ti ti-trash" aria-hidden="true"></i>Notionから削除する</button>
  `
  document.body.appendChild(menu)
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.right = `${window.innerWidth - rect.right}px`

  const close = () => menu.remove()
  menu.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', async () => {
      close()
      const act = btn.dataset.act
      if (act === 'title') {
        openEditor({
          title: 'タイトルを直す',
          value: item.title,
          multiline: false,
          onSave: async (value) => {
            const next = value.trim()
            if (!next) return
            try {
              await saveTitle(item.key, next)
              item.title = next
              paintDetail()
            } catch (err) {
              alert('保存できませんでした: ' + (err.message || err))
            }
          },
        })
      }
      if (act === 'retry') {
        if (!confirm('状態を「再取得」に戻します。次回のバッチで文字起こしをやり直します。')) return
        try {
          await setStatus(item.key, STATUS_RETRY)
          item.status = STATUS_RETRY
          paintDetail()
        } catch (err) {
          alert('変更できませんでした: ' + (err.message || err))
        }
      }
      if (act === 'exclude') {
        if (!confirm('一覧から除外します。Notionのページは残ります。')) return
        try {
          await setStatus(item.key, STATUS_EXCLUDED)
          item.status = STATUS_EXCLUDED
          setView('library')
        } catch (err) {
          alert('変更できませんでした: ' + (err.message || err))
        }
      }
      if (act === 'delete') {
        if (!confirm(`「${item.title}」をNotionのゴミ箱へ移します。このアプリからは戸せません。続けますか?`)) return
        try {
          await deleteVideo(item.key)
          clearDetailCache(item.key)
          items = items.filter((i) => i.key !== item.key)
          // 一覧JSONは次のcronまで古いままなので、手元の状態だけ先に揃える
          ideasState.phase = 'idle'
          setView('library')
        } catch (err) {
          alert('削除できませんでした: ' + (err.message || err))
        }
      }
    })
  )
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!menu.contains(e.target)) {
        close()
        document.removeEventListener('click', once)
      }
    })
  }, 0)
}

function copyCurrentTab() {
  const d = detail.detail || {}
  const text = detail.activeTab === 'raw' ? detail.transcript || '' : d[detail.activeTab] || ''
  if (!text) return
  navigator.clipboard.writeText(text)
  const btn = stageEl.querySelector('.btn-copy')
  if (btn) {
    const before = btn.innerHTML
    btn.textContent = 'コピーしました'
    setTimeout(() => (btn.innerHTML = before), 1500)
  }
}

function openMindmapFull() {
  const item = itemOf(selectedKey)
  renderMindmap(openMindmapOverlay(item?.title || ''), detail.detail?.mindmap, item?.url)
}

/** マインドマップを大きく出す枠だけ作る。中身は呼び出し側が描く */
function openMindmapOverlay(title) {
  const root = $('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal modal-wide">
        <div class="modal-head">
          <h2 class="modal-title">${escapeHtml(title)}</h2>
          <button id="mm-close" class="btn-ghost" aria-label="閉じる"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <div id="mm-full" class="mindmap-host mindmap-full"></div>
      </div>
    </div>
  `
  $('mm-close').addEventListener('click', () => (root.innerHTML = ''))
  return $('mm-full')
}

// ============ マインドマップ一覧 ============

/** 「公開」をONにしたものだけを並べる。マップ自体はカードを開いたときに描く */
// ============ 記録・ノート ============

/** 種別(取り込み元)の表示名。spaces.json に無いものはIDをそのまま出す */
function sourceLabel(id) {
  return sourcesOf().find((s) => s.id === id)?.label || id
}

/** いま絞り込まれている種別。空なら全部(記録側は Set を渡さず全部として扱う) */
function activeSourceSet() {
  return selectedSources.size ? new Set(selectedSources) : null
}

/** 絞り込み中の種別を見出しに出す。「otherだけの記録」が見ていて分かるように */
function scopeTitle(base) {
  if (!selectedSources.size) return base
  return `${base}(${[...selectedSources].map(sourceLabel).join('・')})`
}

function paintRecords() {
  renderRecords(
    stageEl,
    recordSummary(activeSourceSet()),
    { sourceLabel, title: scopeTitle('閲覧の記録') },
    { onOpen: (key) => (itemOf(key) ? openDetail(key) : notice('この項目はいまの一覧にありません')) }
  )
}

function paintNotes(opts = {}) {
  const { notes, memoCount } = collectNotes(visibleItems())
  const shown = filterNotes(notes, notesState)
  renderNotes(
    stageEl,
    { all: notes, shown, state: notesState, memoCount, sourceLabel, counts: noteSourceCounts(notes) },
    {
      onChange: (patch, o = {}) => {
        Object.assign(notesState, patch)
        paintNotes(o)
      },
      onOpen: (key) => (itemOf(key) ? openDetail(key) : notice('この項目はいまの一覧にありません')),
      onCopy: () => {
        navigator.clipboard.writeText(notesMarkdown(shown)).then(
          () => notice(`${shown.length}件コピーしました`),
          () => notice('コピーできませんでした')
        )
      },
      onSave: () => downloadText(`notes-${new Date().toISOString().slice(0, 10)}.md`, notesMarkdown(shown)),
    }
  )
  // 入力のたびに作り直すので、打ち込み中はカーソルを戻す
  if (opts.keepFocus) {
    const q = stageEl.querySelector('#note-q')
    if (q) {
      q.focus()
      q.setSelectionRange(q.value.length, q.value.length)
    }
  }
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function paintMindmaps() {
  const entries = currentItems().filter((i) => i.isPublic && i.has?.mindmap)
  renderMindmapGallery(
    stageEl,
    entries,
    { searchQuery, showTags, canEdit: canEdit(loadConfig()) },
    { onOpen: openMindmapViewer, onHide: hideMindmap }
  )
}

/** 一覧からその場で公開をやめる。戻すときは詳細のタブから */
async function hideMindmap(key) {
  const item = itemOf(key)
  if (!item) return
  item.isPublic = false
  refresh()
  try {
    await setPublic(key, false)
  } catch (err) {
    item.isPublic = true
    refresh()
    alert('公開の切り替えができませんでした: ' + (err.message || err))
  }
}

async function openMindmapViewer(key) {
  const item = itemOf(key)
  if (!item) return
  const host = openMindmapOverlay(item.title)
  host.innerHTML = '<p class="muted">読み込んでいます...</p>'
  try {
    const cached = getDetailCache(key)
    const d = isCacheFresh(cached, item.editedAt) ? cached : setDetailCache(key, await fetchDetail(key))
    // 読んでいる間に閉じられていることがある
    if ($('mm-full')) renderMindmap($('mm-full'), d.mindmap, item.url)
  } catch (err) {
    if ($('mm-full')) $('mm-full').innerHTML = `<p class="error-text">${escapeHtml(String(err.message || err))}</p>`
  }
}

// ============ アイデア一覧 ============

async function paintIdeas() {
  if (ideasState.phase === 'idle') {
    ideasState.phase = 'loading'
    renderIdeas(stageEl, [], ideasState, {})
    try {
      const data = await listIdeas()
      ideasState.items = flattenIdeas(data.items)
      ideasState.phase = 'ready'
    } catch (err) {
      ideasState.phase = 'error'
      ideasState.message = String(err.message || err)
    }
    if (view !== 'ideas') return
  }

  let entries = ideasState.items.filter((e) => e.isPublic)
  entries = filterBySource(entries, selectedSources)
  if (ideasState.kind !== 'all') entries = entries.filter((e) => e.kind === ideasState.kind)
  if (selectedTags.size) entries = entries.filter((e) => [...selectedTags].every((t) => e.tags.includes(t)))
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    entries = entries.filter(
      (e) =>
        e.heading.toLowerCase().includes(q) ||
        e.body.toLowerCase().includes(q) ||
        e.videoTitle.toLowerCase().includes(q)
    )
  }
  if (ideasState.shuffleSeed) entries = pickRandom(entries, 6, ideasState.shuffleSeed)
  else entries = [...entries].sort((a, b) => b.rank - a.rank)

  renderIdeas(stageEl, entries, { ...ideasState, canEdit: canEdit(loadConfig()) }, {
    onKind: (kind) => {
      ideasState.kind = kind
      ideasState.shuffleSeed = 0
      paintIdeas()
    },
    onShuffle: () => {
      ideasState.shuffleSeed = ideasState.shuffleSeed ? 0 : Date.now()
      paintIdeas()
    },
    onOpen: (key) => openDetail(key),
    onHide: hideIdea,
    onRank: rankIdea,
    onSelect: (id, on) => {
      on ? ideasState.selected.add(id) : ideasState.selected.delete(id)
      paintIdeas()
    },
    onSelectMany: (ids, additive) => {
      if (!additive) ideasState.selected.clear()
      ids.forEach((id) => ideasState.selected.add(id))
      paintIdeas()
    },
    onClearSelect: () => {
      ideasState.selected.clear()
      paintIdeas()
    },
    onBulkRank: bulkRankIdeas,
  })
  stageEl.querySelector('.btn-retry')?.addEventListener('click', () => {
    ideasState.phase = 'idle'
    paintIdeas()
  })
}

/** アイデア1件を一覧から外す。戻すときは詳細の応用 / 活用タブから */
async function hideIdea(key, kind, sec) {
  const entry = ideasState.items.find((e) => e.key === key && e.kind === kind && e.sec === sec)
  if (!entry) return
  entry.isPublic = false
  paintIdeas()
  try {
    const item = itemOf(key)
    const cached = getDetailCache(key)
    const d = isCacheFresh(cached, item?.editedAt) ? cached : setDetailCache(key, await fetchDetail(key))
    const before = d[kind] ?? ''
    const next = setSectionHiddenByHeading(before, entry.heading, true)
    if (next === before) throw new Error('このアイデアが見つかりません。作り直された可能性があります')
    await saveField(key, kind, next)
    setDetailCache(key, { ...d, [kind]: next, updatedAt: new Date().toISOString() })
  } catch (err) {
    entry.isPublic = true
    paintIdeas()
    alert('公開の切り替えができませんでした: ' + (err.message || err))
  }
}

/** 一覧からその場で★を付け直す。並びもすぐ入れ替わる */
async function rankIdea(key, kind, sec, rank) {
  const entry = ideasState.items.find((e) => e.key === key && e.kind === kind && e.sec === sec)
  if (!entry) return
  const prevRank = entry.rank
  entry.rank = rank
  paintIdeas()
  try {
    const item = itemOf(key)
    const cached = getDetailCache(key)
    const d = isCacheFresh(cached, item?.editedAt) ? cached : setDetailCache(key, await fetchDetail(key))
    const before = d[kind] ?? ''
    const next = setSectionRankByHeading(before, entry.heading, rank)
    if (next === before) throw new Error('このアイデアが見つかりません。作り直された可能性があります')
    await saveField(key, kind, next)
    setDetailCache(key, { ...d, [kind]: next, updatedAt: new Date().toISOString() })
    requestRebuildNow('rank')
  } catch (err) {
    entry.rank = prevRank
    paintIdeas()
    alert('ランクを変えられませんでした: ' + (err.message || err))
  }
}

/**
 * 選んだアイデアにまとめて★を付ける。
 * 同じ動画・同じ種別の分は1つのテキストにまとめて書き戻す
 * (1件ずつ保存すると同じプロパティへの上書きが競合し、先に書いた分が消える)。
 */
async function bulkRankIdeas(rank) {
  const targets = ideasState.items.filter((e) => ideasState.selected.has(e.id))
  if (!targets.length) return

  const prevRanks = new Map(targets.map((e) => [e.id, e.rank]))
  targets.forEach((e) => { e.rank = rank })
  ideasState.selected.clear()
  paintIdeas()

  const groups = new Map()
  targets.forEach((e) => {
    const gk = `${e.key}::${e.kind}`
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk).push(e)
  })

  const failed = []
  for (const [gk, list] of groups) {
    const [key, kind] = gk.split('::')
    try {
      const item = itemOf(key)
      const cached = getDetailCache(key)
      const d = isCacheFresh(cached, item?.editedAt) ? cached : setDetailCache(key, await fetchDetail(key))
      let next = d[kind] ?? ''
      list.forEach((e) => { next = setSectionRankByHeading(next, e.heading, rank) })
      await saveField(key, kind, next)
      setDetailCache(key, { ...d, [kind]: next, updatedAt: new Date().toISOString() })
    } catch (err) {
      list.forEach((e) => { e.rank = prevRanks.get(e.id) ?? 0 })
      failed.push(`${itemOf(key)?.title || key}: ${err.message || err}`)
    }
  }

  if (failed.length) {
    paintIdeas()
    alert('★を変えられなかったものがあります:\n' + failed.join('\n'))
  }
  if (failed.length < groups.size) requestRebuildNow('rank')
}

/** 決め打ちのシードで並べ替えて先頭n件。再描画しても同じ並びになる */
function pickRandom(list, n, seed) {
  const scored = list.map((e, i) => {
    let h = seed + i * 2654435761
    h = (h ^ (h >>> 15)) * 2246822507
    return { e, r: (h ^ (h >>> 13)) >>> 0 }
  })
  return scored.sort((a, b) => a.r - b.r).slice(0, n).map((s) => s.e)
}

// ============ 横断チャット ============

let crossSpaceId = null

function paintCrossChat() {
  const spaces = loadSpaces()
  const space = spaces.find((s) => s.id === crossSpaceId) || spaces[0] || null

  if (!space) {
    stageEl.innerHTML = `
      <div class="empty-state">
        <i class="ti ti-messages" aria-hidden="true"></i>
        <p>スペースがありません</p>
        <p class="empty-hint">複数の動画をまとめて対象にして質問できます</p>
        <button class="btn btn-primary btn-space-new">スペースを作る</button>
      </div>`
    stageEl.querySelector('.btn-space-new').addEventListener('click', createSpace)
    return
  }
  crossSpaceId = space.id

  stageEl.innerHTML = `
    <div class="detail">
      <div class="detail-fixed">
        <div class="detail-head">
          <button class="btn-ghost btn-back" aria-label="一覧に戻る"><i class="ti ti-arrow-left" aria-hidden="true"></i></button>
          <div class="detail-headline">
            <h2 class="detail-title">${escapeHtml(space.name)}</h2>
            <div class="detail-meta"><span>対象 ${space.targets.length}件</span><span>約${space.targets.reduce((a, t) => a + (t.chars || 0), 0).toLocaleString()}字</span></div>
          </div>
          <select id="space-select" class="input sm">
            ${spaces.map((s) => `<option value="${s.id}" ${s.id === space.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
          <button class="btn-ghost btn-space-new" aria-label="スペースを作る"><i class="ti ti-plus" aria-hidden="true"></i></button>
        </div>
        <div class="cross-targets">
          ${space.targets.map((t) => `<span class="tag">${escapeHtml(t.title)}</span>`).join('') || '<span class="muted">対象未選択</span>'}
          <button class="btn btn-sm btn-pick">対象を選ぶ</button>
        </div>
      </div>
      <div class="detail-scroll"><div id="cross-log" class="chat-log"></div></div>
      <div class="detail-foot">
        <div class="composer">
          <div class="composer-row">
            <textarea id="cross-input" class="chat-input" rows="1" placeholder="選んだ動画をまとめて質問する(Shift+Enterで改行)"></textarea>
            <button id="cross-send" class="btn btn-primary" aria-label="送信"><i class="ti ti-send" aria-hidden="true"></i></button>
          </div>
        </div>
      </div>
    </div>
  `

  stageEl.querySelector('.btn-back').addEventListener('click', () => setView('library'))
  stageEl.querySelector('.btn-space-new').addEventListener('click', createSpace)
  stageEl.querySelector('.btn-pick').addEventListener('click', () => pickTargets(space.id))
  $('space-select').addEventListener('change', (e) => {
    crossSpaceId = e.target.value
    paintCrossChat()
  })

  const logEl = $('cross-log')
  renderQA(logEl, space.messages)

  let busy = false
  wireComposer($('cross-input'), $('cross-send'), async () => {
    if (busy) return
    const input = $('cross-input')
    const text = input.value.trim()
    if (!text) return
    if (!space.targets.length) {
      alert('先に対象の動画を選んでください')
      return
    }
    input.value = ''
    input.style.height = 'auto'

    space.messages.push({ role: 'user', content: text })
    persistSpace(space)
    renderQA(logEl, space.messages)

    const connection = connectionOf(loadSettings())
    if (!connection) {
      space.messages.push({ role: 'assistant', content: 'AI接続が未設定です。設定から接続先とモデルを追加してください。' })
      persistSpace(space)
      renderQA(logEl, space.messages)
      return
    }

    busy = true
    space.messages.push({ role: 'assistant', content: '' })
    renderQA(logEl, space.messages)

    try {
      const context = space.targets
        .map((t) => `## ${t.title}\n${t.text}`)
        .join('\n\n')
        .slice(0, 60000)
      const system = `あなたは複数の動画の要約を横断して質問に答えるアシスタントです。
以下は対象の動画それぞれの要約です。どの動画の話かが分かるよう、答えの中で動画タイトルに触れてください。
書かれていないことは「分かりません」と答えてください。Markdownで整理し、日本語で回答してください。

${context}`

      let full = ''
      for await (const chunk of streamChat(connection, [
        { role: 'system', content: system },
        ...space.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      ])) {
        if (chunk.delta) {
          full += chunk.delta
          space.messages[space.messages.length - 1].content = full
          renderQA(logEl, space.messages)
        }
      }
      if (!full) space.messages[space.messages.length - 1].content = '(応答がありませんでした)'
    } catch (err) {
      space.messages[space.messages.length - 1].content = 'エラーが発生しました: ' + (err.message || err)
    }
    persistSpace(space)
    renderQA(logEl, space.messages)
    busy = false
  })
}

function persistSpace(space) {
  const spaces = loadSpaces()
  const i = spaces.findIndex((s) => s.id === space.id)
  if (i === -1) spaces.push(space)
  else spaces[i] = space
  saveSpaces(spaces)
}

function createSpace() {
  const name = prompt('スペースの名前')
  if (name === null) return
  const space = newSpace(name.trim())
  persistSpace(space)
  crossSpaceId = space.id
  view = 'crosschat'
  paintCrossChat()
}

/**
 * 横断チャットの対象を選ぶ。原文ではなく要約(サマリ+分野別+応用)を積むので、
 * 20件でもコンテキストに収まる。
 */
function pickTargets(spaceId) {
  const candidates = visibleItems().filter((i) => i.summary)
  const chosen = new Set((loadSpaces().find((s) => s.id === spaceId)?.targets || []).map((t) => t.key))
  const root = $('modal-root')

  const paint = () => {
    root.innerHTML = `
      <div class="overlay">
        <div class="modal modal-wide">
          <div class="modal-head">
            <h2 class="modal-title">対象の動画を選ぶ</h2>
            <span class="foot-note" id="pick-count"></span>
          </div>
          <div class="pick-list">
            ${candidates
              .map(
                (i) => `<label class="pick-row">
                  <input type="checkbox" data-key="${escapeHtml(i.key)}" ${chosen.has(i.key) ? 'checked' : ''} />
                  <span class="pick-title">${escapeHtml(i.title)}</span>
                  <span class="foot-note">${escapeHtml(i.status)}</span>
                </label>`
              )
              .join('') || '<p class="empty-section">サマリのある動画がまだありません</p>'}
          </div>
          <div class="modal-foot">
            <button id="pick-cancel" class="btn">キャンセル</button>
            <button id="pick-ok" class="btn btn-primary">この対象で作る</button>
          </div>
        </div>
      </div>
    `
    const countEl = $('pick-count')
    const paintCount = () => {
      countEl.textContent = `${chosen.size} / ${MAX_CROSS_ITEMS}件`
      countEl.classList.toggle('warn', chosen.size > MAX_CROSS_ITEMS)
    }
    paintCount()

    root.querySelectorAll('.pick-row input').forEach((cb) =>
      cb.addEventListener('change', () => {
        const key = cb.dataset.key
        if (cb.checked) {
          if (chosen.size >= MAX_CROSS_ITEMS) {
            cb.checked = false
            alert(`対象は${MAX_CROSS_ITEMS}件までです`)
            return
          }
          chosen.add(key)
        } else {
          chosen.delete(key)
        }
        paintCount()
      })
    )
    $('pick-cancel').addEventListener('click', () => (root.innerHTML = ''))
    $('pick-ok').addEventListener('click', async () => {
      const ok = $('pick-ok')
      ok.disabled = true
      ok.textContent = '要約を集めています...'
      const targets = []
      let total = 0
      for (const key of chosen) {
        const item = itemOf(key)
        if (!item) continue
        let d = getDetailCache(key)
        if (!isCacheFresh(d, item.editedAt)) {
          try {
            d = setDetailCache(key, await fetchDetail(key))
          } catch {
            continue
          }
        }
        const text = summaryContext(d)
        total += text.length
        targets.push({ key, title: item.title, text, chars: text.length })
      }
      const spaces = loadSpaces()
      const space = spaces.find((s) => s.id === spaceId)
      if (space) {
        space.targets = targets
        saveSpaces(spaces)
      }
      root.innerHTML = ''
      if (total > WARN_CHARS) {
        alert(`対象の合計が約${total.toLocaleString()}字です。モデルのコンテキスト長を超えると答えが途切れることがあります。`)
      }
      paintCrossChat()
    })
  }
  paint()
}

// ============ 一括生成 ============

async function runBulkGenerate() {
  // 未生成(完了)に加えて、途中で失敗して一部だけ欠けているものも拾う。
  // 拾わないと、1段だけ落ちた動画が永久に取り残される
  const fresh = visibleItems().filter((i) => i.status === STATUS_DONE)
  const partial = visibleItems().filter(
    (i) =>
      i.status === STATUS_SUMMARIZED &&
      !(i.has?.mindmap && i.has?.fields && i.has?.apply && i.has?.ideas)
  )

  if (!fresh.length && !partial.length) {
    alert('生成の対象になる動画がありません(状態が「完了」のもの、または項目が欠けているものが対象です)')
    return
  }

  const includePartial =
    partial.length > 0 &&
    confirm(
      `未生成が${fresh.length}件、項目が欠けているものが${partial.length}件あります。\n\n` +
        `OK: 両方(${fresh.length + partial.length}件)を処理する\n` +
        `キャンセル: 未生成の${fresh.length}件だけ処理する`
    )
  const targets = includePartial ? [...fresh, ...partial] : fresh
  if (!targets.length) {
    alert('未生成の動画がありません')
    return
  }
  if (!confirm(`${targets.length}件を順番に生成します。時間がかかります。続けますか?`)) return

  const bar = $('bulk')
  let cancelled = false
  const paint = (i, label) => {
    bar.innerHTML = `
      <div class="bulk">
        <span>${i}/${targets.length} ${escapeHtml(label)}</span>
        <div class="bulk-track"><div class="bulk-fill" style="width:${(i / targets.length) * 100}%"></div></div>
        <button class="btn btn-sm" id="bulk-cancel">中止</button>
      </div>`
    $('bulk-cancel').addEventListener('click', () => {
      cancelled = true
      bar.innerHTML = '<div class="bulk"><span>中止しています...</span></div>'
    })
  }

  const failures = []
  // 一括実行の途中で新しく生まれたタグも語彙に加える。こうしないと、
  // 同じ回の中で似た動画がそれぞれ別の新語を作ってしまう
  let vocabulary = knownTagsOf(items)
  for (let i = 0; i < targets.length; i++) {
    if (cancelled) break
    const item = targets[i]
    paint(i, item.title)
    try {
      const { text: transcript } = await fetchTranscript(item.key)
      if (!transcript) throw new Error('原文が空です')
      await generateAll(
        { title: item.title, transcript, summary: '', fields: '', mode: spaceMode(), knownTags: vocabulary },
        {
          onStage: async (stageId, stageDetail, model) => {
            await saveGenerated(item.key, stageDetail, model, transcript.length)
            if (typeof stageDetail.summary === 'string') item.summary = stageDetail.summary
            if (Array.isArray(stageDetail.tags)) {
              item.tags = stageDetail.tags
              stageDetail.tags.forEach((t) => {
                if (!vocabulary.includes(t)) vocabulary = [...vocabulary, t]
              })
            }
          },
        }
      )
      item.status = STATUS_SUMMARIZED
      item.rawCount = transcript.length
    } catch (err) {
      failures.push(`${item.title}: ${err.message || err}`)
      // 1日の利用上限に達した場合、残りを叩いても全滅するだけなのでここで打ち切る
      if (String(err.message || err).includes('1日の利用上限')) {
        bar.innerHTML = ''
        alert(`${i + 1}/${targets.length}件まで処理したところで1日の利用上限に達しました。\n日付が変わってから残りを実行してください。`)
        ideasState.phase = 'idle'
        refresh()
        return
      }
    }
  }

  bar.innerHTML = ''
  ideasState.phase = 'idle' // アイデア一覧を作り直させる
  refresh()
  if (failures.length) alert(`${failures.length}件でエラーが出ました:\n\n` + failures.slice(0, 8).join('\n'))
}

// ============ トップバーの配線 ============

/**
 * 時刻付きのリンクは別タブではなく画面隨の小窓で再生する。
 * 本文・マインドマップ(SVG内のリンク)・チャットのどれも拾えるよう委譲で受ける。
 * サムネイルや「YouTubeで開く」は時刻が無いのでここでは拾わない。
 */
document.addEventListener('click', (e) => {
  const link = e.target.closest?.('a[href]')
  if (!link || link.classList.contains('mp-open')) return
  const hit = seekTargetOf(link.getAttribute('href'))
  if (!hit) return
  e.preventDefault()
  openMiniPlayer(hit.id, hit.at)
})

/**
 * サムネイルの再生ボタン(data-play)は、最初から小窓で再生する。
 * カード自体のクリック(詳細を開く)より先に拾いたいので、キャプチャ段階で受けて止める。
 */
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('[data-play]')
    if (!btn) return
    e.preventDefault()
    e.stopPropagation()
    openMiniPlayer(btn.dataset.play, 0)
  },
  true
)

$('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value
  refresh()
})
$('open-settings').addEventListener('click', () => openSettings(() => loadList(), listJsonContext()))
$('open-vocab').addEventListener('click', () => {
  openVocabPanel(visibleItems(), {
    dismissed: () => loadDismissed(),
    onKeep: (key) => dismissPair(key),
    onResetDismissed: () => clearDismissed(),
    onMerge: async (from, to) => {
      const res = await mergeTag(from, to)
      // 一覧の手元の状態も揃える。再取得を待たずに候補が消えるようにする
      items.forEach((i) => {
        if (!(i.tags || []).includes(from)) return
        i.tags = [...new Set(i.tags.map((t) => (t === from ? to : t)))]
      })
      ideasState.phase = 'idle'
      refresh()
      return res
    },
  })
})
$('bulk-generate').addEventListener('click', runBulkGenerate)
$('cross-chat').addEventListener('click', () => setView('crosschat'))
$('reload').addEventListener('click', () => {
  ideasState.phase = 'idle'
  loadList()
})
$('toggle-tags').addEventListener('click', () => {
  showTags = !showTags
  // 開いている間だけ時計を進める。裏に回ったら止め、戻ったら数え直す
setInterval(() => {
  if (view === 'detail' && document.visibilityState === 'visible') pingView()
}, 15_000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const back = view === 'detail' && selectedKey ? itemOf(selectedKey) : null
    if (back) beginView(back)
  } else {
    endView()
  }
})
window.addEventListener('pagehide', endView)

$('toggle-tags').classList.toggle('on', showTags)
  refresh()
})
document.querySelectorAll('.viewtab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)))

$('active-model').addEventListener('click', () => {
  const settings = loadSettings()
  const models = allModels(settings)
  if (!models.length) {
    openSettings(() => loadList(), listJsonContext())
    return
  }
  document.querySelector('.popmenu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'popmenu'
  let lastConn = null
  menu.innerHTML = models
    .map((m) => {
      const header = m.connectionId !== lastConn ? `<div class="popmenu-group">${escapeHtml(m.connectionLabel)}</div>` : ''
      lastConn = m.connectionId
      return `${header}<button data-conn="${m.connectionId}" data-model="${escapeHtml(m.model)}" class="${m.active ? 'on' : ''}">${escapeHtml(m.model)}</button>`
    })
    .join('')
  document.body.appendChild(menu)
  const rect = $('active-model').getBoundingClientRect()
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.right = `${window.innerWidth - rect.right}px`
  menu.querySelectorAll('button[data-model]').forEach((btn) =>
    btn.addEventListener('click', () => {
      saveSettings({ ...settings, activeConnectionId: btn.dataset.conn, activeModel: btn.dataset.model })
      menu.remove()
      paintActiveModel()
    })
  )
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!menu.contains(e.target) && e.target !== $('active-model')) {
        menu.remove()
        document.removeEventListener('click', once)
      }
    })
  }, 0)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('modal-root').innerHTML) {
      $('modal-root').innerHTML = ''
      return
    }
    if (view === 'detail' || view === 'crosschat') setView('library')
  }
  // 詳細を開いているとき、左右キーでタブを移動する
  if (view === 'detail' && detail?.phase === 'ready' && !e.metaKey && !e.ctrlKey) {
    const target = e.target
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
    const tabs = tabsOf(detail.mode)
    const i = tabs.findIndex((t) => t.id === detail.activeTab)
    if (e.key === 'ArrowRight' && i < tabs.length - 1) switchTab(tabs[i + 1].id)
    if (e.key === 'ArrowLeft' && i > 0) switchTab(tabs[i - 1].id)
  }
})

$('toggle-tags').classList.toggle('on', showTags)
// プロンプトは生成を押すときまでに揃っていればよいので、一覧の読み込みは待たせない
initPrompts()
// JSONBinを使う設定なら、一覧より先にクラウド側の設定(一覧JSONの場所など)を取り込む。
// 使っていない/取得できないときはローカルの設定のまま進む
syncConfigFromJsonbin().finally(() => {
  // どのJSONを読むかがスペースで決まるので、一覧より先に解決させる
  const start = () =>
    initSpaces().then(() => {
      paintSpaceSwitch()
      loadList()
    })
  // GAS URL・共有トークンが無い(初回、または別ブラウザ)ときは、先に設定画面を出す
  if (isConfigured(loadConfig())) start()
  else openSetup(start)
})

/** 表示対象の切り替え。選択はURLに入るのでリンクとして配れる */
function paintSpaceSwitch() {
  const spaces = spaceList()
  const el = $('space-switch')
  if (spaces.length < 2) {
    el.innerHTML = ''
    return
  }
  const now = activeSpace()
  el.innerHTML = spaces
    .map((s) => `<a class="space-tab ${s.id === now?.id ? 'on' : ''}" href="${escapeHtml(spaceHref(s.id))}">${escapeHtml(s.label)}</a>`)
    .join('')
}
