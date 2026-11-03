/**
 * 分野別要約・応用・活用アイデアの保存フォーマット。
 *
 * JSONではなく「Notionでそのまま読める見出し+箇条書き」で保存する。
 * 理由: このアプリを開かずにNotion上で直接読めることを優先したい。
 * JSONにすると人が読めず、Notionのプロパティ欄が実質使えなくなる。
 *
 *   ## セクション名
 *   本文(任意・複数行可)
 *   - 箇条書き
 *   - 箇条書き
 *   ## 次のセクション名
 *   ...
 *
 * 見出しの前に本文が来た場合は「見出し無しの先頭セクション」として扱う。
 */

/** @returns {{heading: string, body: string, points: string[]}[]} */
export function parseSections(text) {
  const lines = String(text ?? '').split('\n')
  const sections = []
  let current = null

  const ensure = () => {
    if (!current) {
      current = { heading: '', body: '', points: [] }
      sections.push(current)
    }
    return current
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = line.match(/^##\s+(.*)$/)
    if (heading) {
      current = { heading: heading[1].trim(), body: '', points: [] }
      sections.push(current)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      ensure().points.push(bullet[1].trim())
      continue
    }
    if (!line.trim()) continue
    const s = ensure()
    s.body = s.body ? `${s.body}\n${line.trim()}` : line.trim()
  }

  return sections.filter((s) => s.heading || s.body || s.points.length)
}

/** parseSections の逆。保存前に必ずこれを通してフォーマットを揃える */
export function serializeSections(sections) {
  if (!Array.isArray(sections)) return ''
  return sections
    .map((s) => {
      const out = []
      if (s.heading) out.push(`## ${String(s.heading).trim()}`)
      if (s.body) out.push(String(s.body).trim())
      ;(s.points || []).forEach((p) => {
        const t = String(p ?? '').trim()
        if (t) out.push(`- ${t}`)
      })
      return out.join('\n')
    })
    .filter(Boolean)
    .join('\n')
}

/** セクション全体の文字数。生成量が上限に収まっているかの目安表示に使う */
export function sectionsCharCount(text) {
  return String(text ?? '').length
}

// ---- アイデア1件ごとの公開 / 非公開 と ランク ----
//
// どちらも見出しの先頭に印を置くだけにしている。アイデアは応用・活用の本文の中に
// 並んでいるので、Notionの列では1件ずつ持てない。番号で覚えると作り直しや
// 並べ替えでずれるため、その見出し自身に書く。
// 既定は公開(印が無ければ公開)、ランクは未設定(0)。
//
//   ## [非公開] [★★★] アイデアの題名

const HIDDEN_TAG = '[非公開]'
const RANK_RE = /^\[(★{1,3})\]/

/** 見出しの先頭に並んだ印を読み取る */
function tagsOf(heading) {
  let rest = String(heading ?? '').trimStart()
  let hidden = false
  let rank = 0
  for (;;) {
    if (rest.startsWith(HIDDEN_TAG)) {
      hidden = true
      rest = rest.slice(HIDDEN_TAG.length).trimStart()
      continue
    }
    const m = rest.match(RANK_RE)
    if (m) {
      rank = m[1].length
      rest = rest.slice(m[0].length).trimStart()
      continue
    }
    break
  }
  return { hidden, rank, bare: rest.trim() }
}

function buildHeading(bare, hidden, rank) {
  const parts = []
  if (hidden) parts.push(HIDDEN_TAG)
  if (rank >= 1 && rank <= 3) parts.push(`[${'★'.repeat(rank)}]`)
  parts.push(bare)
  return parts.join(' ').trim()
}

export function isSectionHidden(heading) {
  return tagsOf(heading).hidden
}

/** 1〜3。印が無ければ 0(未設定) */
export function sectionRank(heading) {
  return tagsOf(heading).rank
}

/** 表示や検索に使う、印を外した見出し */
export function visibleHeading(heading) {
  return tagsOf(heading).bare
}

export function withHidden(heading, hidden) {
  const { rank, bare } = tagsOf(heading)
  return buildHeading(bare, hidden, rank)
}

export function withRank(heading, rank) {
  const { hidden, bare } = tagsOf(heading)
  return buildHeading(bare, hidden, rank)
}

/** index 番目のアイデアの公開を入れ替えた、フィールド全体の新しい文字列 */
export function setSectionHidden(text, index, hidden) {
  const sections = parseSections(text)
  if (!sections[index]) return String(text ?? '')
  sections[index] = { ...sections[index], heading: withHidden(sections[index].heading, hidden) }
  return serializeSections(sections)
}

export function setSectionRank(text, index, rank) {
  const sections = parseSections(text)
  if (!sections[index]) return String(text ?? '')
  sections[index] = { ...sections[index], heading: withRank(sections[index].heading, rank) }
  return serializeSections(sections)
}

/**
 * 見出しで探して入れ替える。一覧は静的JSONから作っていて並びが古いことがあるので、
 * 番号だけで当てにいくと別のアイデアを隠してしまう。見つからなければ元のまま返す。
 */
export function setSectionHiddenByHeading(text, heading, hidden) {
  const index = parseSections(text).findIndex((s) => visibleHeading(s.heading) === heading)
  return index === -1 ? String(text ?? '') : setSectionHidden(text, index, hidden)
}

export function setSectionRankByHeading(text, heading, rank) {
  const index = parseSections(text).findIndex((s) => visibleHeading(s.heading) === heading)
  return index === -1 ? String(text ?? '') : setSectionRank(text, index, rank)
}
