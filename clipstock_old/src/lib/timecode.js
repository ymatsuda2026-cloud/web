/**
 * タイムコードの扱い。
 *
 * 方針: AIに時刻を答えさせない。
 * 要点ごとに「何分何秒か」を聞くと、モデルはもっともらしい数字を作る。
 * 一度でも嘘のリンクを踏むと以降どのリンクも信用できなくなり、機能ごと死ぬ。
 * そこでAIには「根拠になった原文の短い引用」だけを出させ、その引用を
 * 文字起こしから文字列として探して時刻を割り当てる(resolveQuote)。
 * 見つからなければリンクを付けない。嘘の時刻は原理的に出ない。
 *
 * 文字起こしの想定フォーマット(process_videos.py が書く形):
 *   [12:34] このあたりで話している内容
 *   [13:04] 次のかたまり
 * タイムスタンプが無い旧データでも全機能が素通りするようにしてある。
 */

const TC = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/

/** "[1:02:03]" / "[12:34]" を秒に変換する。該当しなければ null */
export function parseTimecode(text) {
  const m = String(text ?? '').match(TC)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  return h * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 括弧なしの "12:34" / "1:02:03" を秒にする(概要欄のチャプター表記を読むため) */
export function parseClock(text) {
  return parseTimecode(`[${String(text ?? '').trim()}]`)
}

/** 秒を "12:34" / "1:02:03" にする */
export function formatTimecode(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** 行末や行頭のタイムコード表記を取り除いた本文 */
export function stripTimecode(text) {
  return String(text ?? '')
    .replace(new RegExp(TC.source, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** その秒数から再生を始めるYouTubeのURL。urlが動画URLでなければ null */
export function youtubeUrlAt(url, seconds) {
  const raw = String(url ?? '')
  const id = raw.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)?.[1]
  if (!id) return null
  const t = Math.max(0, Math.floor(Number(seconds) || 0))
  return `https://www.youtube.com/watch?v=${id}&t=${t}s`
}

/**
 * 文字起こしを [{at, text}] に分解する。
 * タイムスタンプが1つも無ければ at は null になり、呼び出し側は
 * 「時刻の無い原文」として同じ経路で扱える。
 */
export function splitTranscript(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  for (const line of lines) {
    if (!line.trim()) continue
    const at = parseTimecode(line)
    const body = at === null ? line.trim() : stripTimecode(line)
    if (!body) continue
    // 同じ時刻の連続行は1かたまりにまとめる(表示が細切れになるのを防ぐ)
    const prev = out[out.length - 1]
    if (prev && prev.at === at) prev.text += ' ' + body
    else out.push({ at, text: body })
  }
  return out
}

export function hasTimecodes(text) {
  return parseTimecode(text) !== null
}

// ---- 引用から時刻を引く ----

/** 照合用に正規化する。表記の揺れや句読点の差で外れないようにする */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s、。,.！？!?「」『』()（）・:：;；\-—ー~〜"'`]/g, '')
}

/**
 * 引用に対応する時刻を返す。
 *
 * 正規化した全文に対して引用を部分一致で探し、当たった位置を含むセグメントの
 * 開始時刻を返す。完全一致で見つからない場合は、引用の先頭から少しずつ
 * 短くして再挑戦する(モデルは引用の末尾を勝手に言い換えがちなため)。
 * それでも当たらなければ null を返し、リンクは付けない。
 *
 * @param {string} quote モデルが出した引用
 * @param {{at: number|null, text: string}[]} segments splitTranscript の結果
 * @returns {number|null} 秒
 */
export function resolveQuote(quote, segments) {
  const q = normalize(quote)
  if (q.length < 6 || !segments.length) return null

  // 正規化した全文と、その各文字がどのセグメントに属するかの対応表を作る
  let full = ''
  const owner = []
  segments.forEach((seg, i) => {
    const n = normalize(seg.text)
    full += n
    for (let k = 0; k < n.length; k++) owner.push(i)
  })

  const minLen = Math.max(6, Math.floor(q.length * 0.5))
  for (let len = q.length; len >= minLen; len = Math.floor(len * 0.8)) {
    const idx = full.indexOf(q.slice(0, len))
    if (idx !== -1) {
      const seg = segments[owner[idx]]
      return seg && seg.at !== null ? seg.at : null
    }
  }
  return null
}

/**
 * "本文 [12:34]" の形から本文と秒を分ける。
 * 保存フォーマットは「見出しや箇条書きの末尾にタイムコードを置く」形にしている。
 * Notion上でそのまま読めて、既存のセクション解析を壊さないため。
 */
export function splitLabel(text) {
  const raw = String(text ?? '')
  const at = parseTimecode(raw)
  return { text: at === null ? raw.trim() : stripTimecode(raw), at }
}

/** 本文の末尾にタイムコードを足す(秒が無ければそのまま) */
export function withTimecode(text, seconds) {
  const body = String(text ?? '').trim()
  if (seconds === null || seconds === undefined) return body
  return `${body} [${formatTimecode(seconds)}]`
}
