function headers(s) {
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${s.apiKey}`,
  }
  // ngrok経由の自前ホスト環境でのみ必要なヘッダー。
  // Gemini等の外部APIに付けるとCORSプリフライトで許可されず、
  // Access-Control-Allow-Originが一切返らずリクエストが即失敗する。
  if (s.baseUrl?.includes('ngrok')) {
    h['ngrok-skip-browser-warning'] = 'true'
  }
  return h
}

export async function fetchModels(s, signal) {
  const res = await fetch(`${s.baseUrl}/models`, { headers: headers(s), signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return (json?.data ?? []).map((m) => m.id)
}

export async function* streamChat(s, messages, signal) {
  const isOllamaLike = s.baseUrl?.includes('ngrok')

  const res = await fetch(`${s.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(s),
    signal,
    body: JSON.stringify({
      model: s.model,
      messages,
      stream: true,
      temperature: s.temperature,
      // num_ctx はOllama独自のパラメータ。OpenAI互換API標準には存在せず、
      // Gemini等に送ると「Unknown name "num_ctx"」でHTTP 400になる。
      ...(isOllamaLike ? { num_ctx: s.numCtx } : {}),
      ...(isOllamaLike && typeof s.think === 'boolean' ? { think: s.think } : {}),
    }),
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${body.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  const processLine = function* (line) {
    line = line.trim()
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (payload === '[DONE]' || !payload) return
    try {
      const json = JSON.parse(payload)
      const delta = json?.choices?.[0]?.delta?.content ?? ''
      if (delta) yield { delta }
      if (json?.usage) yield { usage: json.usage }
    } catch {
      // 不完全な行は次のチャンクで補完されるため無視
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      // ストリーム終了時にバッファへ残っている最終行(末尾に改行が来る前に
      // 接続が閉じた場合の最後のチャンク)を処理する。ここを素通りすると
      // 応答の末尾が欠けたまま表示されてしまう。
      buf += decoder.decode() // flush残りのバイト列を確定させる
      if (buf.trim()) yield* processLine(buf)
      break
    }
    buf += decoder.decode(value, { stream: true })

    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim().startsWith('data:') && line.slice(line.indexOf(':') + 1).trim() === '[DONE]') return
      yield* processLine(line)
    }
  }
}
