// src/lib/summary-text.js — 既にある要約テキストを、議事録の要約構造に変換する
//
// 対応する形式:
//   タイプ1: 「## 会議情報 / ## 議事メモ / ## 次の段取り / ## AIからの提案」の Markdown 形式
//   タイプ2: 「会議のメモ:」で始まり、議題ごとに概要とインデント付きの要点が並ぶ形式
//            (末尾に「フォローアップ タスク:」)
//   タイプ3: 見出しで議題を分ける Markdown 形式。見出しの深さ(## / ###)は問わない。
//            「会議メモ(議事メモ)」の見出しより1段深い見出しが議題、その下の「- 」が要点
//            (字下げした子の箇条書きも可)。議題内の「**結論**」以降の箇条書きは結論。
//            例: ### 会議情報 / ### 会議メモ / #### 議題 / ### 次の段取り / ### AIによる提案
//                ## 会議情報 / ## 会議メモ / ### 議題 / ## 次の対応 / ## 未決事項・確認事項
//
// 戻り値は summarize.js の generateSummary と同じ形(model を除く):
//   { cardSummary, agenda: [{topic, points, outcome}], decisions, todos: [{text, done}], topics }
// meetingAt は日時が読み取れたときだけ 'YYYY-MM-DDTHH:mm'(datetime-local 用)で付く。

const CARD_MAX = 100

const TYPE_LABELS = { type1: 'タイプ1', type2: 'タイプ2', type3: 'タイプ3' }

/** 画面に出す形式名(「タイプ1」など) */
export function summaryTypeLabel(type) {
  return TYPE_LABELS[type] || type
}

/** 'type1' | 'type2' | 'type3' | null */
export function detectSummaryType(text) {
  const t = String(text || '')
  // タイプ1 は議事メモの中が「- トピック: 」の箇条書き。それ以外の見出し形式はタイプ3
  const hasMdHeading = /^#{2,6}\s*(会議情報|会議メモ|議事メモ)/m.test(t)
  if (hasMdHeading && /^\s*[-*・]\s*トピック\s*[:：]/m.test(t)) return 'type1'
  if (hasMdHeading) return 'type3'
  if (/^\s*会議の?メモ\s*[:：]/m.test(t) || /^\s*フォローアップ\s*タスク\s*[:：]/m.test(t)) return 'type2'
  return null
}

export function parseSummaryText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n')
  const type = detectSummaryType(src)
  if (!type) throw new Error('形式を判別できません。タイプ1(## 議事メモ)・タイプ2(会議のメモ:)・タイプ3(## / ### 会議メモ + 議題の見出し)のいずれかの要約を貼り付けてください。')
  const parsed = type === 'type1' ? parseType1(src) : type === 'type2' ? parseType2(src) : parseType3(src)
  if (!parsed.agenda.length && !parsed.todos.length) {
    throw new Error('議題もToDoも読み取れませんでした。貼り付けた内容を確認してください。')
  }
  return { type, ...parsed }
}

/** 議題名を並べた一覧カード用の短い要約。長すぎる場合は切る */
function cardSummaryOf(agenda) {
  const s = '議題: ' + agenda.map((a) => a.topic).join('／')
  return s.length > CARD_MAX ? s.slice(0, CARD_MAX - 1) + '…' : s
}

/** 「[挿入を追加]」のようなテンプレートの未記入欄 */
function isPlaceholder(s) {
  return /^\[[^\]]*(挿入|追加)[^\]]*\]$/.test(s.trim())
}

// ------------------------------------------------------------ タイプ1

function parseType1(src) {
  const sections = {}
  let cur = null
  src.split('\n').forEach((line) => {
    const m = line.match(/^##\s*(.+?)\s*$/)
    if (m) { cur = m[1]; sections[cur] = []; return }
    if (cur) sections[cur].push(line)
  })
  const sec = (name) => sections[Object.keys(sections).find((k) => k.includes(name))] || []

  // 会議情報: 「> 日付: 2026-10-09 12:52:12」
  let meetingAt = ''
  sec('会議情報').forEach((l) => {
    const m = l.match(/日付\s*[:：]\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
    if (m) {
      const p = (n) => String(n).padStart(2, '0')
      meetingAt = `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4] || 0)}:${m[5] || '00'}`
    }
  })

  // 議事メモ: 「- トピック: X」の下に、字下げした要点が並ぶ
  const agenda = []
  const decisions = []
  let item = null
  sec('議事メモ').forEach((line) => {
    if (!line.trim()) return
    const indented = /^\s+/.test(line)
    const body = line.replace(/^\s*[-*・]\s*/, '').trim()
    const t = body.match(/^トピック\s*[:：]\s*(.+)$/)
    if (!indented && t) {
      item = { topic: t[1].trim(), points: [], outcome: '' }
      agenda.push(item)
      return
    }
    if (!item || !body) return
    const c = body.match(/^結論\s*[:：]\s*(.+)$/)
    if (c) {
      item.outcome = c[1].trim()
      decisions.push(`${item.topic}: ${item.outcome}`)
    } else {
      item.points.push(body)
    }
  })
  agenda.forEach((a) => { if (!a.outcome) a.outcome = '継続検討' })

  // 次の段取り: 「- [ ] 内容」「- [x] 内容」
  const todos = []
  sec('次の段取り').forEach((line) => {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/)
    if (!m) return
    const text = m[2].trim()
    if (!text || isPlaceholder(text)) return
    todos.push({ text, done: m[1].toLowerCase() === 'x' })
  })

  // AIからの提案: 「> 1. 内容」の番号付きの行を未解決の論点にする
  const topics = []
  sec('AIからの提案').forEach((line) => {
    const m = line.match(/^>?\s*\d+[.．)）]\s*(.+)$/)
    if (m) topics.push(m[1].trim())
  })

  return { cardSummary: cardSummaryOf(agenda), agenda, decisions, todos, topics, meetingAt }
}

// ------------------------------------------------------------ タイプ2

const FOLLOWUP_RE = /^\s*フォローアップ\s*タスク\s*[:：]?\s*$/
const isIndented = (line) => /^(\t|\s{2,})\S/.test(line) || /^[\t　]+\S/.test(line)
const isHeader = (line) => /[:：]\s*$/.test(line.trim()) && !isIndented(line)

function parseType2(src) {
  const lines = src.split('\n')
  const cut = lines.findIndex((l) => FOLLOWUP_RE.test(l))
  const main = cut === -1 ? lines : lines.slice(0, cut)
  const follow = cut === -1 ? [] : lines.slice(cut + 1)

  // 議題: 「議題名:」の次の字下げなしの行が概要、字下げした「見出し: 本文」が要点
  const agenda = []
  let item = null
  main.forEach((raw) => {
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()
    if (!t) return
    if (/^AI\s*によって生成/.test(t) || /^会議の?メモ\s*[:：]?$/.test(t)) return
    if (isIndented(line)) {
      if (item) item.points.push(t)
    } else if (isHeader(line)) {
      item = { topic: t.replace(/[:：]\s*$/, '').trim(), points: [], outcome: '' }
      agenda.push(item)
    } else if (item) {
      item.outcome = item.outcome ? `${item.outcome} ${t}` : t // 概要(複数行なら連結)
    }
  })

  // フォローアップ: 「題名:」の次の行が「内容 (担当者)」
  const todos = []
  let title = ''
  follow.forEach((raw) => {
    const t = raw.trim()
    if (!t) return
    if (isHeader(raw)) {
      title = t.replace(/[:：]\s*$/, '').trim()
    } else {
      todos.push({ text: title ? `${title}: ${t}` : t, done: false })
      title = ''
    }
  })

  return { cardSummary: cardSummaryOf(agenda), agenda, decisions: [], todos, topics: [], meetingAt: '' }
}

// ------------------------------------------------------------ タイプ3

/** 箇条書きの親が「担当体制」のような短い見出し語か(句点で終わる文ではない) */
const isLabelLike = (s) => s.length <= 20 && !/[。．.]$/.test(s) && !/[:：]/.test(s)

const MEMO_RE = /会議メモ|議事メモ/
const INFO_RE = /会議情報/
const TODO_RE = /次の段取り|次の対応|次のアクション|アクション|ToDo|TODO|宿題|フォローアップ/
const TOPIC_RE = /AIによる提案|AIからの提案|未決|確認事項|論点|課題/
const stripMd = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim()

function parseType3(src) {
  // 見出しを (深さ, 名前, 行) に分ける
  const blocks = [] // { level, title, lines }
  let cur = { level: 0, title: '', lines: [] }
  blocks.push(cur)
  src.split('\n').forEach((line) => {
    const m = line.match(/^(#{1,6})\s*(.+?)\s*#*\s*$/)
    if (m) { cur = { level: m[1].length, title: stripMd(m[2]), lines: [] }; blocks.push(cur); return }
    cur.lines.push(line)
  })

  // 「会議メモ」見出しの深さ。議題はそれより深い見出し、同じ深さ以下が来たら会議メモは終わり
  const memoIdx = blocks.findIndex((b) => b.level && MEMO_RE.test(b.title))
  const memoLevel = memoIdx === -1 ? 0 : blocks[memoIdx].level
  const top = [] // 会議メモ以外の、会議メモと同じ深さ以下の節(配下の小見出しの行もまとめる)
  const agendaBlocks = []
  let inMemo = false
  let topCur = null
  blocks.forEach((b, i) => {
    if (i === memoIdx) { inMemo = true; topCur = null; return }
    if (inMemo && b.level > memoLevel) { agendaBlocks.push(b); return }
    if (b.level && b.level <= (memoLevel || 6)) { inMemo = false; topCur = { title: b.title, lines: [...b.lines] }; top.push(topCur); return }
    if (topCur) topCur.lines.push(...b.lines)
  })
  const sec = (re) => top.filter((t) => re.test(t.title)).flatMap((t) => t.lines)

  // 会議情報: 「> 日付: 2026-06-25 16:01:48 / …」「> 日時：2026-11-18 10:08:06」(先頭の日時を使う)
  let meetingAt = ''
  sec(INFO_RE).forEach((l) => {
    if (meetingAt) return
    const m = l.match(/日[付時]\s*[:：]\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/)
    if (m) {
      const p = (n) => String(n).padStart(2, '0')
      meetingAt = `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4] || 0)}:${m[5] || '00'}`
    }
  })

  // 議題: 見出しの下の「- 要点」。字下げした子の箇条書きは、親が「担当体制」のような
  // 見出し語なら「【担当体制】子」、文なら親の次に「└ 子」として並べる。
  // 「**結論**」(または「結論:」)より後ろの箇条書きは結論として扱う
  const agenda = []
  const decisions = []
  const indentOf = (line) => line.match(/^[ \t　]*/)[0].replace(/\t/g, '    ').length
  agendaBlocks.forEach((b) => {
    const item = { topic: b.title, points: [], outcome: '' }
    const outcomes = []
    let inOutcome = false
    let parent = null
    const flushParent = () => {
      if (parent && !parent.emitted) { item.points.push(parent.text); parent.emitted = true }
    }
    b.lines.forEach((line) => {
      const t = line.trim()
      if (!t || /^-{3,}$/.test(t)) return
      const body = stripMd(t.replace(/^>?\s*(?:[-*・]|\d+[.．)）])\s+/, ''))
      if (!body) return
      const c = body.match(/^(?:結論|決定事項|決定)\s*[:：]?\s*(.*)$/)
      if (c) {
        flushParent(); parent = null
        inOutcome = true
        if (c[1].trim()) outcomes.push(c[1].trim())
        return
      }
      if (inOutcome) { outcomes.push(body); return }
      const indent = indentOf(line)
      if (parent && indent > parent.indent) {
        if (parent.label) {
          item.points.push(`【${parent.text}】${body}`)
          parent.emitted = true
        } else {
          flushParent()
          item.points.push(`└ ${body}`)
        }
        return
      }
      flushParent()
      parent = { text: body, indent, label: isLabelLike(body), emitted: false }
      if (!parent.label) { item.points.push(body); parent.emitted = true }
    })
    flushParent()
    if (outcomes.length) {
      item.outcome = outcomes.join(' ')
      outcomes.forEach((o) => decisions.push(`${item.topic}: ${o}`))
    }
    if (item.points.length || item.outcome) agenda.push(item)
  })

  // 次の段取り／次の対応: 「- [ ] 内容」「- [x] 内容」(チェック欄がなければ箇条書きをそのまま)
  const todos = []
  sec(TODO_RE).forEach((line) => {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/)
    const b = !m && line.match(/^\s*(?:[-*・]|\d+[.．)）])\s+(.+)$/)
    const text = stripMd(m ? m[2] : b ? b[1] : '')
    if (!text || isPlaceholder(text)) return
    todos.push({ text, done: m ? m[1].toLowerCase() === 'x' : false })
  })

  // AIによる提案／未決事項・確認事項: 箇条書きを未解決の論点にする
  const topics = []
  sec(TOPIC_RE).forEach((line) => {
    const m = line.match(/^>?\s*(?:[-*・]|\d+[.．)）])\s*(.+)$/)
    if (m && stripMd(m[1])) topics.push(stripMd(m[1]))
  })

  return { cardSummary: cardSummaryOf(agenda), agenda, decisions, todos, topics, meetingAt }
}
