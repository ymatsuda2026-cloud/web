function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

/**
 * LLMの応答に含まれる簡易Markdownをhtmlに変換する。
 * 完全なパーサではなく、チャット回答でよく使われる書式(見出し・箇条書き・
 * コードブロック・強調・リンク)だけをカバーする軽量実装。
 */
export function renderMarkdown(md) {
  const lines = String(md ?? '').split('\n')
  let html = ''
  let inCode = false
  let codeBuf = []
  let listBuf = []
  let listType = null

  const flushList = () => {
    if (listBuf.length) {
      html += `<${listType}>${listBuf.map((li) => `<li>${li}</li>`).join('')}</${listType}>`
      listBuf = []
      listType = null
    }
  }

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (!inCode) {
        inCode = true
        codeBuf = []
      } else {
        inCode = false
        html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`
      }
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      continue
    }

    const heading = raw.match(/^(#{1,3})\s+(.*)/)
    if (heading) {
      flushList()
      const level = heading[1].length + 2
      html += `<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`
      continue
    }

    const ordered = raw.match(/^\d+\.\s+(.*)/)
    if (ordered) {
      if (listType !== 'ol') { flushList(); listType = 'ol' }
      listBuf.push(inline(escapeHtml(ordered[1])))
      continue
    }

    const bulleted = raw.match(/^[-*]\s+(.*)/)
    if (bulleted) {
      if (listType !== 'ul') { flushList(); listType = 'ul' }
      listBuf.push(inline(escapeHtml(bulleted[1])))
      continue
    }

    flushList()
    if (raw.trim() === '') {
      html += '<br />'
    } else {
      html += `<p>${inline(escapeHtml(raw))}</p>`
    }
  }
  flushList()
  if (inCode && codeBuf.length) {
    html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`
  }
  return html
}
