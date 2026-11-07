import { streamChat } from './llm-client.js'
import { loadSettings, connectionOf } from './llm-settings.js'
import { promptOf, ensurePrompts } from './prompts.js'
import { serializeSections } from './sections.js'
import { reconcileTags } from './tags.js'
import { splitTranscript, resolveQuote, withTimecode, hasTimecodes, parseClock, formatTimecode } from './timecode.js'

/**
 * 生成はタブと同じ単位で段に分けている。1回のJSONに全部詰めると、
 *  - 小さいモデルでは後半が切れて丸ごと欠落する
 *  - 途中で失敗したとき全部やり直しになる
 *  - 「分野別だけ作り直す」ができない
 * ため。段ごとに保存できるので、途中で止まっても手前の結果は残る。
 */
export const STAGES = [
  { id: 'summary', label: 'サマリ・タグ' },
  { id: 'mindmap', label: 'マインドマップ' },
  { id: 'fields', label: '分野別要約' },
  { id: 'apply', label: '応用' },
  { id: 'ideas', label: '活用アイデア' },
]

/**
 * music スペースの段。原文はYouTubeの概要欄なので、文字起こし前提の
 * マインドマップ・応用・活用は作らない。保存先のカラムは使い回す
 * (チャプター=サマリカラム / 概要=分野別カラム)。
 */
export const MUSIC_STAGES = [
  { id: 'summary', label: 'チャプター' },
  { id: 'fields', label: '概要' },
]

export function stagesOf(mode) {
  return mode === 'music' ? MUSIC_STAGES : STAGES
}

/** 原文を見ない段。サマリ+分野別だけで足りるので軽い */
const SUMMARY_ONLY_STAGES = ['apply', 'ideas']

export function needsTranscript(stageId, mode) {
  if (mode === 'music') return true
  return !SUMMARY_ONLY_STAGES.includes(stageId)
}

// 文字起こしをそのまま渡す上限。Gemma(32K)想定で余白を見た値
const TRANSCRIPT_LIMIT = 30000

function jsonOf(text) {
  const trimmed = String(text ?? '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('LLM応答からJSONを抽出できませんでした')
  return JSON.parse(trimmed.slice(start, end + 1))
}

function requireConnection() {
  const connection = connectionOf(loadSettings())
  if (!connection) {
    throw new Error('AI接続が未設定です。設定から接続先とモデルを追加してください。')
  }
  return connection
}

/** HTTPステータスをメッセージ文字列から拾う。streamChatは "HTTP 429 ..." の形で投げてくる */
function httpStatusOf(err) {
  const m = String(err?.message ?? '').match(/HTTP (\d{3})/)
  return m ? Number(m[1]) : null
}

/**
 * 429には2種類ある。
 *  - 分あたりの上限(RPM): 少し待てば直る一時的なもの
 *  - 日あたりの上限(RPD): 待っても直らない。深夜(太平洋時間)まで復旧しない
 * メッセージ本文で見分けている。判別できない場合は一時的な方として扱い、
 * 待っても直らなければ最終的にリトライ上限で諦める。
 */
function isDailyQuota(err) {
  return /quota|exceeded your current quota/i.test(String(err?.message ?? '')) && !/per minute|rpm/i.test(String(err?.message ?? ''))
}

const RATE_LIMIT_RETRIES = 4
const RATE_LIMIT_BASE_MS = 15000

async function ask(connection, system, user, onProgress) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]

  for (let attempt = 0; ; attempt++) {
    try {
      let full = ''
      for await (const chunk of streamChat(connection, messages)) {
        if (chunk.delta) {
          full += chunk.delta
          onProgress?.(full)
        }
      }
      if (!full.trim()) throw new Error('AIから応答がありませんでした')
      return full
    } catch (err) {
      if (httpStatusOf(err) !== 429 || attempt >= RATE_LIMIT_RETRIES) throw err
      if (isDailyQuota(err)) {
        // 待っても直らない種類なので、リトライで時間を浪費せずすぐ諦める
        throw new Error('1日の利用上限に達しています。日付が変わるまで待つか、プランを見直してください。')
      }
      // 分あたりの上限。指数的に間を空けて再試行する
      const wait = RATE_LIMIT_BASE_MS * 2 ** attempt
      onProgress?.(`(利用制限のため ${Math.round(wait / 1000)} 秒待って再試行します: ${attempt + 1}/${RATE_LIMIT_RETRIES})`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

// ---- プロンプトの組み立て ----
//
// 文面そのものは setting.json(画面から編集可)にある。ここが持つのは、
// 原文の状態によって出し分けが要る差し込み欄だけ。

const NO_FENCE = '前後に説明文やコードフェンス(```)を付けず、JSONだけを出力してください。日本語で書いてください。'

/**
 * タグは既存の語彙に寄せさせる。生成は動画1本ずつ独立に走るため、
 * 何も縛らないと「AI」「生成AI」「LLM」「人工知能」のように語が際限なく増え、
 * 溜まるほど絞り込みが効かなくなる。
 * 語彙が1件も無い初回だけは、自由に付けさせて土台を作る。
 */
function tagRule(knownTags) {
  if (!knownTags.length) {
    return `- tags: 内容を表す短い語を3〜6件。長い説明ではなく分類語にすること。`
  }
  return `- tags: 3〜6件。まず下の「既存のタグ」から当てはまるものを選ぶこと。
  綴りは1文字も変えずにそのまま使う(「AI」を「Ai」や「生成AI」に書き換えない)。
  既存のどれにも当てはまらない観点が中心的な主題である場合にかぎり、新しいタグを1件だけ作ってよい。
  「近い意味だから」で新語を作らないこと。迷ったら既存のタグを選ぶ。

既存のタグ:
${knownTags.map((t) => `- ${t}`).join('\n')}`
}

/**
 * マインドマップは自由記述のMarkdown文字列ではなく構造化JSONで受け取る。
 * 理由は2つ: (1) 分野別と同じ「引用→時刻」を枝ごとに割り当てるには、
 * どの行がどの枝かをこちらで把握できる形でないと後処理できない。
 * (2) 自由記述だとインデントや見出し記号をモデルが崩し、markmapの
 * パースに失敗する事故が起きやすい。Markdown文字列はこちらで組み立てる。
 */
const MINDMAP_QUOTE_FIELD =
  ', "quote": "この項目の根拠になった原文の一文。原文から一字一句そのまま写す。無ければ空文字"'

const MINDMAP_QUOTE_RULE = `
- quote は原文に存在する文字列でなければならない。20〜60字程度で写す。自分で言い換えた文を書いてはいけない。
  該当が無い、または要約や見出しとして作った項目(原文の特定の一文に対応しない)には quote を空文字にする。
- 時刻や秒数は書かないこと。こちらで原文から割り出す。`

/**
 * 時刻は聞かない。要点の根拠になった原文の引用だけを出させて、
 * こちら側で文字列一致から時刻を割り当てる(resolveQuote)。
 * 「何分何秒か」を直接聞くとモデルは平然と作るので、その道は塞ぐ。
 */
const FIELDS_POINT_SHAPE_QUOTED =
  '{ "text": "押さえるべき具体的な事実・数値・手順を1行で", "quote": "その根拠になった原文の一文。原文から一字一句そのまま写す(要約・言い換え・省略をしない)" }'

const FIELDS_POINT_SHAPE_PLAIN = '"押さえるべき具体的な事実・数値・手順を1行で"'

const FIELDS_QUOTE_RULE = `
- quote は原文に存在する文字列でなければならない。20〜60字程度で写す。
  自分で言い換えた文を quote に書いてはいけない。該当が無ければ quote は空文字にする。
- 時刻や秒数は書かないこと。こちらで原文から割り出す。`

/** setting.json のテンプレートに {{...}} を差し込む。未知の欄は空文字で潰す */
function fillPrompt(stageId, vars) {
  const template = promptOf(stageId)
  if (!template.trim()) {
    throw new Error(`${stageId} のプロンプトが読み込めていません。setting.json を確認するか、設定から入力してください。`)
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

/**
 * 段ごとの指示は system ではなく本文の末尾に置く。
 *
 * ローカルLLMは「直前のプロンプトと先頭から一致している範囲」の読み込みを省ける。
 * 指示を system に入れるとプロンプトの1行目から段ごとに変わってしまい、
 * 同じ原文を3回とも読み直すことになる。原文を先・指示を後ろにすれば、
 * 2段目以降は原文ぶんの読み込みをまるごと飛ばせる。
 */
const SHARED_SYSTEM = '日本語で回答してください。'

function withInstructions(context, instructions) {
  return `${context}\n\n----------------\n\n${instructions}`
}

// ---- マインドマップの組み立て ----

/**
 * mindmapのJSONをmarkmap用のMarkdownに組み立てる。
 * quote が原文で見つかった枝にだけ末尾へ [mm:ss] を付ける
 * (renderMindmap側がそれをリンクに変換する)。
 * 見出し記号やインデントをこちらで機械的に出すので、モデルが崩す余地がない。
 */
function mindmapToText(parsed, segments) {
  const title = String(parsed?.title ?? '').trim() || '動画の主題'
  const lines = [`# ${title}`]

  function walk(nodes, depth) {
    for (const raw of Array.isArray(nodes) ? nodes : []) {
      const label = String(raw?.label ?? '').trim()
      if (!label) continue
      const quote = String(raw?.quote ?? '')
      const at = segments.length ? resolveQuote(quote, segments) : null
      const text = withTimecode(label, at)

      if (depth === 0) {
        lines.push(`## ${text}`)
      } else {
        lines.push(`${'  '.repeat(depth - 1)}- ${text}`)
      }
      if (Array.isArray(raw?.children) && raw.children.length) walk(raw.children, depth + 1)
    }
  }

  walk(parsed?.branches, 0)
  return lines.join('\n')
}

// ---- セクション形式への変換 ----

/**
 * 分野別をセクション形式に変換する。
 * points は文字列でも {text, quote} でも受ける(モデルが形を崩しても落ちないように)。
 * quote が原文に見つかった項目にだけ末尾へ [mm:ss] を足す。
 */
function fieldsToText(list, segments) {
  return serializeSections(
    (Array.isArray(list) ? list : []).map((f) => {
      const points = []
      let earliest = null

      ;(Array.isArray(f?.points) ? f.points : []).forEach((p) => {
        const text = String((typeof p === 'string' ? p : p?.text) ?? '').trim()
        if (!text) return
        const quote = typeof p === 'string' ? '' : String(p?.quote ?? '')
        const at = segments.length ? resolveQuote(quote, segments) : null
        if (at !== null && (earliest === null || at < earliest)) earliest = at
        points.push(withTimecode(text, at))
      })

      return {
        heading: withTimecode(String(f?.name ?? '').trim(), earliest),
        body: String(f?.summary ?? '').trim(),
        points,
      }
    })
  )
}

// 星は生成時には付けない(全件星0)。読んだあとに自分で付けるため
function applyToText(list) {
  return serializeSections(
    (Array.isArray(list) ? list : []).map((a) => ({
      heading: String(a?.title ?? '').trim(),
      body: String(a?.summary ?? '').trim(),
      points: Array.isArray(a?.steps) ? a.steps : [],
    }))
  )
}

function ideasToText(list) {
  return serializeSections(
    (Array.isArray(list) ? list : []).map((a) => ({
      heading: String(a?.title ?? '').trim(),
      body: String(a?.summary ?? '').trim(),
      points: [],
    }))
  )
}

// ---- music スペース ----

/**
 * チャプターを "[12:34] 曲名" の行にする。
 * 時刻は概要欄に書かれているものを写すだけなので、読めない行は捨てる
 * (モデルが作った時刻をリンクにしないため。タイムコードの方針は timecode.js 参照)。
 */
function chaptersToText(list) {
  return (Array.isArray(list) ? list : [])
    .map((c) => {
      const at = parseClock(typeof c === 'string' ? c : c?.time)
      const title = String((typeof c === 'string' ? '' : c?.title) ?? '').trim()
      if (at === null || !title) return ''
      return `[${formatTimecode(at)}] ${title}`
    })
    .filter(Boolean)
    .join('\n')
}

async function generateMusicStage(stageId, connection, input, onProgress) {
  if (stageId === 'summary') {
    const instructions = fillPrompt('musicChapters', { NO_FENCE })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(input, instructions), onProgress))
    return { model: connection.model, detail: { summary: chaptersToText(parsed.chapters) } }
  }

  if (stageId === 'fields') {
    const instructions = fillPrompt('musicOverview', { NO_FENCE })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(input, instructions), onProgress))
    return { model: connection.model, detail: { fields: String(parsed.overview ?? '').trim() } }
  }

  throw new Error('unknown music stage: ' + stageId)
}

/** 第3段のコンテキスト。原文全文ではなくサマリ+分野別で足りるので軽い */
function applyContext(title, summaryText, fieldsText) {
  return [`動画タイトル: ${title}`, '', '# サマリ', summaryText, '', '# 分野別要約', fieldsText]
    .join('\n')
    .slice(0, 8000)
}

/**
 * 1段だけ生成する。
 * @param {string} stageId 'summary' | 'mindmap' | 'fields' | 'apply' | 'ideas'
 * @param {{title: string, transcript: string, summary?: string, fields?: string, mode?: string}} ctx
 * @param {(text: string) => void} [onProgress] ストリーミング中の生テキスト
 * @returns {Promise<{detail: object, model: string}>} detail は saveGenerated にそのまま渡せる形
 */
export async function generateStage(stageId, ctx, onProgress) {
  // 文面は setting.json 側にある。読み込み中・読み込み失敗のまま叩かないよう、ここで揃える
  await ensurePrompts()
  // ctx.connection は呼び出し側でモデルを選ばせるときだけ使う。無ければ画面で選んでいる接続
  const connection = ctx.connection || requireConnection()
  const transcript = String(ctx.transcript ?? '').slice(0, TRANSCRIPT_LIMIT)
  const transcriptInput = `動画タイトル: ${ctx.title}\n\n${transcript}`

  if (ctx.mode === 'music') {
    return generateMusicStage(stageId, connection, transcriptInput, onProgress)
  }

  if (stageId === 'summary') {
    const knownTags = Array.isArray(ctx.knownTags) ? ctx.knownTags : []
    const instructions = fillPrompt('summary', { NO_FENCE, TAG_RULE: tagRule(knownTags) })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(transcriptInput, instructions), onProgress))
    // プロンプトで縛っても表記ゆれは残るので、既存の綴りへ機械的に寄せ直す
    const reconciled = reconcileTags(parsed.tags, knownTags)
    return {
      model: connection.model,
      tagReport: reconciled,
      detail: {
        summary: String(parsed.summary || '').trim(),
        tags: reconciled.tags,
      },
    }
  }

  if (stageId === 'mindmap') {
    // 文字起こしにタイムスタンプが無い(旧データ)なら引用も求めない。無駄に出力が伸びるだけ
    const timed = hasTimecodes(transcript)
    const segments = timed ? splitTranscript(transcript) : []
    const instructions = fillPrompt('mindmap', {
      NO_FENCE,
      QUOTE_FIELD: timed ? MINDMAP_QUOTE_FIELD : '',
      QUOTE_RULE: timed ? MINDMAP_QUOTE_RULE : '',
    })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(transcriptInput, instructions), onProgress))
    return { model: connection.model, detail: { mindmap: mindmapToText(parsed, segments) } }
  }

  if (stageId === 'fields') {
    const timed = hasTimecodes(transcript)
    const segments = timed ? splitTranscript(transcript) : []
    const instructions = fillPrompt('fields', {
      NO_FENCE,
      POINT_SHAPE: timed ? FIELDS_POINT_SHAPE_QUOTED : FIELDS_POINT_SHAPE_PLAIN,
      QUOTE_RULE: timed ? FIELDS_QUOTE_RULE : '',
    })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(transcriptInput, instructions), onProgress))
    return { model: connection.model, detail: { fields: fieldsToText(parsed.fields, segments) } }
  }

  if (stageId === 'apply' || stageId === 'ideas') {
    const context = applyContext(ctx.title, ctx.summary || '', ctx.fields || '')
    const instructions = fillPrompt(stageId, { NO_FENCE })
    const parsed = jsonOf(await ask(connection, SHARED_SYSTEM, withInstructions(context, instructions), onProgress))
    return {
      model: connection.model,
      detail:
        stageId === 'apply'
          ? { apply: applyToText(parsed.apply) }
          : { ideas: ideasToText(parsed.ideas) },
    }
  }

  throw new Error('unknown stage: ' + stageId)
}

/**
 * 全段をまとめて生成する。段が終わるたびに onStage で通知するので、
 * 呼び出し側はその都度Notionへ保存できる(途中で失敗しても手前は残る)。
 *
 * 同じ原文を見る段を続けて直列に走らせるのは意図的。ローカルLLMは直前の
 * プロンプトと先頭が一致していればその分の読み込みを省けるので、
 * 同時に投げるよりも順番に投げたほうが速い。
 * @param {(stageId: string, detail: object, model: string) => Promise<void>|void} onStage
 */
export async function generateAll(ctx, { onStage, onStageStart, onProgress } = {}) {
  const acc = { summary: ctx.summary || '', fields: ctx.fields || '' }
  let model = null
  let tagReport = null

  for (const stage of stagesOf(ctx.mode)) {
    onStageStart?.(stage)
    const res = await generateStage(
      stage.id,
      { ...ctx, summary: acc.summary, fields: acc.fields },
      (text) => onProgress?.(stage, text)
    )
    const detail = res.detail
    model = res.model
    if (res.tagReport) tagReport = res.tagReport
    if (typeof detail.summary === 'string' && detail.summary) acc.summary = detail.summary
    if (typeof detail.fields === 'string' && detail.fields) acc.fields = detail.fields
    await onStage?.(stage.id, detail, model)
  }

  return { model, tagReport }
}
