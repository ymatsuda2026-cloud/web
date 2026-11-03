/*!
 * mindmap2.app.js — index.html の配線。
 *
 * 画面の状態はすべて state に集め、書き換えたら render() を呼び直す。
 * 描画(mindmap2.js)と保存(mindmap2.store.js)は触らず、この中で繋ぐだけにする。
 */

import { renderMindmap } from './mindmap2.js'
import * as Store from './mindmap2.store.js'

const $ = (id) => document.getElementById(id)

const el = {
  status: $('status'),
  saveBtn: $('saveBtn'),
  reloadBtn: $('reloadBtn'),
  settingsBtn: $('settingsBtn'),
  toggleList: $('toggleList'),
  sidebar: $('sidebar'),
  newBtn: $('newBtn'),
  emptyNewBtn: $('emptyNewBtn'),
  search: $('search'),
  list: $('list'),
  count: $('count'),
  tabs: $('tabs'),
  empty: $('empty'),
  panes: $('panes'),
  hint: $('hint'),
  sourcePane: $('sourcePane'),
  toggleSrc: $('toggleSrc'),
  src: $('src'),
  map: $('map'),
  settingsDialog: $('settingsDialog'),
  passDialog: $('passDialog'),
}

const state = {
  settings: Store.loadSettings(),
  store: Store.emptyStore(),
  pass: Store.rememberedPass(),
  openIds: [],
  activeId: null,
  filter: '',
  showSource: true,
  showList: true,
  dirty: false,
  saving: false,
  queued: false,
  savedAt: null,
  error: '',
  locked: false, // パスフレーズが入らず中身を開けていない
}

const AUTOSAVE_MS = 1500
const REDRAW_MS = 400

let saveTimer = null
let redrawTimer = null
let drawToken = 0

// ---------------------------------------------------------------- 起動

boot()

async function boot() {
  const ui = Store.loadUiState()
  state.showSource = ui.showSource !== false
  state.showList = ui.showList !== false
  await reload({ initial: true, ui })
}

/** 保存先(なければローカル控え)から読み直して画面を作り直す */
async function reload({ initial = false, ui = null } = {}) {
  if (!initial && state.dirty) {
    if (!confirm('保存していない変更があります。読み直すと失われます。続けますか？')) return
  }
  clearTimeout(saveTimer)

  const bin = new Store.Jsonbin(state.settings)
  let record = Store.readCache()
  state.error = ''

  if (bin.configured) {
    try {
      record = await bin.read()
      Store.writeCache(record)
    } catch (err) {
      state.error = `読み込めませんでした: ${err.message}(手元の控えを表示しています)`
    }
  }

  state.locked = false
  if (!record) {
    state.store = Store.emptyStore()
  } else if (Store.isSealed(record)) {
    const store = await openSealed(record)
    if (store) {
      state.store = store
    } else {
      state.store = Store.emptyStore()
      state.locked = true
      state.error = 'パスフレーズが未入力のため、中身を開けていません'
    }
  } else {
    state.store = Store.normalizeStore(record)
  }

  // 開いていたタブを、まだ残っている文書だけ復元する
  const source = ui || Store.loadUiState()
  const alive = new Set(state.store.docs.map((d) => d.id))
  state.openIds = (source.openIds || []).filter((id) => alive.has(id))
  state.activeId = alive.has(source.activeId) ? source.activeId : state.openIds[0] || null

  state.dirty = false
  state.savedAt = null
  render()
  loadEditor()
}

/** 暗号化された record を、パスフレーズを聞きながら開く */
async function openSealed(record) {
  if (state.pass) {
    try {
      return await Store.unseal(record, state.pass)
    } catch {
      state.pass = ''
      Store.rememberPass('')
    }
  }
  let note = '保存されている内容は暗号化されています。'
  for (;;) {
    const pass = await askPass(note)
    if (!pass) return null
    try {
      const store = await Store.unseal(record, pass)
      state.pass = pass
      return store
    } catch (err) {
      note = err.message
    }
  }
}

// ---------------------------------------------------------------- 描画

function render() {
  renderList()
  renderTabs()
  renderStatus()
  el.sidebar.classList.toggle('hidden', !state.showList)
  el.sourcePane.classList.toggle('hidden', !state.showSource)
  el.toggleSrc.textContent = state.showSource ? 'Markdownを隠す' : 'Markdownを出す'

  const has = Boolean(activeDoc())
  el.panes.classList.toggle('hidden', !has)
  el.hint.classList.toggle('hidden', !has)
  el.empty.classList.toggle('hidden', has)
}

function renderStatus() {
  const bin = new Store.Jsonbin(state.settings)
  const where = bin.configured ? '' : '(この端末のみ)'
  let text = ''
  let cls = ''
  if (state.error) {
    text = `⚠ ${state.error}`
    cls = 'error'
  } else if (state.saving) {
    text = '保存中…'
  } else if (state.dirty) {
    text = `未保存 ${where}`
    cls = 'dirty'
  } else if (state.savedAt) {
    text = `保存しました ${timeOf(state.savedAt)} ${where}`
  } else {
    text = state.locked ? 'ロック中' : `読み込み済み ${where}`
  }
  el.status.textContent = text
  el.status.className = cls
  el.saveBtn.disabled = state.saving || state.locked
}

function renderList() {
  const filter = state.filter.trim().toLowerCase()
  const docs = [...state.store.docs]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .filter((d) => !filter || d.title.toLowerCase().includes(filter) || d.markdown.toLowerCase().includes(filter))

  el.list.innerHTML = ''
  if (!docs.length) {
    const li = document.createElement('li')
    li.className = 'none'
    li.textContent = state.store.docs.length ? '一致するものがありません' : 'まだありません'
    el.list.appendChild(li)
  }

  for (const doc of docs) {
    const li = document.createElement('li')
    li.className = doc.id === state.activeId ? 'active' : ''
    li.dataset.id = doc.id

    const body = document.createElement('div')
    body.className = 'doc'
    const title = document.createElement('div')
    title.className = 'doc-title'
    title.textContent = doc.title || '無題'
    const time = document.createElement('div')
    time.className = 'doc-time'
    time.textContent = dateOf(doc.updatedAt)
    body.append(title, time)

    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.append(
      iconButton('複製', '⧉', () => duplicate(doc.id)),
      iconButton('削除', '✕', () => remove(doc.id))
    )

    li.append(body, actions)
    body.addEventListener('click', () => openDoc(doc.id))
    el.list.appendChild(li)
  }

  el.count.textContent = `${state.store.docs.length} 件${state.store.rev ? ` / rev ${state.store.rev}` : ''}`
}

function renderTabs() {
  el.tabs.innerHTML = ''
  for (const id of state.openIds) {
    const doc = state.store.docs.find((d) => d.id === id)
    if (!doc) continue
    const tab = document.createElement('div')
    tab.className = `tab${id === state.activeId ? ' active' : ''}`

    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = doc.title || '無題'
    label.addEventListener('click', () => openDoc(id))

    const close = document.createElement('button')
    close.className = 'close'
    close.textContent = '✕'
    close.title = 'タブを閉じる'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(id)
    })

    tab.append(label, close)
    el.tabs.appendChild(tab)
  }
}

function iconButton(title, text, onClick) {
  const b = document.createElement('button')
  b.className = 'icon'
  b.title = title
  b.textContent = text
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return b
}

// ---------------------------------------------------------------- 編集

function activeDoc() {
  return state.store.docs.find((d) => d.id === state.activeId) || null
}

/** 選んでいる文書をテキスト欄とマップに載せ直す */
function loadEditor() {
  const doc = activeDoc()
  el.src.value = doc ? doc.markdown : ''
  drawMap()
}

async function drawMap() {
  const token = ++drawToken
  const doc = activeDoc()
  if (!doc) {
    el.map.innerHTML = ''
    return
  }
  await renderMindmap(el.map, doc.markdown, {
    emptyText: 'Markdownを入力するとマインドマップになります',
    // マップ上で枝を編集したときは、テキスト欄だけ追従させる(描き直すとカーソルが飛ぶ)
    onChange: (next) => {
      if (token !== drawToken) return
      el.src.value = next
      applyMarkdown(next)
    },
  })
}

/** 中身の変更を1か所で受ける。名前は中心ノードから拾う */
function applyMarkdown(markdown) {
  const doc = activeDoc()
  if (!doc) return
  doc.markdown = markdown
  doc.title = Store.titleOf(markdown)
  doc.updatedAt = new Date().toISOString()
  markDirty()
  renderList()
  renderTabs()
}

function markDirty() {
  state.dirty = true
  state.error = ''
  renderStatus()
  scheduleSave()
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => save({ silent: true }), AUTOSAVE_MS)
}

// ---------------------------------------------------------------- 文書の操作

function openDoc(id) {
  if (!state.openIds.includes(id)) state.openIds.push(id)
  state.activeId = id
  persistUi()
  render()
  loadEditor()
}

function closeTab(id) {
  const i = state.openIds.indexOf(id)
  if (i < 0) return
  state.openIds.splice(i, 1)
  if (state.activeId === id) state.activeId = state.openIds[Math.min(i, state.openIds.length - 1)] || null
  persistUi()
  render()
  loadEditor()
}

function create() {
  const doc = Store.newDoc()
  state.store.docs.push(doc)
  markDirty()
  openDoc(doc.id)
  el.src.focus()
  el.src.setSelectionRange(el.src.value.length, el.src.value.length)
}

function duplicate(id) {
  const doc = state.store.docs.find((d) => d.id === id)
  if (!doc) return
  const copy = Store.duplicateDoc(doc)
  state.store.docs.push(copy)
  markDirty()
  openDoc(copy.id)
}

function remove(id) {
  const doc = state.store.docs.find((d) => d.id === id)
  if (!doc) return
  if (!confirm(`「${doc.title || '無題'}」を削除します。よろしいですか？`)) return
  state.store.docs = state.store.docs.filter((d) => d.id !== id)
  const i = state.openIds.indexOf(id)
  if (i >= 0) state.openIds.splice(i, 1)
  if (state.activeId === id) state.activeId = state.openIds[Math.min(i, state.openIds.length - 1)] || null
  persistUi()
  markDirty()
  render()
  loadEditor()
}

// ---------------------------------------------------------------- 保存

async function save({ silent = false } = {}) {
  clearTimeout(saveTimer)
  if (state.locked) return
  if (state.saving) {
    state.queued = true
    return
  }
  state.saving = true
  state.error = ''
  renderStatus()

  try {
    if (state.settings.encrypt && !state.pass) {
      const pass = await askPass('暗号化して保存します。パスフレーズを入力してください。')
      if (!pass) throw new Error('パスフレーズが未入力のため保存できません')
      state.pass = pass
    }

    const next = { ...state.store, rev: state.store.rev + 1, updatedAt: new Date().toISOString() }
    const bin = new Store.Jsonbin(state.settings)

    if (bin.configured) {
      // 別の端末が先に書いていないか、版数だけ見て確かめる(暗号化していても外から読める)
      let remote = null
      try {
        remote = await bin.read()
      } catch {
        /* 読めないときは衝突判定を諦めて、そのまま書きにいく */
      }
      if (remote && Store.revOf(remote) > state.store.rev) {
        const ok = confirm(
          `保存先が別の場所で更新されています(保存先 rev ${Store.revOf(remote)} / 手元 rev ${state.store.rev})。\n` +
            '手元の内容で上書きしますか？\nキャンセルすると保存せず、あとで「再読込」できます。'
        )
        if (!ok) throw new Error('保存を中止しました(再読込してください)')
        next.rev = Store.revOf(remote) + 1
      }
      const record = await Store.toRecord(next, { encrypt: state.settings.encrypt, pass: state.pass })
      await bin.write(record)
      Store.writeCache(record)
    } else {
      const record = await Store.toRecord(next, { encrypt: state.settings.encrypt, pass: state.pass })
      Store.writeCache(record)
    }

    state.store = next
    state.dirty = false
    state.savedAt = new Date()
  } catch (err) {
    state.error = err.message || String(err)
    if (!silent) alert(state.error)
  } finally {
    state.saving = false
    renderList()
    renderStatus()
    if (state.queued) {
      state.queued = false
      scheduleSave()
    }
  }
}

// ---------------------------------------------------------------- パスフレーズ

let passResolve = null

function askPass(note) {
  $('passNote').textContent = note
  $('passInput').value = ''
  $('passRemember').checked = state.settings.rememberPass
  setPassMsg('')
  el.passDialog.showModal()
  $('passInput').focus()
  return new Promise((resolve) => {
    passResolve = resolve
  })
}

function setPassMsg(text, isError = false) {
  const msg = $('passMsg')
  msg.textContent = text
  msg.className = `msg${isError ? ' error' : ''}`
}

$('passOk').addEventListener('click', () => {
  const pass = $('passInput').value
  if (!pass) return setPassMsg('パスフレーズを入力してください', true)
  state.settings.rememberPass = $('passRemember').checked
  Store.saveSettings(state.settings)
  Store.rememberPass(state.settings.rememberPass ? pass : '')
  const resolve = passResolve
  passResolve = null
  el.passDialog.close()
  resolve?.(pass)
})

$('passCancel').addEventListener('click', () => {
  const resolve = passResolve
  passResolve = null
  el.passDialog.close()
  resolve?.(null)
})

$('passInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('passOk').click()
})

// Escで閉じられても待っている側が止まらないようにする
el.passDialog.addEventListener('close', () => {
  passResolve?.(null)
  passResolve = null
})

// ---------------------------------------------------------------- 設定

function openSettings() {
  $('binId').value = state.settings.binId
  $('keyType').value = state.settings.keyType
  $('apiKey').value = state.settings.apiKey
  $('encrypt').checked = state.settings.encrypt
  $('pass1').value = state.pass
  $('pass2').value = state.pass
  $('rememberPass').checked = state.settings.rememberPass
  setSettingsMsg('')
  el.settingsDialog.showModal()
}

function formSettings() {
  return {
    binId: $('binId').value.trim(),
    keyType: $('keyType').value,
    apiKey: $('apiKey').value.trim(),
    encrypt: $('encrypt').checked,
    rememberPass: $('rememberPass').checked,
  }
}

function setSettingsMsg(text, isError = false) {
  const msg = $('settingsMsg')
  msg.textContent = text
  msg.className = `msg${isError ? ' error' : ''}`
}

$('testBtn').addEventListener('click', async () => {
  setSettingsMsg('確認しています…')
  try {
    const record = await new Store.Jsonbin(formSettings()).read()
    const kind = Store.isSealed(record) ? '暗号化された内容' : `${Store.normalizeStore(record).docs.length} 件`
    setSettingsMsg(`接続できました(${kind} / rev ${Store.revOf(record)})`)
  } catch (err) {
    setSettingsMsg(err.message, true)
  }
})

$('createBinBtn').addEventListener('click', async () => {
  setSettingsMsg('作成しています…')
  try {
    const form = formSettings()
    if (form.encrypt && !$('pass1').value) throw new Error('暗号化するにはパスフレーズを先に入力してください')
    const record = await Store.toRecord(state.store, { encrypt: form.encrypt, pass: $('pass1').value })
    const id = await new Store.Jsonbin({ ...form, binId: '' }).create(record, 'mindmap2')
    $('binId').value = id
    setSettingsMsg(`Binを作成しました(ID: ${id})。「保存して反映」を押してください。`)
  } catch (err) {
    setSettingsMsg(err.message, true)
  }
})

$('settingsSave').addEventListener('click', async () => {
  const form = formSettings()
  const pass1 = $('pass1').value
  const pass2 = $('pass2').value

  if (form.encrypt) {
    if (!Store.cryptoAvailable()) return setSettingsMsg('この環境では暗号化を使えません(https か localhost で開いてください)', true)
    if (!pass1) return setSettingsMsg('パスフレーズを入力してください', true)
    if (pass1 !== pass2) return setSettingsMsg('パスフレーズが一致しません', true)
  }

  const destinationChanged =
    form.binId !== state.settings.binId || form.apiKey !== state.settings.apiKey || form.keyType !== state.settings.keyType

  state.settings = form
  state.pass = form.encrypt ? pass1 : ''
  Store.saveSettings(state.settings)
  Store.rememberPass(form.encrypt && form.rememberPass ? pass1 : '')
  el.settingsDialog.close()

  if (destinationChanged) {
    if (confirm('保存先が変わりました。新しい保存先から読み直しますか？\nキャンセルすると、今の内容を新しい保存先へ書き込みます。')) {
      await reload()
      return
    }
  }
  await save()
})

$('settingsCancel').addEventListener('click', () => el.settingsDialog.close())

// ---- 書き出し / 取り込み ----

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.store, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `mindmap2-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  setSettingsMsg('書き出しました')
})

$('importBtn').addEventListener('click', () => $('importFile').click())

$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const incoming = Store.normalizeStore(JSON.parse(await file.text()))
    if (!incoming.docs.length) throw new Error('マインドマップが入っていません')
    // idの衝突を避けるため、取り込んだものは常に新しいidにする
    for (const doc of incoming.docs) {
      state.store.docs.push({ ...Store.newDoc(doc.title), markdown: doc.markdown, title: doc.title })
    }
    markDirty()
    render()
    setSettingsMsg(`${incoming.docs.length} 件を取り込みました`)
  } catch (err) {
    setSettingsMsg(`取り込めませんでした: ${err.message}`, true)
  }
})

// ---------------------------------------------------------------- 画面の配線

el.newBtn.addEventListener('click', create)
el.emptyNewBtn.addEventListener('click', create)
el.saveBtn.addEventListener('click', () => save())
el.reloadBtn.addEventListener('click', () => reload())
el.settingsBtn.addEventListener('click', openSettings)

el.toggleList.addEventListener('click', () => {
  state.showList = !state.showList
  persistUi()
  render()
})

el.toggleSrc.addEventListener('click', () => {
  state.showSource = !state.showSource
  persistUi()
  render()
})

el.search.addEventListener('input', () => {
  state.filter = el.search.value
  renderList()
})

el.src.addEventListener('input', () => {
  applyMarkdown(el.src.value)
  clearTimeout(redrawTimer)
  redrawTimer = setTimeout(drawMap, REDRAW_MS)
})

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    save()
  }
})

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return
  e.preventDefault()
  e.returnValue = ''
})

function persistUi() {
  Store.saveUiState({
    openIds: state.openIds,
    activeId: state.activeId,
    showSource: state.showSource,
    showList: state.showList,
  })
}

// ---------------------------------------------------------------- 小物

function timeOf(date) {
  return new Date(date).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function dateOf(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
