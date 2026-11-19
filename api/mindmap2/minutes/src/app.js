// src/app.js — 議事録 v2（ClipStock と同じ作り：暗号化して GitHub private に保管、GAS 経由で書く）
import { GAS_URL, POLL_MS, CLAUDE_DEFAULT_URL, WORKER_EVERY_SEC } from './config.js'
import { openBundle, importPriv, newDek, sealJson, openJson, wrapDek, unwrapDek, rnd } from './crypto.js'
import { gas, repo } from './store.js'
import { bioOk, bioRegistered, bioRegister, bioUnlock, bioForget } from './bio.js'
import { fmtT, parseT, normalizeSummary, segmentsFromText, summarizeWithAI, transcriptText } from './summary.js'
import { parseSummaryText, summaryTypeLabel } from './summary-text.js'
import { loadSettings, saveSettings, newConnection, activeConnection, activeModelName, allModels, connectionOf } from './llm-settings.js'
import { streamChat } from './llm-client.js'

/* ---------- 小物 ---------- */
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)) },
  del(k) { localStorage.removeItem(k) },
}
const pad = (n) => String(n).padStart(2, '0')
const WD = ['日', '月', '火', '水', '木', '金', '土']
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const toDate = (s) => new Date(String(s || '').length >= 16 ? s : (s || '1970-01-01') + 'T00:00')
const md = (s) => { const d = toDate(s); return `${d.getMonth() + 1}/${d.getDate()}` }
const hm = (s) => String(s || '').slice(11, 16)
const fmtDur = (sec) => (sec ? fmtT(sec) : '—')
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
const newId = () => 'm_' + [...rnd(12)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'たった今' : m < 60 ? `${m}分前` : m < 1440 ? `${Math.round(m / 60)}時間前` : `${Math.round(m / 1440)}日前` }

const ADMIN_ROLE = 'xYz'
const ST = {
  tw: { l: '文字起こし待ち', c: 'st-tw' }, tr: { l: '文字起こし中', c: 'st-tr' },
  sw: { l: '要約待ち', c: 'st-sw' }, ok: { l: '要約済み', c: 'st-ok' }, err: { l: '失敗', c: 'st-err' },
}
const LOCK_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'

/* ---------- 状態 ---------- */
const S = {
  code: null, role: null, admin: false, gid: null, adminGid: null, roles: {}, privs: {}, gh: null, R: null,
  session: null, exp: 0, pub: {}, raw: [], items: [], byId: new Map(), worker: null, sig: '', syncedAt: 0, syncErr: '',
  tab: 'list', view: ls.get('m2.view', 'timeline'), month: monthKey(new Date()), filter: 'all', q: '', sel: null, dtab: 'sum',
  cfilter: 'all', checked: new Set(), busy: {}, chat: {}, trq: '', seek: null,
  files: {}, fav: new Set(ls.get('m2.fav', [])), seen: ls.get('m2.seen', {}), timer: 0,
}
const DEK = new Map()
const META = new Map()

/* ---------- ログイン ---------- */
function showGate(msg = '') {
  clearInterval(S.timer)
  $('#app').hidden = true
  $('#gate').hidden = false
  const bio = bioOk() && bioRegistered()
  $('#gate').innerHTML = `
    <div class="gate-card">
      <h1 class="gate-title">議事録</h1>
      <p class="gate-sub">暗号化して保管しています。開くには権限コードが必要です。</p>
      ${bio ? '<button class="btn main wide" data-act="bio">Face ID・Touch ID で開く</button><div class="gate-or">または</div>' : ''}
      <form id="loginForm" class="gate-form">
        <label for="code">権限コード</label>
        <input id="code" type="password" autocomplete="current-password" required>
        <button class="btn ${bio ? '' : 'main'} wide" type="submit">開く</button>
      </form>
      <p class="gate-msg" id="gateMsg" role="alert">${esc(msg)}</p>
      ${bio || ls.get('m2.seen', null) ? '<button class="link danger" data-act="reset">この端末の設定を消して、最初から設定する</button>' : ''}
    </div>`
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const code = $('#code').value.trim()
    if (!code) return
    await doLogin(code, true)
  })
  if (!bio) $('#code')?.focus()
}

async function doLogin(code, typed) {
  const m = $('#gateMsg')
  if (m) m.textContent = '確認しています…'
  $$('#gate button').forEach((b) => { b.disabled = true })
  try {
    if (GAS_URL.includes('ここに')) throw new Error('src/config.js の GAS_URL が未設定です。')
    await login(code)
    await start()
    if (typed && bioOk() && !bioRegistered() && !ls.get('m2.bioAsked', false)) askBio()
  } catch (e) {
    S.code = null
    showGate(e.message || '開けませんでした。')
  }
}

async function login(code) {
  const d = await gas('login', { code })
  let b
  try { b = await openBundle(code, d.bundle) } catch { throw new Error('鍵束を開けませんでした（管理者に連絡してください）') }
  S.code = code
  S.role = d.role; S.admin = !!d.admin; S.gid = d.gid; S.adminGid = d.adminGid
  S.session = d.session; S.exp = d.exp
  S.gh = b.gh; S.R = repo(b.gh)
  S.roles = b.roles || { [d.role]: d.gid }
  S.privs = {}
  for (const [g, jwk] of Object.entries(b.keys || {})) S.privs[g] = await importPriv(jwk)
}

async function ensureSession() {
  if (Date.now() < S.exp - 120000) return
  const d = await gas('login', { code: S.code })
  S.session = d.session; S.exp = d.exp
}

async function gasS(action, body) {
  await ensureSession()
  return gas(action, { session: S.session, ...body })
}

function lock() {
  clearInterval(S.timer)
  Object.assign(S, { code: null, privs: {}, gh: null, R: null, session: null, raw: [], items: [], files: {}, chat: {}, sel: null, sig: '' })
  S.byId = new Map(); DEK.clear(); META.clear()
  closeModal()
  showGate()
}

function askBio() {
  ls.set('m2.bioAsked', true)
  modal('Face ID・Touch ID', `
    <p>次から、権限コードを入れずに Face ID・Touch ID で開けるようにしますか？ 権限コードはこの端末の中だけに、生体認証で包んで置きます。</p>
    <div class="acts"><button class="btn main" data-act="bioReg">登録する</button><button class="btn" data-act="close">今はしない</button></div>
    <p class="msg" id="bioMsg"></p>`)
}

/* ---------- 読み込み ---------- */
async function start() {
  $('#gate').hidden = true
  $('#app').hidden = false
  await refresh(true)
  clearInterval(S.timer)
  S.timer = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
}

async function refresh(first = false) {
  if (!S.R) return
  try {
    const [idx, pub, wk] = await Promise.all([
      S.R.json('index.json'),
      first || !Object.keys(S.pub).length ? S.R.json('pub.json') : Promise.resolve(null),
      S.R.json('worker.json').catch(() => null),
    ])
    if (pub) S.pub = pub
    S.worker = wk
    const raw = Array.isArray(idx) ? idx : []
    const sig = JSON.stringify(raw.map((e) => [e.id, e.upd, e.st]))
    S.syncErr = ''
    S.syncedAt = Date.now()
    if (first || sig !== S.sig) {
      S.sig = sig
      S.raw = raw
      await decryptAll()
      render()
    } else {
      paintSync()
      if (S.tab === 'convert') renderMain()
    }
  } catch (e) {
    S.syncErr = e.message
    if (first) render()
    paintSync()
  }
}

async function decryptAll() {
  const out = []
  for (const e of S.raw) {
    const gid = Object.keys(e.k || {}).find((g) => S.privs[g])
    const base = { ...e, day: String(e.date || '').slice(0, 10) }
    if (!gid) { out.push({ ...base, locked: true, title: '非公開の会議', tags: [] }); continue }
    try {
      let dek = DEK.get(e.id)
      if (!dek) { dek = await unwrapDek(e.k[gid], S.privs[gid]); DEK.set(e.id, dek) }
      let meta = META.get(e.id)
      if (!meta || meta.iv !== e.m?.iv) { meta = { iv: e.m.iv, v: await openJson(dek, e.m) }; META.set(e.id, meta) }
      out.push({ ...base, locked: false, title: meta.v.title || '（無題）', tags: meta.v.tags || [], file: meta.v.file || null })
    } catch {
      out.push({ ...base, locked: true, title: '開けない議事録', tags: [] })
    }
  }
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  S.items = out
  S.byId = new Map(out.map((x) => [x.id, x]))
  if (S.sel && !S.byId.has(S.sel)) S.sel = null
}

/** 会議のファイル（t: 文字起こし, s: 要約, n: メモ）。復号して、更新されるまでは使い回す */
function cached(it, name) {
  const c = S.files[it.id]
  return c && c.upd === it.upd && name in c ? c[name] : undefined
}

function file(it, name) {
  if (it.locked) return Promise.resolve(null)
  let c = S.files[it.id]
  if (!c || c.upd !== it.upd) c = S.files[it.id] = { upd: it.upd, p: {} }
  if (name in c) return Promise.resolve(c[name])
  if (c.p[name]) return c.p[name]
  c.p[name] = (async () => {
    try {
      const v = await S.R.json(`m/${it.id}/${name}.json`)
      const o = v ? await openJson(DEK.get(it.id), v) : null
      if (S.files[it.id] === c) c[name] = o
      return o
    } finally { delete c.p[name] }
  })()
  return c.p[name]
}

/** 書き込みの結果を一覧に反映する（GitHub を読み直さずにすぐ表示を変える） */
async function applyEntry(entry, plain = {}, deleted = false) {
  const i = S.raw.findIndex((x) => x.id === (entry?.id || plain.id))
  if (deleted) { if (i >= 0) S.raw.splice(i, 1) } else if (i >= 0) S.raw[i] = entry; else S.raw.push(entry)
  if (!deleted) {
    const prev = S.files[entry.id] || {}
    const keep = {}
    for (const k of ['t', 's', 'n']) if (k in prev && !(k in plain)) keep[k] = prev[k]
    S.files[entry.id] = { upd: entry.upd, p: {}, ...keep, ...plain }
  }
  S.sig = JSON.stringify(S.raw.map((e) => [e.id, e.upd, e.st]))
  await decryptAll()
  render()
}

/* ---------- 表示：共通 ---------- */
function render() {
  paintHeader()
  renderMain()
  paintSync()
}

function paintSync() {
  const el = $('#sync')
  if (!el) return
  el.textContent = S.syncErr ? `同期できません：${S.syncErr}` : S.syncedAt ? `同期済み・${ago(S.syncedAt)}` : ''
  el.classList.toggle('bad', !!S.syncErr)
}

function procCount() {
  return S.items.filter((x) => !x.locked && ['tw', 'tr', 'sw', 'err'].includes(x.st)).length
}

function paintHeader() {
  const n = procCount()
  $$('[data-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === S.tab)
    b.setAttribute('aria-current', b.dataset.tab === S.tab ? 'page' : 'false')
    const badge = b.querySelector('.badge')
    if (badge) { badge.textContent = n; badge.hidden = !n }
  })
  $('#searchBox').hidden = S.tab !== 'list'
  $('#role').textContent = S.admin ? '管理者' : (S.role || '')
}

function renderMain() {
  const m = $('#main')
  if (S.tab === 'list') m.innerHTML = listHTML()
  else if (S.tab === 'notes') m.innerHTML = notesHTML()
  else m.innerHTML = convertHTML()
  if (S.tab === 'list') afterList()
  if (S.tab === 'notes') kickNotes()
}

const stChip = (it) => {
  if (S.busy[it.id]) return `<span class="chip st-busy" data-busy="${it.id}">${esc(S.busy[it.id])}</span>`
  const s = ST[it.st] || ST.tw
  return `<span class="chip ${s.c}">${s.l}</span>`
}
const isNew = (it) => !it.locked && Date.now() - (it.upd || 0) < 86400000 && S.seen[it.id] !== it.upd

/* ---------- 一覧 ---------- */
function monthItems() {
  return S.items.filter((x) => (x.date || '').startsWith(S.month))
}

function filtered() {
  const q = S.q.trim().toLowerCase()
  return monthItems().filter((x) => {
    if (S.filter === 'ok' && x.st !== 'ok') return false
    if (S.filter === 'proc' && !['tw', 'tr', 'sw', 'err'].includes(x.st)) return false
    if (S.filter === 'fav' && !S.fav.has(x.id)) return false
    if (q) {
      if (x.locked) return false
      const s = cached(x, 's')
      const hay = [x.title, ...(x.tags || []), s?.cardSummary || '', s?.summary || ''].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

function byDay(items) {
  const g = new Map()
  for (const it of items) { const k = it.day || '日付なし'; if (!g.has(k)) g.set(k, []); g.get(k).push(it) }
  for (const v of g.values()) v.sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  return [...g.entries()]
}

function dayLabel(k) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return { d: k, w: '' }
  const d = toDate(k)
  return { d: `${d.getMonth() + 1}月${d.getDate()}日`, w: WD[d.getDay()] + (k === todayKey() ? '・今日' : '') }
}

function listHTML() {
  const mi = monthItems()
  const cnt = { all: mi.length, ok: mi.filter((x) => x.st === 'ok').length, proc: mi.filter((x) => ['tw', 'tr', 'sw', 'err'].includes(x.st)).length, fav: mi.filter((x) => S.fav.has(x.id)).length }
  const [y, mo] = S.month.split('-')
  const cards = S.view === 'cards'
  const items = filtered()
  const sel = S.sel ? S.byId.get(S.sel) : null
  const chips = [['all', 'すべて'], ['ok', '要約済み'], ['proc', '処理中'], ['fav', '★ お気に入り']]
    .map(([k, l]) => `<button class="fchip ${S.filter === k ? 'on' : ''}" data-act="filter" data-v="${k}" aria-pressed="${S.filter === k}">${l} ${cnt[k]}</button>`).join('')
  return `
    <div class="toolbar">
      <div class="monthnav">
        <button class="ib" data-act="month" data-d="-1" aria-label="前の月">‹</button>
        <span class="month">${Number(y)}年${Number(mo)}月</span>
        <button class="ib" data-act="month" data-d="1" aria-label="次の月">›</button>
      </div>
      <div class="fchips">${chips}</div>
      <span class="grow"></span>
      <div class="seg" role="group" aria-label="表示の切り替え">
        <button data-act="view" data-v="timeline" aria-pressed="${!cards}" class="${!cards ? 'on' : ''}">タイムライン</button>
        <button data-act="view" data-v="cards" aria-pressed="${cards}" class="${cards ? 'on' : ''}">カード</button>
      </div>
    </div>
    ${cards ? stripHTML(mi) : ''}
    <div class="split ${sel ? 'has-sel' : ''} ${cards ? 'cards' : 'tl'}">
      <section class="listpane" aria-label="議事録の一覧">${items.length ? (cards ? cardsHTML(items) : timelineHTML(items)) : emptyListHTML(mi.length)}</section>
      <section class="detail" id="detail" aria-label="議事録の詳細">${detailHTML(sel)}</section>
    </div>`
}

function emptyListHTML(any) {
  if (any) return '<p class="empty">条件に合う議事録がありません。絞り込みを「すべて」に戻してください。</p>'
  return '<div class="empty"><p>この月の議事録はまだありません。</p><button class="btn main" data-act="upload">議事録を登録</button></div>'
}

function timelineHTML(items) {
  return byDay(items).map(([k, list]) => {
    const l = dayLabel(k)
    return `<div class="day" id="d-${esc(k)}">
      <div class="dayhead"><span class="dd">${l.d}</span><span class="dw">${l.w}</span><span class="rule"></span><span class="dc">${list.length}件</span></div>
      ${list.map((it) => `
        <div class="tl-row">
          <div class="tl-time">${hm(it.date) || '—'}</div>
          <div class="tl-rail"><span class="tl-line"></span><span class="tl-dot ${(ST[it.st] || ST.tw).c}"></span><span class="tl-line grow"></span></div>
          <button class="tl-card ${S.sel === it.id ? 'sel' : ''}" data-act="open" data-id="${it.id}">
            <span class="tl-top"><span class="tl-title">${esc(it.title)}</span>${it.locked ? LOCK_SVG : ''}${isNew(it) ? '<span class="new">新着</span>' : ''}${stChip(it)}</span>
            <span class="tl-meta"><span class="bar ${(ST[it.st] || ST.tw).c}" style="width:${Math.round(Math.min(it.dur || 0, 7200) / 7200 * 110) + 6}px"></span>${fmtDur(it.dur)}${it.tags?.length ? ' ・ ' + esc(it.tags.join('・')) : ''}</span>
          </button>
        </div>`).join('')}
    </div>`
  }).join('')
}

function cardLead(it) {
  if (it.locked) return '閲覧できるグループに入ると表示されます。'
  const s = cached(it, 's')
  if (s?.cardSummary || s?.summary) return s.cardSummary || s.summary
  return { tw: 'Mac で文字起こしの順番待ちです。', tr: 'Mac で文字起こししています。', sw: '文字起こし済み。要約待ちです。', err: '処理に失敗しました。変換管理から再実行できます。', ok: '要約を読み込んでいます…' }[it.st] || ''
}

function cardsHTML(items) {
  return byDay(items).map(([k, list]) => {
    const l = dayLabel(k)
    return `<div class="day" id="d-${esc(k)}">
      <div class="dayhead"><span class="dd">${l.d}</span><span class="dw">${l.w}</span><span class="rule"></span></div>
      <div class="cardgrid">${list.map((it) => `
        <button class="mcard ${S.sel === it.id ? 'sel' : ''}" data-act="open" data-id="${it.id}">
          <span class="mc-top"><span class="mc-time">${hm(it.date) || '—'}</span><span class="mc-dur">${fmtDur(it.dur)}</span><span class="grow"></span>${stChip(it)}</span>
          <span class="mc-title">${esc(it.title)}${it.locked ? LOCK_SVG : ''}${isNew(it) ? '<span class="new">新着</span>' : ''}</span>
          <span class="mc-lead">${esc(cardLead(it))}</span>
        </button>`).join('')}</div>
    </div>`
  }).join('')
}

function stripHTML(mi) {
  const [y, m] = S.month.split('-').map(Number)
  const days = new Date(y, m, 0).getDate()
  const by = new Map()
  for (const it of mi) { if (!by.has(it.day)) by.set(it.day, []); by.get(it.day).push(it) }
  const today = todayKey()
  let h = ''
  for (let d = 1; d <= days; d++) {
    const k = `${S.month}-${pad(d)}`
    const list = by.get(k) || []
    const bars = list.map((it) => `<span class="sb ${(ST[it.st] || ST.tw).c}" style="height:${Math.max(4, Math.round(Math.min(it.dur || 1800, 7200) / 7200 * 40))}px"></span>`).join('')
    h += `<button class="sday ${k === today ? 'today' : ''}" ${list.length ? `data-act="jump" data-day="${k}"` : 'disabled'} aria-label="${m}月${d}日 ${list.length}件"><span class="sbars">${bars}</span><span class="sn">${d}</span></button>`
  }
  return `<div class="strip"><div class="strip-in">${h}</div></div>`
}

/** 一覧を描いたあと：カードの要約・検索用に要約を先読みし、詳細のファイルを読む */
function afterList() {
  const sel = S.sel ? S.byId.get(S.sel) : null
  if (sel) loadDetail(sel)
  if (S.view === 'cards' || S.q) prefetch(monthItems().filter((x) => !x.locked && x.st === 'ok' && cached(x, 's') === undefined), 's')
}

let prefetchRun = 0
async function prefetch(list, name) {
  if (!list.length) return
  const run = ++prefetchRun
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map((it) => file(it, name).catch(() => null)))
    if (run !== prefetchRun) return
  }
  if (S.tab === 'list') { const keep = $('.listpane')?.scrollTop; renderMain(); const lp = $('.listpane'); if (lp && keep) lp.scrollTop = keep }
}

/* ---------- 詳細 ---------- */
const NEED = { sum: ['s'], todo: ['s', 'n'], tr: ['t'], chat: ['s', 't'], memo: ['n'] }

function loadDetail(it) {
  if (it.locked) return
  const need = NEED[S.dtab].filter((n) => cached(it, n) === undefined)
  if (!need.length) return
  Promise.all(need.map((n) => file(it, n))).then(() => {
    if (S.sel === it.id && S.tab === 'list') paintDetail()
  }).catch((e) => toast(e.message, true))
}

function paintDetail() {
  const el = $('#detail')
  if (!el) return
  const it = S.sel ? S.byId.get(S.sel) : null
  const sc = el.querySelector('.sheet-scroll')?.scrollTop
  el.innerHTML = detailHTML(it)
  if (sc) { const s2 = el.querySelector('.sheet-scroll'); if (s2) s2.scrollTop = sc }
  const f = S.seek && !S.seek.scrolled && el.querySelector('.seg-row.flash')
  if (f) { S.seek.scrolled = true; f.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
  if (it) loadDetail(it)
}

function metaLine(it) {
  const s = cached(it, 's')
  const tail = it.st === 'ok' ? (s?.model || '要約済み') : (ST[it.st] || ST.tw).l
  return `${it.src === 'text' ? 'テキスト' : '会議'} ・ ${md(it.date)} ${hm(it.date)} ・ ${fmtDur(it.dur)} ・ ${esc(tail)}`
}

function detailHTML(it) {
  const cards = S.view === 'cards'
  if (!it) return cards ? '' : '<div class="empty big"><p>一覧から議事録を選んでください。</p></div>'
  const back = `<button class="btn back" data-act="close-detail">${cards ? '✕ 閉じる' : '‹ 一覧へ'}</button>`
  if (it.locked) {
    return `<div class="dhead">${back}<div class="dtitle"><h1>${esc(it.title)}</h1><div class="dmeta">${md(it.date)} ${hm(it.date)} ・ ${fmtDur(it.dur)}</div></div></div>
      <div class="lockpanel">${LOCK_SVG}<p class="strong">この議事録を見る権限がありません</p><p>日時と長さだけ表示しています。タイトルと内容は、閲覧できるグループの鍵がある端末でだけ開けます。</p></div>`
  }
  const canEdit = S.admin || it.by === S.gid
  const canDel = S.admin || (it.by === S.gid && ['tw', 'err'].includes(it.st))
  const hasT = ['sw', 'ok'].includes(it.st)
  const acts = [
    `<button class="btn sm" data-act="fav" data-id="${it.id}" aria-pressed="${S.fav.has(it.id)}">${S.fav.has(it.id) ? '★ お気に入り' : '☆ お気に入り'}</button>`,
    hasT ? `<button class="btn sm" data-act="summarize" data-id="${it.id}" ${S.busy[it.id] ? 'disabled' : ''}>${it.st === 'ok' ? '再要約' : '要約する'}</button>` : '',
    it.st === 'sw' ? '<button class="btn sm" data-act="claude">Claude.ai で要約</button>' : '',
    canEdit ? `<button class="btn sm" data-act="edit" data-id="${it.id}">タイトル・タグ</button>` : '',
    S.admin ? `<button class="btn sm" data-act="groups" data-id="${it.id}">閲覧グループ</button>` : '',
    canDel ? `<button class="btn sm danger" data-act="delete" data-id="${it.id}">削除</button>` : '',
  ].join('')
  const tabs = [['sum', '要約'], ['todo', 'ToDo'], ['tr', '文字起こし'], ['chat', 'チャット'], ['memo', 'メモ']]
    .map(([k, l]) => `<button class="dtab ${S.dtab === k ? 'on' : ''}" data-act="dtab" data-v="${k}" aria-pressed="${S.dtab === k}">${l}${k === 'todo' && cached(it, 's')?.todos?.length ? ' ' + cached(it, 's').todos.length : ''}</button>`).join('')
  return `
    <div class="dhead">${back}
      <div class="dtitle"><h1>${esc(it.title)}${isNew(it) ? '<span class="new">新着</span>' : ''}</h1><div class="dmeta">${metaLine(it)}</div></div>
      <div class="dacts">${acts}</div>
    </div>
    <nav class="dtabs" aria-label="詳細の切り替え">${tabs}</nav>
    <div class="sheet-scroll"><div class="sheet">${tabBody(it)}</div></div>`
}

const tchip = (t) => (t && parseT(t) != null ? `<button class="tchip" data-act="seek" data-t="${esc(t)}" aria-label="${esc(t)} の発言へ">${esc(t)}</button>` : '')
const loadingHTML = '<p class="muted">読み込んでいます…</p>'

function tabBody(it) {
  switch (S.dtab) {
    case 'sum': return sumBody(it)
    case 'todo': return todoBody(it)
    case 'tr': return trBody(it)
    case 'chat': return chatBody(it)
    default: return memoBody(it)
  }
}

function sumBody(it) {
  const s = cached(it, 's')
  if (s === undefined) return loadingHTML
  if (!s) {
    if (['tw', 'tr'].includes(it.st)) return '<p class="muted">Mac の文字起こしが終わると、要約できるようになります。</p>'
    if (it.st === 'err') return `<p class="muted">処理に失敗しました${it.err ? `（${esc(it.err)}）` : ''}。変換管理から再実行できます。</p>`
    return `<div class="sumwait"><p>まだ要約されていません。</p><div class="acts"><button class="btn main" data-act="summarize" data-id="${it.id}" ${S.busy[it.id] ? 'disabled' : ''}>${S.busy[it.id] ? esc(S.busy[it.id]) : '要約する（' + esc(activeModelName(loadSettings()) || 'AI未設定') + '）'}</button><button class="btn" data-act="claude">Claude.ai で要約</button></div></div>`
  }
  const sec = (title, body) => `<section class="ssec"><h2>${title}</h2>${body}</section>`
  const bullets = (arr) => `<ul class="dots">${arr.map((p) => `<li><span>${esc(p.text)} ${tchip(p.t)}</span></li>`).join('')}</ul>`
  return `<div class="read">
    ${sec('サマリ', `<p>${esc(s.summary || s.cardSummary || '')}</p>`)}
    ${s.decisions.length ? sec('決定事項', bullets(s.decisions)) : ''}
    ${s.agenda.length ? sec('論点別', s.agenda.map((a) => `
      <div class="topic">
        <h3>${esc(a.topic)} ${tchip(a.t)}</h3>
        ${a.points.length ? bullets(a.points) : ''}
        ${a.outcome ? `<p class="outcome"><span class="ol">結論</span>${esc(a.outcome)}</p>` : ''}
      </div>`).join('')) : ''}
    ${s.topics.length ? sec('未解決の論点', `<ul class="dots">${s.topics.map((t) => `<li><span>${esc(t)}</span></li>`).join('')}</ul>`) : ''}
    <p class="foot">要約：${esc(s.model || '—')} ・ 時刻を押すと、その発言を文字起こしで表示します</p>
  </div>`
}

function todoBody(it) {
  const s = cached(it, 's'), n = cached(it, 'n')
  if (s === undefined || n === undefined) return loadingHTML
  const todos = s?.todos || []
  if (!todos.length) return '<p class="muted">この会議の ToDo はありません。要約すると、宿題がここに並びます。</p>'
  const done = n?.done || {}
  return `<div class="read"><ul class="todos">${todos.map((t, i) => `
    <li class="${done[i] ? 'done' : ''}"><label><input type="checkbox" data-todo="${it.id}" data-i="${i}" ${done[i] ? 'checked' : ''}><span class="tt">${esc(t.text)}</span></label>
    <span class="tm">${t.owner ? '担当：' + esc(t.owner) : ''}${t.owner && t.due ? ' ・ ' : ''}${t.due ? '期限：' + esc(t.due) : ''}</span></li>`).join('')}</ul></div>`
}

function trBody(it) {
  const t = cached(it, 't')
  if (t === undefined) return loadingHTML
  if (!t?.segments?.length) return `<p class="muted">${['tw', 'tr'].includes(it.st) ? 'まだ文字起こしされていません。Mac の次の確認で始まります。' : '文字起こしがありません。'}</p>`
  const q = S.trq.trim()
  let target = -1
  if (S.seek) t.segments.forEach((x, i) => { if (x.t != null && x.t <= S.seek.t) target = i })
  if (S.seek && target < 0) target = 0
  return `<div class="read tr">
    <div class="trbar"><label for="trq" class="sr">文字起こし内を検索</label><input id="trq" type="search" placeholder="文字起こし内を検索" value="${esc(q)}"><button class="btn sm" data-act="copy-tr" data-id="${it.id}">コピー</button></div>
    <div class="segs">${t.segments.map((x, i) => {
      const hit = q && x.s.includes(q)
      return `<div class="seg-row ${hit ? 'hit' : ''} ${i === target ? 'flash' : ''}" data-t="${x.t ?? ''}" id="seg-${i}"><span class="seg-t">${x.t != null ? fmtT(x.t) : ''}</span><span class="seg-s">${hit ? esc(x.s).split(esc(q)).join(`<mark>${esc(q)}</mark>`) : esc(x.s)}</span></div>`
    }).join('')}</div>
  </div>`
}

function chatBody(it) {
  const msgs = S.chat[it.id] || []
  return `<div class="read chat">
    <div class="msgs" id="msgs">${msgs.length ? msgs.map((m) => `<div class="msg-b ${m.role}">${esc(m.content) || '…'}</div>`).join('') : '<p class="muted">この会議について質問できます（' + esc(activeModelName(loadSettings()) || 'AI未設定') + '）。答えには根拠の時刻を添えます。</p>'}</div>
    <form class="ask" data-chat="${it.id}"><label for="askIn" class="sr">質問</label><textarea id="askIn" rows="2" placeholder="この会議について質問する"></textarea><button class="btn main" type="submit">送信</button></form>
  </div>`
}

function memoBody(it) {
  const n = cached(it, 'n')
  if (n === undefined) return loadingHTML
  return `<div class="read">
    <label for="memoIn" class="lbl">メモ（同じグループの人にも見えます）</label>
    <textarea id="memoIn" rows="10">${esc(n?.memo || '')}</textarea>
    <div class="acts"><button class="btn main" data-act="memo-save" data-id="${it.id}">メモを保存</button><span class="muted" id="memoMsg"></span></div>
  </div>`
}

/* ---------- ノート（ToDo の横断） ---------- */
function notesHTML() {
  const list = monthItems().filter((x) => !x.locked && x.st === 'ok')
  const [y, mo] = S.month.split('-')
  const rows = list.map((it) => {
    const s = cached(it, 's'), n = cached(it, 'n')
    if (s === undefined || n === undefined) return `<div class="nblock"><h3>${esc(it.title)}</h3><p class="muted">読み込んでいます…</p></div>`
    const todos = s?.todos || []
    if (!todos.length) return ''
    const done = n?.done || {}
    const open = todos.filter((_, i) => !done[i]).length
    return `<div class="nblock">
      <div class="nhead"><button class="link" data-act="open" data-id="${it.id}" data-go="todo">${esc(it.title)}</button><span class="muted">${md(it.date)} ・ 残り ${open} / ${todos.length}</span></div>
      <ul class="todos">${todos.map((t, i) => `<li class="${done[i] ? 'done' : ''}"><label><input type="checkbox" data-todo="${it.id}" data-i="${i}" ${done[i] ? 'checked' : ''}><span class="tt">${esc(t.text)}</span></label><span class="tm">${t.owner ? '担当：' + esc(t.owner) : ''}${t.owner && t.due ? ' ・ ' : ''}${t.due ? '期限：' + esc(t.due) : ''}</span></li>`).join('')}</ul>
    </div>`
  }).join('')
  return `<div class="page">
    <div class="toolbar">
      <div class="monthnav"><button class="ib" data-act="month" data-d="-1" aria-label="前の月">‹</button><span class="month">${Number(y)}年${Number(mo)}月の ToDo</span><button class="ib" data-act="month" data-d="1" aria-label="次の月">›</button></div>
    </div>
    <div class="notes">${rows || '<p class="empty">この月の要約済みの議事録に ToDo はありません。</p>'}</div>
  </div>`
}

function kickNotes() {
  const list = monthItems().filter((x) => !x.locked && x.st === 'ok' && (cached(x, 's') === undefined || cached(x, 'n') === undefined))
  if (!list.length) return
  ;(async () => {
    for (let i = 0; i < list.length; i += 4) {
      await Promise.all(list.slice(i, i + 4).flatMap((it) => [file(it, 's'), file(it, 'n')]).map((p) => p.catch(() => null)))
    }
    if (S.tab === 'notes') renderMain()
  })()
}

/* ---------- 変換管理 ---------- */
function workerLine() {
  const w = S.worker
  if (!w?.at) return { ok: false, t: 'Mac から、まだ確認の記録が届いていません。', s: 'Mac で minutes_worker を設定してください。' }
  const every = (w.every || WORKER_EVERY_SEC) * 1000
  const late = Date.now() - w.at > every * 4
  const busy = w.busy ? S.byId.get(w.busy) : null
  return {
    ok: !late,
    t: late ? 'Mac から応答がありません' : (busy ? `Mac が文字起こし中：${busy.title}` : 'Mac mini 監視中'),
    s: `最終確認 ${ago(w.at)}（${Math.round(every / 60000)}分おき）${w.asr ? ' ・ ' + esc(w.asr) : ''}`,
  }
}

function convertHTML() {
  const vis = S.items
  const c = (k) => vis.filter((x) => x.st === k).length
  const steps = [['tw', '文字起こし待ち', 'Mac の次の確認で始まります'], ['tr', '文字起こし中', ''], ['sw', '要約待ち', 'AI を選んで要約'], ['ok', '要約済み', ''], ['err', '失敗', '再実行できます']]
  const w = workerLine()
  const settings = loadSettings()
  const models = allModels(settings)
  let rows = vis.filter((x) => S.cfilter === 'all' ? x.st !== 'ok' || Date.now() - (x.upd || 0) < 7 * 86400000 : x.st === S.cfilter)
  rows = rows.slice(0, 200)
  const swSel = [...S.checked].filter((id) => S.byId.get(id)?.st === 'sw')
  const swAll = vis.filter((x) => x.st === 'sw' && !x.locked)
  return `<div class="page conv">
    <div class="cv-top">
      <div class="panel wk"><span class="dot ${w.ok ? 'ok' : 'bad'}"></span><div class="grow"><div class="strong">${esc(w.t)}</div><div class="muted sm">${w.s}</div></div></div>
      <div class="panel"><div class="grow"><div class="strong">要約AI</div><div class="muted sm">URL で指定した AI（この端末の設定）</div></div>
        <label for="aiSel" class="sr">要約AI</label>
        <select id="aiSel">${models.length ? models.map((m) => `<option value="${esc(m.connectionId)}|${esc(m.model)}" ${m.active ? 'selected' : ''}>${esc(m.connectionLabel)}：${esc(m.model)}</option>`).join('') : '<option>未設定</option>'}</select>
        <button class="btn sm" data-act="settings">設定</button></div>
    </div>
    <div class="steps">${steps.map(([k, l, sub]) => `<button class="step ${S.cfilter === k ? 'on' : ''} ${k}" data-act="cfilter" data-v="${S.cfilter === k ? 'all' : k}" aria-pressed="${S.cfilter === k}"><span class="sl">${l}</span><span class="sn">${c(k)}</span><span class="ss">${sub}</span></button>`).join('')}</div>
    <div class="cv-acts">
      <button class="btn" data-act="check-sw">要約待ちを全選択</button>
      <button class="btn main" data-act="sum-selected" ${swSel.length ? '' : 'disabled'}>選択を要約する（${swSel.length}件）</button>
      <span class="grow"></span>
      <button class="btn gold" data-act="claude">Claude.ai で要約待ちを変換（${swAll.length}件）</button>
    </div>
    <div class="tablebox"><table class="ctable">
      <thead><tr><th><span class="sr">選択</span></th><th>日時</th><th>タイトル</th><th>長さ</th><th>登録</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map((it) => {
        const own = it.by === S.gid
        let act = ''
        if (it.locked) act = ''
        else if (it.st === 'sw') act = `<button class="btn sm" data-act="summarize" data-id="${it.id}" ${S.busy[it.id] ? 'disabled' : ''}>要約する</button>`
        else if (it.st === 'err') act = `<button class="btn sm" data-act="retry" data-id="${it.id}">再実行</button>${S.admin || own ? ` <button class="btn sm" data-act="delete" data-id="${it.id}">取り消す</button>` : ''}`
        else if (it.st === 'tw' && (S.admin || own)) act = `<button class="btn sm" data-act="delete" data-id="${it.id}">取り消す</button>`
        else if (it.st === 'ok') act = `<button class="btn sm" data-act="open" data-id="${it.id}">開く</button>`
        return `<tr>
          <td>${it.st === 'sw' && !it.locked ? `<input type="checkbox" data-chk="${it.id}" ${S.checked.has(it.id) ? 'checked' : ''} aria-label="${esc(it.title)} を選ぶ">` : ''}</td>
          <td class="nw">${md(it.date)} ${hm(it.date)}</td>
          <td class="strong">${esc(it.title)}${it.locked ? LOCK_SVG : ''}</td>
          <td>${fmtDur(it.dur)}</td>
          <td>${it.src === 'text' ? 'テキスト' : '音声'}</td>
          <td>${stChip(it)}${it.st === 'err' && it.err && !it.locked ? `<div class="muted sm">${esc(it.err)}</div>` : ''}</td>
          <td class="nw r">${act}</td></tr>`
      }).join('') : '<tr><td colspan="7" class="muted c">該当する議事録はありません。</td></tr>'}</tbody>
    </table></div>
  </div>`
}

/* ---------- 要約 ---------- */
async function saveFile(it, name, obj, patch) {
  const sealed = await sealJson(DEK.get(it.id), obj)
  const r = await gasS('put', { id: it.id, patch: patch || {}, files: { [name]: sealed } })
  await applyEntry(r.entry, { [name]: obj })
}

async function runSummary(id) {
  const it = S.byId.get(id)
  if (!it || it.locked || S.busy[id]) return
  S.busy[id] = '要約中…'
  render()
  try {
    const t = await file(it, 't')
    if (!t?.segments?.length) throw new Error('文字起こしがありません。')
    const s = await summarizeWithAI(t.segments, (n) => {
      S.busy[id] = `要約中…（${n}字）`
      $$(`[data-busy="${id}"]`).forEach((el) => { el.textContent = S.busy[id] })
    })
    delete S.busy[id]
    await saveFile(S.byId.get(id), 's', s, { st: 'ok' })
    toast(`「${it.title}」を要約しました。`)
  } catch (e) {
    delete S.busy[id]
    render()
    toast(`要約できませんでした：${e.message}`, true)
  }
}

async function sumSelected() {
  const ids = [...S.checked].filter((id) => S.byId.get(id)?.st === 'sw')
  S.checked.clear()
  for (const id of ids) await runSummary(id)
}

function openClaude() {
  const url = ls.get('m2.claudeUrl', '') || CLAUDE_DEFAULT_URL
  const n = S.items.filter((x) => x.st === 'sw' && !x.locked).length
  window.open(url, '_blank', 'noopener,noreferrer')
  toast(`Claude.ai を開きました（要約待ち ${n} 件）。「議事録の要約待ちを要約して」と頼むと Notion に書き込まれ、Mac が回収すると要約済みになります。`, false, 9000)
}

/* ---------- チャット ---------- */
async function sendChat(id, text) {
  const it = S.byId.get(id)
  const conn = connectionOf(loadSettings())
  const msgs = S.chat[id] ||= []
  msgs.push({ role: 'user', content: text })
  if (!conn) { msgs.push({ role: 'assistant', content: 'AI の接続先が未設定です。設定で URL とモデルを登録してください。' }); paintDetail(); return }
  const [s, t] = await Promise.all([file(it, 's'), file(it, 't')])
  const sys = `あなたは会議の議事録について答えるアシスタントです。次の要約と文字起こしだけを根拠に、日本語で簡潔に答えてください。根拠になった発言の時刻を [m:ss] で添えてください。分からないことは分からないと答えてください。\n\n# 会議\n${it.title}（${it.date}）\n\n# 要約\n${s ? JSON.stringify({ summary: s.summary, decisions: s.decisions, agenda: s.agenda, todos: s.todos }) : 'なし'}\n\n# 文字起こし\n${transcriptText(t?.segments).slice(0, 24000)}`
  const out = { role: 'assistant', content: '' }
  msgs.push(out)
  paintDetail()
  try {
    for await (const ch of streamChat(conn, [{ role: 'system', content: sys }, ...msgs.slice(0, -1)])) {
      if (ch.delta) {
        out.content += ch.delta
        const last = $('#msgs .msg-b.assistant:last-child')
        if (last && S.sel === id) last.textContent = out.content
      }
    }
  } catch (e) {
    out.content = out.content || `答えられませんでした：${e.message}`
  }
  if (S.sel === id) paintDetail()
}

/* ---------- メモ・ToDo ---------- */
const noteTimers = {}
async function toggleTodo(id, i, on) {
  const it = S.byId.get(id)
  const n = { ...(await file(it, 'n') || {}) }
  n.done = { ...(n.done || {}), [i]: on }
  const c = S.files[id]; if (c) c.n = n
  clearTimeout(noteTimers[id])
  noteTimers[id] = setTimeout(() => saveFile(S.byId.get(id), 'n', n).catch((e) => toast(`保存できませんでした：${e.message}`, true)), 800)
}

/* ---------- 登録（音声・文字起こし） ---------- */
const CHUNK = 3 * 1024 * 1024
const blobB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('ファイルを読めませんでした')); r.readAsDataURL(blob) })
const audioDuration = (f) => new Promise((res) => {
  const a = new Audio(); const u = URL.createObjectURL(f)
  const done = (v) => { URL.revokeObjectURL(u); res(v) }
  a.preload = 'metadata'; a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration) : 0); a.onerror = () => done(0)
  setTimeout(() => done(0), 8000); a.src = u
})

function groupsPicker(selected) {
  if (!S.admin) {
    return `<div class="chips"><span class="gchip mine">${esc(S.role)}</span><span class="gchip">管理者</span></div>
      <p class="muted sm">ログイン中のグループで登録されます（変更できません）。ほかのグループへの公開は管理者があとで設定します。</p>`
  }
  const roles = Object.keys(S.roles).filter((r) => r !== ADMIN_ROLE)
  return `<div class="chips">${roles.map((r) => `<label class="gpick"><input type="checkbox" name="grp" value="${esc(r)}" ${selected.includes(r) ? 'checked' : ''}>${esc(r)}</label>`).join('')}<span class="gchip">管理者（常に閲覧可）</span></div>
    <p class="muted sm">選んだグループと管理者が閲覧できます。選ばなければ管理者だけが閲覧できます。</p>`
}

function openUpload() {
  modal('議事録を登録', `
    <div class="kinds" role="group" aria-label="登録するもの">
      <button class="kind on" data-act="kind" data-v="audio" aria-pressed="true"><span class="strong">① 音声ファイル</span><span class="muted sm">Mac が文字起こしします</span></button>
      <button class="kind" data-act="kind" data-v="text" aria-pressed="false"><span class="strong">② 文字起こしデータ</span><span class="muted sm">要約テキストも一緒に登録できます（任意）</span></button>
    </div>
    <div class="frow">
      <div class="fcol grow2"><label for="upTitle">タイトル</label><input id="upTitle" placeholder="空のときはファイル名を使います"></div>
      <div class="fcol"><label for="upDate">開始日時</label><input id="upDate" type="datetime-local" value="${nowLocal()}"></div>
    </div>
    <div class="fcol"><label for="upTags">タグ（読点・カンマ区切り）</label><input id="upTags" placeholder="定例、営業"></div>
    <div class="k-audio">
      <span class="lbl">音声ファイル</span>
      <label class="drop" id="upDrop"><input id="upFile" type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.webm" class="sr">
        <span>ここにドロップ、または <span class="linkish">ファイルを選ぶ</span></span><span class="muted sm">m4a・mp3・wav など</span></label>
      <div id="upFileRow" class="filerow" hidden></div>
    </div>
    <div class="k-text" hidden>
      <span class="lbl">会議時間</span>
      <div class="hms"><label class="sr" for="upH">時間</label><input id="upH" inputmode="numeric" placeholder="1">時間<label class="sr" for="upM">分</label><input id="upM" inputmode="numeric" placeholder="0">分<label class="sr" for="upS">秒</label><input id="upS" inputmode="numeric" placeholder="0">秒</div>
      <div class="lblrow"><label for="upRaw">文字起こし（原文）</label><span class="req">必須</span><span class="grow"></span><span class="muted sm" id="upRawN">0 文字</span></div>
      <textarea id="upRaw" rows="6" placeholder="発言をそのまま貼り付け。行頭の [00:01:12] は時刻として読みます。テキストファイルをドロップしても読み込めます"></textarea>
      <div class="lblrow"><label for="upSum">要約テキスト</label><span class="opt">任意</span></div>
      <textarea id="upSum" rows="5" placeholder="議事メモ（タイプ1）・会議のメモ:（タイプ2）・会議メモ＋議題の見出し（タイプ3）の要約を貼り付け"></textarea>
      <p class="sm" id="upSumMsg"></p>
    </div>
    <div class="panel grp"><span class="strong">${LOCK_SVG} 閲覧できる人</span>${groupsPicker([])}</div>
    <div class="dlg-foot"><span class="grow sm" id="upState">登録後の状態：<b>文字起こし待ち</b> ・ Mac が次の確認で文字起こしします</span>
      <button class="btn" data-act="close">キャンセル</button><button class="btn main" data-act="up-go" id="upGo">アップロード</button></div>
    <div class="progress" id="upProg" hidden><span></span></div>
    <p class="msg" id="upMsg" role="alert"></p>`, { wide: true, sticky: true })
  U.kind = 'audio'; U.file = null; U.dur = 0
  const f = $('#upFile')
  f.addEventListener('change', () => setUpFile(f.files[0]))
  const drop = $('#upDrop')
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); setUpFile(e.dataTransfer.files[0]) })
  const raw = $('#upRaw')
  raw.addEventListener('input', () => { $('#upRawN').textContent = `${raw.value.length} 文字` })
  raw.addEventListener('dragover', (e) => e.preventDefault())
  raw.addEventListener('drop', async (e) => { e.preventDefault(); const fl = e.dataTransfer.files[0]; if (fl) { raw.value = await fl.text(); raw.dispatchEvent(new Event('input')) } })
  $('#upSum').addEventListener('input', paintUpState)
}
const U = { kind: 'audio', file: null, dur: 0 }

async function setUpFile(f) {
  if (!f) return
  U.file = f
  U.dur = await audioDuration(f)
  const row = $('#upFileRow')
  row.hidden = false
  row.innerHTML = `<span class="strong grow">${esc(f.name)}</span><span class="muted sm">${U.dur ? fmtT(U.dur) + ' ・ ' : ''}${(f.size / 1048576).toFixed(1)}MB</span><button class="ib" data-act="up-clear" aria-label="ファイルを外す">×</button>`
}

function paintUpState() {
  const el = $('#upState'); if (!el) return
  if (U.kind === 'audio') { el.innerHTML = '登録後の状態：<b>文字起こし待ち</b> ・ Mac が次の確認で文字起こしします'; return }
  const txt = $('#upSum').value.trim()
  const msg = $('#upSumMsg')
  if (!txt) { msg.textContent = ''; el.innerHTML = '登録後の状態：<b>要約待ち</b> ・ 要約テキストを入れると要約済みで登録します'; return }
  try {
    const r = parseSummaryText(txt)
    msg.className = 'sm okmsg'
    msg.textContent = `${summaryTypeLabel(r.type)}として読み取りました：議題 ${r.agenda.length} 件・決定事項 ${r.decisions.length} 件・ToDo ${r.todos.length} 件・論点 ${r.topics.length} 件`
    el.innerHTML = '登録後の状態：<b class="okc">要約済み</b>'
  } catch (e) {
    msg.className = 'sm errmsg'; msg.textContent = e.message
    el.innerHTML = '登録後の状態：<b>要約テキストを読み取れません</b>'
  }
}

async function submitUpload() {
  const msg = $('#upMsg'); msg.textContent = ''
  const go = $('#upGo')
  const title0 = $('#upTitle').value.trim()
  const date = $('#upDate').value
  const tags = $('#upTags').value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
  if (!date) { msg.textContent = '開始日時を入れてください。'; return }
  const roles = S.admin ? $$('input[name="grp"]:checked').map((x) => x.value) : []
  const gids = [...new Set([S.adminGid, ...(S.admin ? roles.map((r) => S.roles[r]) : [S.gid])].filter(Boolean))]
  for (const g of gids) if (!S.pub[g]) { msg.textContent = 'グループの公開鍵が見つかりません（管理者に連絡してください）。'; return }
  const id = newId()
  const dek = newDek()
  const k = {}
  go.disabled = true
  try {
    for (const g of gids) k[g] = await wrapDek(dek, S.pub[g])
    if (U.kind === 'audio') {
      const f = U.file
      if (!f) throw new Error('音声ファイルを選んでください。')
      if (!f.size) throw new Error('空のファイルは登録できません。')
      const ext = ((f.name.match(/\.([a-z0-9]{1,5})$/i) || [])[1] || 'm4a').toLowerCase()
      const fname = `${id}.${ext}`
      const prog = $('#upProg'); prog.hidden = false
      msg.textContent = 'アップロードしています…'
      const { sessionUrl } = await gasS('initUpload', { filename: fname, mimeType: f.type || 'application/octet-stream', size: f.size })
      let off = 0, res = null
      while (off < f.size) {
        const blob = f.slice(off, off + CHUNK)
        res = await gasS('putChunk', { sessionUrl, chunk: await blobB64(blob), offset: off, total: f.size })
        off += blob.size
        prog.firstElementChild.style.width = `${Math.round(off / f.size * 100)}%`
      }
      if (!res?.done) throw new Error('アップロードが最後まで終わりませんでした。もう一度試してください。')
      const meta = { title: title0 || f.name.replace(/\.[^.]+$/, ''), tags, file: { id: res.file.id, name: fname, orig: f.name } }
      msg.textContent = '登録しています…'
      const r = await gasS('put', { id, entry: { date, dur: U.dur, st: 'tw', src: 'audio', k, m: await sealJson(dek, meta) } })
      DEK.set(id, dek)
      closeModal()
      await applyEntry(r.entry)
      toast('アップロードしました。Mac が次の確認で文字起こしします。')
    } else {
      if (!title0) throw new Error('タイトルを入れてください。')
      const raw = $('#upRaw').value
      if (!raw.trim()) throw new Error('文字起こし（原文）を貼り付けてください。')
      const segments = segmentsFromText(raw)
      const hms = Number($('#upH').value || 0) * 3600 + Number($('#upM').value || 0) * 60 + Number($('#upS').value || 0)
      const lastT = [...segments].reverse().find((x) => x.t != null)?.t || 0
      const sumText = $('#upSum').value.trim()
      let s = null
      if (sumText) s = normalizeSummary(parseSummaryText(sumText), 'テキスト取り込み')
      const files = { t: await sealJson(dek, { segments }) }
      if (s) files.s = await sealJson(dek, s)
      msg.textContent = '登録しています…'
      const r = await gasS('put', { id, entry: { date, dur: hms || lastT, st: s ? 'ok' : 'sw', src: 'text', k, m: await sealJson(dek, { title: title0, tags }) }, files })
      DEK.set(id, dek)
      closeModal()
      await applyEntry(r.entry, { t: { segments }, s, n: null })
      toast(s ? '要約済みで登録しました。' : '要約待ちで登録しました。変換管理から要約できます。')
    }
  } catch (e) {
    msg.textContent = e.message
    go.disabled = false
  }
}

/* ---------- 編集・閲覧グループ・削除（管理者／登録した人） ---------- */
function openEdit(id) {
  const it = S.byId.get(id)
  modal('タイトル・タグ', `
    <div class="fcol"><label for="edTitle">タイトル</label><input id="edTitle" value="${esc(it.title)}"></div>
    <div class="fcol"><label for="edTags">タグ（読点・カンマ区切り）</label><input id="edTags" value="${esc((it.tags || []).join('、'))}"></div>
    <div class="fcol"><label for="edDate">開始日時</label><input id="edDate" type="datetime-local" value="${esc(it.date)}"></div>
    <div class="dlg-foot"><span class="grow"></span><button class="btn" data-act="close">キャンセル</button><button class="btn main" data-act="edit-save" data-id="${id}">保存</button></div>
    <p class="msg" id="edMsg" role="alert"></p>`)
}

async function saveEdit(id) {
  const it = S.byId.get(id)
  const title = $('#edTitle').value.trim()
  if (!title) { $('#edMsg').textContent = 'タイトルを入れてください。'; return }
  const meta = { ...(META.get(id)?.v || {}), title, tags: $('#edTags').value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) }
  try {
    const r = await gasS('put', { id, patch: { m: await sealJson(DEK.get(id), meta), date: $('#edDate').value || it.date } })
    closeModal()
    await applyEntry(r.entry)
    toast('保存しました。')
  } catch (e) { $('#edMsg').textContent = e.message }
}

function openGroups(id) {
  const it = S.byId.get(id)
  const byGid = Object.fromEntries(Object.entries(S.roles).map(([r, g]) => [g, r]))
  const cur = Object.keys(it.k || {}).map((g) => byGid[g]).filter(Boolean)
  modal('閲覧グループ', `<p class="muted sm">「${esc(it.title)}」を見られるグループを選びます。管理者は常に閲覧できます。</p>
    ${groupsPicker(cur)}
    <div class="dlg-foot"><span class="grow"></span><button class="btn" data-act="close">キャンセル</button><button class="btn main" data-act="groups-save" data-id="${id}">保存</button></div>
    <p class="msg" id="grMsg" role="alert"></p>`)
}

async function saveGroups(id) {
  const it = S.byId.get(id)
  const roles = $$('input[name="grp"]:checked').map((x) => x.value)
  const want = [...new Set([S.adminGid, ...roles.map((r) => S.roles[r])].filter(Boolean))]
  const k = {}
  try {
    for (const g of want) {
      if (it.k[g]) k[g] = it.k[g]
      else { if (!S.pub[g]) throw new Error('公開鍵が見つからないグループがあります。'); k[g] = await wrapDek(DEK.get(id), S.pub[g]) }
    }
    const r = await gasS('put', { id, patch: { k } })
    closeModal()
    await applyEntry(r.entry)
    toast('閲覧グループを変えました。外したグループの端末に、変更前に読み込んだ内容が残っている場合があります。', false, 7000)
  } catch (e) { $('#grMsg').textContent = e.message }
}

async function del(id) {
  const it = S.byId.get(id)
  if (!confirm(`「${it.title}」を削除します。元に戻せません。よろしいですか？`)) return
  try {
    await gasS('put', { id, del: true })
    if (S.sel === id) S.sel = null
    await applyEntry(null, { id }, true)
    toast('削除しました。')
  } catch (e) { toast(e.message, true) }
}

async function retry(id) {
  try {
    const r = await gasS('put', { id, patch: { st: 'tw' } })
    await applyEntry(r.entry)
    toast('文字起こし待ちに戻しました。')
  } catch (e) { toast(e.message, true) }
}

/* ---------- 設定 ---------- */
function openSettings() {
  const s = loadSettings()
  const c = activeConnection(s) || newConnection()
  const bio = bioOk()
  modal('設定', `
    <section class="sset"><h3>AI の接続先（この端末だけ）</h3>
      <div class="fcol"><label for="stConn">接続</label><select id="stConn">${s.connections.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? 'selected' : ''}>${esc(x.label || '名前なし')}</option>`).join('')}</select></div>
      <div class="frow"><div class="fcol grow2"><label for="stLabel">名前</label><input id="stLabel" value="${esc(c.label)}"></div><div class="fcol"><label for="stCtx">num_ctx</label><input id="stCtx" inputmode="numeric" value="${esc(c.numCtx)}"></div></div>
      <div class="fcol"><label for="stUrl">URL（OpenAI 互換。例：https://xxxx.ngrok-free.app/v1）</label><input id="stUrl" value="${esc(c.baseUrl)}" autocapitalize="off" spellcheck="false"></div>
      <div class="fcol"><label for="stKey">API キー</label><input id="stKey" type="password" value="${esc(c.apiKey)}" autocomplete="off"></div>
      <div class="fcol"><label for="stModels">モデル（カンマ区切り。先頭を使います）</label><input id="stModels" value="${esc((c.models || []).join(', '))}" autocapitalize="off" spellcheck="false"></div>
      <div class="acts"><button class="btn main" data-act="ai-save">保存</button><button class="btn" data-act="ai-add">接続を追加</button>${s.connections.length > 1 ? '<button class="btn danger" data-act="ai-del">この接続を消す</button>' : ''}</div>
      <p class="muted sm">ほかの自作アプリ（gemma-chat・今の議事録）と同じ設定を使います。</p>
    </section>
    <section class="sset"><h3>Claude.ai で要約するページ</h3>
      <div class="fcol"><label for="stClaude">リンク（claude.ai のプロジェクトかチャット）</label><input id="stClaude" value="${esc(ls.get('m2.claudeUrl', ''))}" placeholder="${CLAUDE_DEFAULT_URL}" autocapitalize="off" spellcheck="false"></div>
      <div class="acts"><button class="btn" data-act="claude-save">保存</button></div>
    </section>
    <section class="sset"><h3>Face ID・Touch ID</h3>
      ${!bio ? '<p class="muted sm">このブラウザでは使えません（https で開いた、対応する端末が必要です）。</p>'
        : bioRegistered() ? '<p class="sm">登録済みです。権限コードでも開けます。</p><div class="acts"><button class="btn" data-act="bio-off">解除</button></div>'
          : '<p class="sm">権限コードを、この端末の生体認証で包んで置きます。</p><div class="acts"><button class="btn" data-act="bioReg">登録する</button></div>'}
      <p class="msg" id="bioMsg"></p>
    </section>
    <section class="sset"><h3>ログイン</h3>
      <p class="sm">グループ：${esc(S.admin ? '管理者' : S.role)}</p>
      <div class="acts"><button class="btn" data-act="lock">鍵をかける</button><button class="btn danger" data-act="reset">この端末の設定を消す</button></div>
    </section>
    <p class="msg" id="stMsg" role="status"></p>`, { wide: true })
  $('#stConn').addEventListener('change', (e) => {
    const s2 = loadSettings(); s2.activeConnectionId = e.target.value
    const c2 = activeConnection(s2); s2.activeModel = c2?.models?.[0] ?? null
    saveSettings(s2); openSettings()
  })
}

function saveAI() {
  const s = loadSettings()
  const c = activeConnection(s)
  const url = $('#stUrl').value.trim().replace(/\/+$/, '')
  if (url && !/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url + '/')) { $('#stMsg').textContent = 'URL は https で始まるものにしてください（localhost は http も可）。'; return }
  Object.assign(c, {
    label: $('#stLabel').value.trim() || '接続', baseUrl: url, apiKey: $('#stKey').value.trim(),
    numCtx: Number($('#stCtx').value) || 32768, models: $('#stModels').value.split(',').map((x) => x.trim()).filter(Boolean),
  })
  if (!c.models.includes(s.activeModel)) s.activeModel = c.models[0] ?? null
  saveSettings(s)
  $('#stMsg').textContent = '保存しました。'
  if (S.tab === 'convert') renderMain()
}

/* ---------- モーダル・トースト ---------- */
function modal(title, body, opt = {}) {
  $('#modal').innerHTML = `<div class="ov"><div class="dlg ${opt.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dlgT">
    <div class="dlg-h"><h2 id="dlgT">${esc(title)}</h2><button class="ib x" data-act="close" aria-label="閉じる">×</button></div>
    <div class="dlg-b">${body}</div></div></div>`
  const first = $('#modal input, #modal textarea, #modal select, #modal button:not(.x)')
  first?.focus()
}
function closeModal() { $('#modal').innerHTML = '' }

let toastTimer = 0
function toast(text, bad = false, ms = 4000) {
  const t = $('#toast')
  t.textContent = text
  t.className = bad ? 'show bad' : 'show'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.className = '' }, ms)
}

/* ---------- 操作 ---------- */
const ACT = {
  bio: async () => {
    try { const code = await bioUnlock(); await doLogin(code, false) } catch (e) { showGate(e?.name === 'NotAllowedError' ? '取り消されました。権限コードでも開けます。' : e.message) }
  },
  bioReg: async () => {
    const m = $('#bioMsg')
    try { await bioRegister(S.code); if (m) m.textContent = ''; closeModal(); toast('登録しました。次から Face ID・Touch ID で開けます。') } catch (e) { if (m) m.textContent = e?.name === 'NotAllowedError' ? '取り消されました。' : e.message }
  },
  'bio-off': () => { bioForget(); openSettings() },
  reset: () => {
    if (!confirm('この端末の設定（Face ID の登録・お気に入り・表示の設定）を消します。AI の接続先は残ります。よろしいですか？')) return
    for (const k of ['m2.bio', 'm2.fav', 'm2.seen', 'm2.view', 'm2.bioAsked', 'm2.claudeUrl']) ls.del(k)
    S.fav = new Set(); S.seen = {}
    lock()
  },
  lock,
  close: closeModal,
  tab: (a) => { S.tab = a.dataset.tab; window.scrollTo(0, 0); render() },
  upload: openUpload,
  settings: openSettings,
  month: (a) => {
    const [y, m] = S.month.split('-').map(Number)
    S.month = monthKey(new Date(y, m - 1 + Number(a.dataset.d), 1))
    renderMain()
  },
  filter: (a) => { S.filter = a.dataset.v; renderMain() },
  view: (a) => { S.view = a.dataset.v; ls.set('m2.view', S.view); if (S.view === 'cards') S.sel = null; renderMain() },
  jump: (a) => { $(`#d-${a.dataset.day}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
  open: (a) => {
    const it = S.byId.get(a.dataset.id)
    if (!it) return
    S.sel = it.id
    S.seek = null
    S.tab = 'list'
    if (a.dataset.go) S.dtab = a.dataset.go
    if (!it.locked && S.seen[it.id] !== it.upd) { S.seen[it.id] = it.upd; ls.set('m2.seen', S.seen) }
    if (it.date && !it.date.startsWith(S.month)) S.month = it.date.slice(0, 7)
    render()
    if (matchMedia('(max-width: 820px)').matches) window.scrollTo(0, 0)
  },
  'close-detail': () => { S.sel = null; renderMain() },
  dtab: (a) => { S.dtab = a.dataset.v; S.seek = null; paintDetail() },
  fav: (a) => {
    const id = a.dataset.id
    if (S.fav.has(id)) S.fav.delete(id); else S.fav.add(id)
    ls.set('m2.fav', [...S.fav]); renderMain()
  },
  summarize: (a) => runSummary(a.dataset.id),
  claude: openClaude,
  seek: (a) => {
    S.seek = { t: parseT(a.dataset.t), scrolled: false }
    S.dtab = 'tr'
    paintDetail()
  },
  'copy-tr': async (a) => {
    const t = cached(S.byId.get(a.dataset.id), 't')
    try { await navigator.clipboard.writeText(transcriptText(t?.segments)); toast('文字起こしをコピーしました。') } catch { toast('コピーできませんでした。', true) }
  },
  'memo-save': async (a) => {
    const id = a.dataset.id
    const it = S.byId.get(id)
    const n = { ...(await file(it, 'n') || {}), memo: $('#memoIn').value }
    $('#memoMsg').textContent = '保存しています…'
    try { await saveFile(it, 'n', n); toast('メモを保存しました。') } catch (e) { $('#memoMsg').textContent = e.message }
  },
  edit: (a) => openEdit(a.dataset.id),
  'edit-save': (a) => saveEdit(a.dataset.id),
  groups: (a) => openGroups(a.dataset.id),
  'groups-save': (a) => saveGroups(a.dataset.id),
  delete: (a) => del(a.dataset.id),
  retry: (a) => retry(a.dataset.id),
  cfilter: (a) => { S.cfilter = a.dataset.v; renderMain() },
  'check-sw': () => { S.items.filter((x) => x.st === 'sw' && !x.locked).forEach((x) => S.checked.add(x.id)); renderMain() },
  'sum-selected': sumSelected,
  kind: (a) => {
    U.kind = a.dataset.v
    $$('.kind').forEach((b) => { const on = b.dataset.v === U.kind; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on) })
    $('.k-audio').hidden = U.kind !== 'audio'
    $('.k-text').hidden = U.kind !== 'text'
    $('#upTitle').placeholder = U.kind === 'audio' ? '空のときはファイル名を使います' : '会議名'
    $('#upGo').textContent = U.kind === 'audio' ? 'アップロード' : '登録'
    paintUpState()
  },
  'up-clear': () => { U.file = null; $('#upFile').value = ''; $('#upFileRow').hidden = true },
  'up-go': submitUpload,
  'ai-save': saveAI,
  'ai-add': () => {
    const s = loadSettings(); const c = newConnection({ label: '新しい接続' })
    s.connections.push(c); s.activeConnectionId = c.id; s.activeModel = null; saveSettings(s); openSettings()
  },
  'ai-del': () => {
    const s = loadSettings()
    s.connections = s.connections.filter((x) => x.id !== s.activeConnectionId)
    s.activeConnectionId = s.connections[0]?.id ?? null; s.activeModel = s.connections[0]?.models?.[0] ?? null
    saveSettings(s); openSettings()
  },
  'claude-save': () => {
    const u = $('#stClaude').value.trim()
    if (u) { try { const o = new URL(u); if (o.protocol !== 'https:' || !(o.hostname === 'claude.ai' || o.hostname.endsWith('.claude.ai'))) throw 0 } catch { $('#stMsg').textContent = 'claude.ai の https のリンクだけ使えます。'; return } }
    if (u) ls.set('m2.claudeUrl', u); else ls.del('m2.claudeUrl')
    $('#stMsg').textContent = '保存しました。'
  },
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]')
  if (!a || a.disabled) return
  const f = ACT[a.dataset.act]
  if (f) { e.preventDefault(); f(a, e) }
})

document.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    S.q = e.target.value
    clearTimeout(ACT._qt)
    ACT._qt = setTimeout(() => { if (S.tab === 'list') { renderMain(); const q = $('#q'); q?.focus() } }, 250)
  }
  if (e.target.id === 'trq') {
    S.trq = e.target.value
    clearTimeout(ACT._tt)
    ACT._tt = setTimeout(() => {
      paintDetail()
      const el = $('#trq'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) }
      $('.seg-row.hit')?.scrollIntoView({ block: 'center' })
    }, 300)
  }
})

document.addEventListener('change', (e) => {
  const t = e.target
  if (t.dataset.chk) { if (t.checked) S.checked.add(t.dataset.chk); else S.checked.delete(t.dataset.chk); renderMain() }
  if (t.dataset.todo) { toggleTodo(t.dataset.todo, Number(t.dataset.i), t.checked); t.closest('li')?.classList.toggle('done', t.checked) }
  if (t.id === 'aiSel' && t.value.includes('|')) {
    const [cid, model] = t.value.split('|')
    const s = loadSettings(); s.activeConnectionId = cid; s.activeModel = model; saveSettings(s)
  }
})

document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-chat]')
  if (!f) return
  e.preventDefault()
  const text = $('#askIn').value.trim()
  if (text) sendChat(f.dataset.chat, text)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal').innerHTML && !$('#upGo')) closeModal()
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'askIn') e.target.closest('form')?.requestSubmit()
})

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.R) refresh() })

showGate()
