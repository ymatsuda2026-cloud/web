// src/summary.js — 要約の形（URL指定AI・Claude.ai・貼り付けた要約テキストで共通）
//
// {
//   cardSummary: "一覧用 100字程度",
//   summary: "サマリ（会議の目的と結論を3〜5文）",
//   agenda: [{ topic, t, outcome, points: [{ text, t }] }],   // 論点別
//   decisions: [{ text, t }],
//   todos: [{ text, owner, due }],
//   topics: ["未解決の論点"],
//   model: "要約したAI", at: 要約した時刻(ms)
// }
// t は文字起こしの時刻（"m:ss" か "h:mm:ss"）。分からなければ ""。
import { streamChat } from './llm-client.js'
import { loadSettings, connectionOf } from './llm-settings.js'

export const SUMMARY_PROMPT = `あなたは会議の文字起こしを要約するアシスタントです。
文字起こしの各行の先頭にある [m:ss] は、その発言の時刻です。
必ず次のJSON形式だけで回答してください。前後に説明文やコードフェンスを付けないこと。

{
  "cardSummary": "一覧に表示する100字程度の要約",
  "summary": "会議の目的と結論を3〜5文で",
  "agenda": [
    {
      "topic": "議題（論点）の見出し",
      "t": "その議題が始まった時刻 m:ss",
      "outcome": "その議題の結論。結論が出ていなければ「継続検討」など",
      "points": [{ "text": "話された経緯・論拠を1件1文で", "t": "その発言の時刻 m:ss" }]
    }
  ],
  "decisions": [{ "text": "決定事項", "t": "決まった時刻 m:ss" }],
  "todos": [{ "text": "やること", "owner": "担当（分からなければ空）", "due": "期限（分からなければ空）" }],
  "topics": ["未解決の論点や気になる点"]
}

agenda は必ず1つ以上、議題ごとに分けて出してください。
t は文字起こしにある時刻をそのまま使い、分からなければ "" にしてください。
decisions / todos / topics は該当が無ければ空配列で構いません。日本語で出力してください。`

export function fmtT(sec) {
  if (sec == null || !isFinite(sec)) return ''
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

export function parseT(t) {
  const m = String(t || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3])
}

/** 文字起こし（segments）→ AI に渡すテキスト */
export function transcriptText(segments) {
  return (segments || []).map((x) => (x.t != null ? `[${fmtT(x.t)}] ` : '') + x.s).join('\n')
}

/** 貼り付けた原文 → segments。行頭の [00:01:12] / 00:01:12 / 1:12 を時刻として読む */
export function segmentsFromText(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^\[?((?:\d+:)?\d{1,2}:\d{2})\]?\s*(.*)$/)
    if (m && m[2]) return { t: parseT(m[1]), s: m[2] }
    return { t: null, s: line }
  })
}

const str = (v) => (v == null ? '' : String(v)).trim()
const item = (v) => (typeof v === 'string' ? { text: str(v), t: '' } : { text: str(v?.text), t: str(v?.t) })

/** AI の出力や summary-text.js の結果を、表示用の形にそろえる */
export function normalizeSummary(raw, model) {
  const r = raw || {}
  const agenda = (Array.isArray(r.agenda) ? r.agenda : []).map((a) => ({
    topic: str(a?.topic) || '（議題）',
    t: str(a?.t),
    outcome: str(a?.outcome),
    points: (Array.isArray(a?.points) ? a.points : []).map(item).filter((p) => p.text),
  }))
  return {
    cardSummary: str(r.cardSummary),
    summary: str(r.summary) || str(r.cardSummary),
    agenda,
    decisions: (Array.isArray(r.decisions) ? r.decisions : []).map(item).filter((d) => d.text),
    todos: (Array.isArray(r.todos) ? r.todos : []).map((t) => (typeof t === 'string'
      ? { text: str(t), owner: '', due: '' }
      : { text: str(t?.text), owner: str(t?.owner), due: str(t?.due) })).filter((t) => t.text),
    topics: (Array.isArray(r.topics) ? r.topics : []).map(str).filter(Boolean),
    model: str(model || r.model) || '—',
    at: Number(r.at) || Date.now(),
  }
}

export function extractJson(text) {
  const t = String(text || '').trim()
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b < 0) throw new Error('AI の応答から要約を読み取れませんでした。')
  return JSON.parse(t.slice(a, b + 1))
}

/** URL で指定した AI で要約する */
export async function summarizeWithAI(segments, onProgress, signal) {
  const conn = connectionOf(loadSettings())
  if (!conn) throw new Error('AI の接続先が未設定です。設定で URL とモデルを登録してください。')
  const messages = [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: transcriptText(segments).slice(0, 30000) },
  ]
  let full = ''
  for await (const chunk of streamChat(conn, messages, signal)) {
    if (chunk.delta) { full += chunk.delta; onProgress?.(full.length) }
  }
  const s = normalizeSummary(extractJson(full), conn.model)
  if (!s.agenda.length && !s.summary) throw new Error('要約が空でした。別のモデルで試してください。')
  return s
}
