import { renderMarkdown } from './markdown.js'
import { escapeHtml } from '../ui/render.js'
import { parseTimecode, youtubeUrlAt } from './timecode.js'

const CHAT_PREFIX = 'videos:chat:'
const SPACES_KEY = 'videos:spaces'

// 横断チャットの対象件数上限。増やすとコンテキストが膨らみ、
// 32Kトークン級のモデルでは入りきらなくなるため一律この件数で止める。
export const MAX_CROSS_ITEMS = 20
// 日本語は概ね1文字≒1.3〜1.5トークン。プロンプトの余白を見た警告しきい値
export const WARN_CHARS = 20000

function makeId() {
  return Math.random().toString(36).slice(2, 8)
}

// --- 1本の動画に対するチャット ---

export function loadChat(pageId) {
  try {
    return JSON.parse(localStorage.getItem(CHAT_PREFIX + pageId) || '[]')
  } catch {
    return []
  }
}

export function saveChat(pageId, messages) {
  try {
    localStorage.setItem(CHAT_PREFIX + pageId, JSON.stringify(messages))
  } catch {
    // 無視
  }
}

// --- 横断チャットのスペース ---

export function loadSpaces() {
  try {
    return JSON.parse(localStorage.getItem(SPACES_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveSpaces(spaces) {
  localStorage.setItem(SPACES_KEY, JSON.stringify(spaces))
}

export function newSpace(name) {
  return { id: makeId(), name: name || '新しいスペース', messages: [], targets: [] }
}

/** 1件分の横断チャット用データの文字数を見積る */
export function estimateChars(entry) {
  return JSON.stringify(entry).length
}

/**
 * Q&Aをアコーディオンで描画する。直近のやり取りだけ開いた状態にし、
 * 応答が空文字の間は「考え中」を出す。
 */
/**
 * 回答に出てきた "[12:34]" を再生リンクにする。
 * renderMarkdown が出したHTMLに対して後から差し込む。タグの中を壊さないよう、
 * '<' を含まない区間だけを対象にする。
 */
function linkTimecodes(html, videoUrl) {
  if (!videoUrl) return html
  return html.replace(/\[((?:\d{1,2}:)?\d{1,3}:\d{2})\]/g, (m, label) => {
    const at = parseTimecode(m)
    const href = at === null ? null : youtubeUrlAt(videoUrl, at)
    if (!href) return m
    return `<a class="tc tc-link" href="${href}" target="_blank" rel="noopener"><i class="ti ti-player-play" aria-hidden="true"></i>${label}</a>`
  })
}

export function renderQA(container, messages, videoUrl = '') {
  if (!messages.length) {
    container.innerHTML = '<p class="empty-section">質問するとここに表示されます</p>'
    return
  }
  const pairs = []
  for (let i = 0; i < messages.length; i += 2) pairs.push({ q: messages[i], a: messages[i + 1] })

  container.innerHTML = pairs
    .map((pair, i) => {
      const isLast = i === pairs.length - 1
      const qText = pair.q?.content || ''
      const aContent = pair.a?.content ?? ''
      const thinking = pair.a === undefined || aContent === ''
      const answer = thinking
        ? '<span class="thinking-dots"><span></span><span></span><span></span></span>'
        : linkTimecodes(renderMarkdown(aContent), videoUrl)
      return `
        <details class="qa-item" ${isLast ? 'open' : ''}>
          <summary class="qa-summary"><i class="ti ti-chevron-right" aria-hidden="true"></i><span>${escapeHtml(qText)}</span></summary>
          <div class="qa-body">
            <div class="qa-answer">
              ${thinking ? '' : `<button class="btn btn-sm qa-copy" data-index="${i}">コピー</button>`}
              ${answer}
            </div>
          </div>
        </details>
      `
    })
    .join('')

  container.querySelectorAll('.qa-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = pairs[Number(btn.dataset.index)]?.a?.content || ''
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'コピーしました'
        setTimeout(() => (btn.textContent = 'コピー'), 1500)
      })
    })
  })

  container.scrollTop = container.scrollHeight
}

/** 入力欄の高さ自動調整と Enter送信 / Shift+Enter改行 を仕込む */
export function wireComposer(inputEl, sendBtn, send) {
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px'
  })
  sendBtn.addEventListener('click', send)
}
