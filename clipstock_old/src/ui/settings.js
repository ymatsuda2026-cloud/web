import { escapeHtml } from './render.js'
import {
  loadConfig,
  saveConfig,
  jsonbinReady,
  pushConfigToJsonbin,
  loadJsonbinPassphrase,
  saveJsonbinPassphrase,
} from '../lib/videos-config.js'
import { loadSettings, saveSettings, newConnection } from '../lib/llm-settings.js'
import { verifyCode } from '../lib/gas.js'
import { PROMPT_IDS, promptLabel, promptOf, defaultPromptOf, savePrompt } from '../lib/prompts.js'
import { fetchBin, createBin } from '../lib/jsonbin.js'
import { isEnvelope, decryptConfig, encryptConfig } from '../lib/jsonbin-crypto.js'

function roleLabel(role) {
  if (!role) return '<span class="muted">未確認</span>'
  if (role === 'err') return '<span class="error-text">権限がありません</span>'
  if (role === 'xYz') return '<span class="ok-text">管理者 — 全機能が使えます</span>'
  return `<span class="ok-text">権限: ${escapeHtml(role)}</span>`
}

/**
 * 設定モーダル。
 * AI接続の設定は localStorage キー 'gemma-chat.settings' を
 * 議事録アプリ・gemma-chat と共有しているので、どれかで足せば全部で使える。
 *
 * @param {object} [list] 表示中の一覧JSON。{ json(): string, onApply(parsed): void }
 */
export function openSettings(onSaved, list) {
  const config = loadConfig()
  const settings = loadSettings()
  // 下書き。ここで編集し、保存時にまとめて反映する(キャンセル時は破棄)
  const draft = settings.connections.map((c) => ({ ...c, models: [...(c.models || [])] }))
  let activeId = settings.activeConnectionId
  let activeModel = settings.activeModel
  let verifiedRole = config.role
  // 一覧は畳んだ状態が既定。開いている接続のIDだけ覚えて再描画で復元する
  const openConns = new Set()
  // プロンプトも同じく下書き。保存を押すまでは実際の生成に影響させない
  const promptDraft = Object.fromEntries(PROMPT_IDS.map((id) => [id, promptOf(id)]))
  let promptId = PROMPT_IDS[0]

  const root = document.getElementById('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal modal-sticky">
        <h2 class="modal-title">設定</h2>
        <div class="modal-body">

        <label class="field-label">GAS URL</label>
        <input id="cfg-gas" class="input" value="${escapeHtml(config.gasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" />

        <label class="field-label">共有トークン</label>
        <input id="cfg-token" class="input" value="${escapeHtml(config.accessToken)}" placeholder="GASの ACCESS_TOKEN と同じ値" />

        <label class="field-label">一覧JSONの場所</label>
        <input id="cfg-data" class="input" value="${escapeHtml(config.dataUrl)}" placeholder="空欄で data/clipstock/ を使う" />
        <div class="foot-note">一覧とアイデアはここのJSONから読みます。読めなければNotionから直接取得します</div>

        <details class="json-block" id="cfg-jsonbin-block">
          <summary>設定の保存先(JSONBin)</summary>
          <div class="foot-note">この設定(GAS URL・共有トークン・コード・一覧JSONの場所・AI接続・AIへの指示)はふだんこの端末のブラウザにだけ保存されます。JSONBin(jsonbin.io)のBinを用意すると、他の端末やブラウザでも同じ設定を使えます</div>
          <label class="row">
            <input type="checkbox" id="cfg-jsonbin-use" ${config.useJsonbin ? 'checked' : ''} />
            <span>JSONBinを使う(設定をクラウドにも保存する)</span>
          </label>
          <label class="field-label">Bin ID</label>
          <input id="cfg-jsonbin-id" class="input" value="${escapeHtml(config.jsonbinBinId)}" placeholder="jsonbin.ioで作成したBinのID" />
          <label class="field-label">APIキー(X-Master-Key)</label>
          <input id="cfg-jsonbin-key" class="input" type="password" value="${escapeHtml(config.jsonbinApiKey)}" placeholder="jsonbin.ioのアカウントで発行したキー" />
          <label class="field-label">パスフレーズ(暗号化)</label>
          <input id="cfg-jsonbin-pass" class="input" type="password" autocomplete="off" placeholder="${loadJsonbinPassphrase() ? '保存済み(変えるときだけ入力)' : 'このブラウザにだけ保存します'}" />
          <div class="foot-note">Binの中身はこのパスフレーズでAES-256-GCM暗号化してから登録します。パスフレーズ自体はBinにもこの画面のJSONにも入らず、この端末のブラウザにだけ保存されます。空欄のまま保存すると平文のまま登録されるので、必ず入力してください</div>
          <div class="row">
            <button id="cfg-jsonbin-pull" class="btn">クラウドから取得</button>
            <button id="cfg-jsonbin-create" class="btn">空のBinを作る</button>
          </div>
          <div id="cfg-jsonbin-msg" class="foot-note">保存を押すと、チェックが入っていればクラウド側にも書き込みます</div>
        </details>

        <label class="field-label">コード</label>
        <div class="row">
          <input id="cfg-code" class="input grow" value="${escapeHtml(config.code)}" />
          <button id="cfg-verify" class="btn">確認</button>
        </div>
        <div id="cfg-role" class="foot-note">${roleLabel(config.role)}</div>

        <label class="field-label">AI接続</label>
        <div id="cfg-conns"></div>
        <button id="cfg-conn-add" class="btn btn-wide"><i class="ti ti-plus" aria-hidden="true"></i>接続を追加</button>

        <details class="json-block">
          <summary>AIへの指示(プロンプト)</summary>
          <div class="row">
            <select id="cfg-prompt-id" class="input grow">
              ${PROMPT_IDS.map((id) => `<option value="${id}">${escapeHtml(promptLabel(id))}</option>`).join('')}
            </select>
            <button id="cfg-prompt-reset" class="btn">既定に戻す</button>
          </div>
          <textarea id="cfg-prompt-text" rows="14" class="input mono"></textarea>
          <div class="foot-note">{{NO_FENCE}} などの差し込み欄はアプリが埋めます。消すとタグの統一や再生リンクが効かなくなります</div>
        </details>

        <details class="json-block">
          <summary>JSONで一括設定</summary>
          <textarea id="cfg-json" rows="8" class="input mono"></textarea>
          <div class="row">
            <button id="cfg-json-export" class="btn">今の設定を書き出す</button>
            <button id="cfg-json-import" class="btn">この内容を反映</button>
          </div>
        </details>

        ${list
          ? `<details class="json-block" id="cfg-list-block">
          <summary>表示中の一覧JSON</summary>
          <div class="foot-note">いま画面に出ている一覧そのものです。data/clipstock/index-video.json（webは index-web.json）と同じ形なので、コピーしてそのままファイルに貼れます</div>
          <textarea id="cfg-list-json" rows="12" class="input mono"></textarea>
          <div class="row">
            <button id="cfg-list-copy" class="btn">コピー</button>
            <button id="cfg-list-apply" class="btn">この内容を画面に反映</button>
          </div>
          <div id="cfg-list-msg" class="foot-note">反映しても Notion やファイルは変わりません。再読み込みで元に戻ります</div>
        </details>`
          : ''}

        </div>

        <div class="modal-foot">
          <button id="cfg-cancel" class="btn">キャンセル</button>
          <button id="cfg-save" class="btn btn-primary">保存</button>
        </div>
      </div>
    </div>
  `

  const $ = (id) => document.getElementById(id)

  /** baseUrl はそのまま出すと長すぎるので、一覧ではホスト名だけ見せる */
  function hostOf(url) {
    if (!url) return '接続先 未設定'
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }

  function paintConns() {
    const el = $('cfg-conns')
    el.innerHTML = draft
      .map(
        (c) => `
      <details class="conn" data-id="${c.id}" ${openConns.has(c.id) ? 'open' : ''}>
        <summary class="conn-sum">
          <span class="conn-name" data-id="${c.id}">${escapeHtml(c.label || '(表示名なし)')}</span>
          ${c.id === activeId && activeModel ? `<span class="conn-badge">使用中: ${escapeHtml(activeModel)}</span>` : ''}
          <span class="conn-meta conn-host">${escapeHtml(hostOf(c.baseUrl))}</span>
          <span class="conn-meta">${c.apiKey ? 'キー登録済' : 'キー未設定'}</span>
          <span class="conn-meta">モデル${(c.models || []).length}件</span>
        </summary>
        <div class="conn-body">
          <div class="row">
            <input class="input grow conn-label" data-id="${c.id}" value="${escapeHtml(c.label)}" placeholder="表示名(例: Gemini)" />
            ${draft.length > 1 ? `<button class="btn conn-del" data-id="${c.id}" aria-label="この接続を削除"><i class="ti ti-trash" aria-hidden="true"></i></button>` : ''}
          </div>
          <input class="input sm conn-base" data-id="${c.id}" value="${escapeHtml(c.baseUrl)}" placeholder="baseUrl (例: https://generativelanguage.googleapis.com/v1beta/openai)" />
          <input class="input sm conn-key" data-id="${c.id}" value="${escapeHtml(c.apiKey)}" placeholder="APIキー" />
          <div class="conn-models">
            ${(c.models || [])
              .map(
                (m) => `<span class="chip ${c.id === activeId && m === activeModel ? 'on' : ''} model-chip" data-conn="${c.id}" data-model="${escapeHtml(m)}">
                  ${escapeHtml(m)}<i class="ti ti-x model-del" data-conn="${c.id}" data-model="${escapeHtml(m)}" aria-hidden="true"></i>
                </span>`
              )
              .join('') || '<span class="muted">モデル未登録</span>'}
          </div>
          <div class="row">
            <input class="input sm grow conn-new" data-id="${c.id}" placeholder="モデル名を追加(例: gemini-2.5-flash)" />
            <button class="btn conn-add" data-id="${c.id}">追加</button>
          </div>
        </div>
      </details>`
      )
      .join('')

    el.querySelectorAll('details.conn').forEach((d) => {
      d.addEventListener('toggle', () => {
        if (d.open) openConns.add(d.dataset.id)
        else openConns.delete(d.dataset.id)
      })
    })

    el.querySelectorAll('.conn-label, .conn-base, .conn-key').forEach((input) => {
      input.addEventListener('input', () => {
        const c = draft.find((x) => x.id === input.dataset.id)
        if (!c) return
        if (input.classList.contains('conn-label')) {
          c.label = input.value
          // 再描画せずに見出しだけ追従させる(入力途中で畳まれないように)
          const name = el.querySelector(`.conn-name[data-id="${c.id}"]`)
          if (name) name.textContent = c.label || '(表示名なし)'
        }
        if (input.classList.contains('conn-base')) c.baseUrl = input.value
        if (input.classList.contains('conn-key')) c.apiKey = input.value
      })
    })
    el.querySelectorAll('.conn-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = draft.findIndex((x) => x.id === btn.dataset.id)
        if (i === -1) return
        draft.splice(i, 1)
        openConns.delete(btn.dataset.id)
        if (activeId === btn.dataset.id) {
          activeId = draft[0]?.id ?? null
          activeModel = draft[0]?.models?.[0] ?? null
        }
        paintConns()
      })
    })
    el.querySelectorAll('.model-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target.classList.contains('model-del')) return
        activeId = chip.dataset.conn
        activeModel = chip.dataset.model
        paintConns()
      })
    })
    el.querySelectorAll('.model-del').forEach((x) => {
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        const c = draft.find((y) => y.id === x.dataset.conn)
        if (!c) return
        c.models = c.models.filter((m) => m !== x.dataset.model)
        if (activeId === c.id && activeModel === x.dataset.model) activeModel = c.models[0] ?? null
        paintConns()
      })
    })
    el.querySelectorAll('.conn-add').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = el.querySelector(`.conn-new[data-id="${btn.dataset.id}"]`)
        const name = input.value.trim()
        if (!name) return
        const c = draft.find((x) => x.id === btn.dataset.id)
        if (!c) return
        if (!c.models.includes(name)) c.models.push(name)
        if (!activeId) {
          activeId = c.id
          activeModel = name
        }
        input.value = ''
        paintConns()
      })
    })
  }
  paintConns()

  $('cfg-conn-add').addEventListener('click', () => {
    const added = newConnection({ label: `接続${draft.length + 1}` })
    draft.push(added)
    openConns.add(added.id)
    paintConns()
  })

  $('cfg-prompt-text').value = promptDraft[promptId]
  $('cfg-prompt-text').addEventListener('input', (e) => {
    promptDraft[promptId] = e.target.value
  })
  $('cfg-prompt-id').addEventListener('change', (e) => {
    promptId = e.target.value
    $('cfg-prompt-text').value = promptDraft[promptId]
  })
  $('cfg-prompt-reset').addEventListener('click', () => {
    promptDraft[promptId] = defaultPromptOf(promptId)
    $('cfg-prompt-text').value = promptDraft[promptId]
  })

  if (list) wireListJson(list)

  /** 表示中の一覧JSON。中身が大きいので、開いたときに初めて流し込む */
  function wireListJson(ctx) {
    const area = $('cfg-list-json')
    const msg = $('cfg-list-msg')
    $('cfg-list-block').addEventListener('toggle', (e) => {
      if (e.target.open && !area.value) area.value = ctx.json()
    })
    $('cfg-list-copy').addEventListener('click', async () => {
      if (!area.value) area.value = ctx.json()
      const btn = $('cfg-list-copy')
      try {
        await navigator.clipboard.writeText(area.value)
        btn.textContent = 'コピーしました'
        setTimeout(() => (btn.textContent = 'コピー'), 1500)
      } catch {
        area.select()
        msg.textContent = 'コピーできませんでした。選択したので手動でコピーしてください'
      }
    })
    $('cfg-list-apply').addEventListener('click', () => {
      let parsed
      try {
        parsed = JSON.parse(area.value)
      } catch (err) {
        msg.innerHTML = `<span class="error-text">JSONの形式が不正です: ${escapeHtml(String(err.message || err))}</span>`
        return
      }
      if (!Array.isArray(parsed.items)) {
        msg.innerHTML = '<span class="error-text">items が配列ではありません</span>'
        return
      }
      ctx.onApply(parsed)
      msg.innerHTML = `<span class="ok-text">${parsed.items.length}件を画面に反映しました(再読み込みで元に戻ります)</span>`
    })
  }

  $('cfg-cancel').addEventListener('click', () => (root.innerHTML = ''))

  $('cfg-json-export').addEventListener('click', () => {
    $('cfg-json').value = JSON.stringify(
      {
        gasUrl: $('cfg-gas').value.trim(),
        accessToken: $('cfg-token').value.trim(),
        code: $('cfg-code').value.trim(),
        dataUrl: $('cfg-data').value.trim(),
        connections: draft.map(({ label, baseUrl, apiKey, models }) => ({ label, baseUrl, apiKey, models })),
        activeConnectionLabel: draft.find((c) => c.id === activeId)?.label,
        activeModel,
      },
      null,
      2
    )
  })

  /**
   * JSONで受け取った設定をフォームへ反映する。
   * 手貼りのJSON一括設定と、JSONBinからの取得の両方から使う。
   * ここで反映しても保存を押すまでは確定しない。
   *
   * connections はJSONBinからの取得なら parsed.llmSettings.connections(AI接続まるごと)、
   * 手貼りのJSON一括設定なら parsed.connections(簡易形式)のどちらかで入ってくる。
   * promptOverrides はJSONBinからの取得のときだけ入ってくる(AIへの指示)。
   */
  function applyParsedConfig(parsed) {
    if (parsed.gasUrl !== undefined) $('cfg-gas').value = parsed.gasUrl
    if (parsed.accessToken !== undefined) $('cfg-token').value = parsed.accessToken
    if (parsed.code !== undefined) $('cfg-code').value = parsed.code
    if (parsed.dataUrl !== undefined) $('cfg-data').value = parsed.dataUrl

    const llm = parsed.llmSettings
    if (llm && Array.isArray(llm.connections) && llm.connections.length) {
      draft.length = 0
      openConns.clear()
      llm.connections.forEach((c) => draft.push(newConnection(c)))
      const match = draft.find((c) => c.id === llm.activeConnectionId) || draft[0]
      activeId = match.id
      activeModel = match.models?.includes(llm.activeModel) ? llm.activeModel : match.models?.[0] ?? null
      paintConns()
    } else if (Array.isArray(parsed.connections) && parsed.connections.length) {
      draft.length = 0
      openConns.clear()
      parsed.connections.forEach((c) => draft.push(newConnection(c)))
      const match = draft.find((c) => c.label === parsed.activeConnectionLabel) || draft[0]
      activeId = match.id
      activeModel = match.models?.includes(parsed.activeModel) ? parsed.activeModel : match.models?.[0] ?? null
      paintConns()
    }

    if (parsed.promptOverrides && typeof parsed.promptOverrides === 'object') {
      PROMPT_IDS.forEach((id) => {
        if (typeof parsed.promptOverrides[id] === 'string') promptDraft[id] = parsed.promptOverrides[id]
      })
      $('cfg-prompt-text').value = promptDraft[promptId]
    }

    if (parsed.code) $('cfg-verify').click()
  }

  $('cfg-json-import').addEventListener('click', () => {
    let parsed
    try {
      parsed = JSON.parse($('cfg-json').value)
    } catch (err) {
      alert('JSONの形式が不正です: ' + (err.message || err))
      return
    }
    applyParsedConfig(parsed)
  })

  $('cfg-jsonbin-pull').addEventListener('click', async () => {
    const binId = $('cfg-jsonbin-id').value.trim()
    const apiKey = $('cfg-jsonbin-key').value.trim()
    const msg = $('cfg-jsonbin-msg')
    if (!binId || !apiKey) {
      msg.innerHTML = '<span class="error-text">Bin IDとAPIキーを入力してください</span>'
      return
    }
    msg.textContent = '取得中...'
    try {
      let remote = await fetchBin(binId, apiKey)
      if (isEnvelope(remote)) {
        const passphrase = $('cfg-jsonbin-pass').value.trim() || loadJsonbinPassphrase()
        if (!passphrase) throw new Error('暗号化されています。パスフレーズを入力してください')
        remote = await decryptConfig(remote, passphrase)
      }
      applyParsedConfig(remote)
      msg.innerHTML = '<span class="ok-text">クラウドの設定を反映しました(保存を押すまでは確定しません)</span>'
    } catch (err) {
      msg.innerHTML = `<span class="error-text">取得に失敗しました: ${escapeHtml(String(err.message || err))}</span>`
    }
  })

  $('cfg-jsonbin-create').addEventListener('click', async () => {
    const apiKey = $('cfg-jsonbin-key').value.trim()
    const msg = $('cfg-jsonbin-msg')
    if (!apiKey) {
      msg.innerHTML = '<span class="error-text">先にAPIキーを入力してください</span>'
      return
    }
    msg.textContent = '作成中...'
    try {
      const snapshot = {
        gasUrl: $('cfg-gas').value.trim(),
        accessToken: $('cfg-token').value.trim(),
        code: $('cfg-code').value.trim(),
        dataUrl: $('cfg-data').value.trim(),
      }
      const passphrase = $('cfg-jsonbin-pass').value.trim() || loadJsonbinPassphrase()
      const body = passphrase ? await encryptConfig(snapshot, passphrase) : snapshot
      const id = await createBin(apiKey, body, { name: 'clipstock-config' })
      $('cfg-jsonbin-id').value = id
      msg.innerHTML = `<span class="ok-text">Binを作成しました(ID: ${escapeHtml(id)})。保存を押して確定してください</span>`
    } catch (err) {
      msg.innerHTML = `<span class="error-text">作成に失敗しました: ${escapeHtml(String(err.message || err))}</span>`
    }
  })

  $('cfg-verify').addEventListener('click', async () => {
    const gasUrl = $('cfg-gas').value.trim()
    const roleEl = $('cfg-role')
    if (!gasUrl) {
      roleEl.innerHTML = '<span class="error-text">GAS URLを先に入力してください</span>'
      return
    }
    roleEl.textContent = '確認中...'
    try {
      const res = await verifyCode(gasUrl, $('cfg-code').value.trim())
      verifiedRole = res.role
      roleEl.innerHTML = roleLabel(res.role)
    } catch (err) {
      roleEl.innerHTML = `<span class="error-text">${escapeHtml(String(err.message || err))}</span>`
    }
  })

  $('cfg-save').addEventListener('click', async () => {
    const newConfig = {
      ...config,
      gasUrl: $('cfg-gas').value.trim(),
      accessToken: $('cfg-token').value.trim(),
      code: $('cfg-code').value.trim(),
      dataUrl: $('cfg-data').value.trim(),
      role: verifiedRole,
      useJsonbin: $('cfg-jsonbin-use').checked,
      jsonbinBinId: $('cfg-jsonbin-id').value.trim(),
      jsonbinApiKey: $('cfg-jsonbin-key').value.trim(),
    }

    // パスフレーズは空欄なら「保存済みのものを変えない」。JSONBinを使うなら必須(平文で登録させない)
    const passInput = $('cfg-jsonbin-pass').value.trim()
    if (newConfig.useJsonbin && !passInput && !loadJsonbinPassphrase()) {
      $('cfg-jsonbin-msg').innerHTML = '<span class="error-text">JSONBinを使うにはパスフレーズを入力してください(中身を暗号化して登録するため)</span>'
      return
    }
    if (passInput) saveJsonbinPassphrase(passInput)

    // この端末への保存は先に済ませる。クラウドへの書き込みが失敗しても消えないように
    saveConfig(newConfig)
    saveSettings({ ...settings, connections: draft, activeConnectionId: activeId, activeModel })
    PROMPT_IDS.forEach((id) => savePrompt(id, promptDraft[id]))

    if (jsonbinReady(newConfig)) {
      const saveBtn = $('cfg-save')
      const msg = $('cfg-jsonbin-msg')
      saveBtn.disabled = true
      saveBtn.textContent = '保存中(クラウド同期)...'
      try {
        await pushConfigToJsonbin(newConfig)
      } catch (err) {
        saveBtn.disabled = false
        saveBtn.textContent = '保存'
        if (msg) {
          msg.innerHTML = `<span class="error-text">クラウドへの保存に失敗しました: ${escapeHtml(String(err.message || err))}(この端末には保存済みです)</span>`
        }
        return // モーダルは開いたままにして、再試行できるようにする
      }
    }

    root.innerHTML = ''
    onSaved?.()
  })
}

/** 汎用の入力ダイアログ。タグ追加や手編集のテキストエリアに使う */
export function openEditor({ title, value = '', multiline = true, hint = '', onSave }) {
  const root = document.getElementById('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <h2 class="modal-title">${escapeHtml(title)}</h2>
        ${hint ? `<p class="foot-note">${escapeHtml(hint)}</p>` : ''}
        ${multiline
          ? `<textarea id="ed-value" class="input" rows="14">${escapeHtml(value)}</textarea>`
          : `<input id="ed-value" class="input" value="${escapeHtml(value)}" />`}
        <div class="modal-foot">
          <button id="ed-cancel" class="btn">キャンセル</button>
          <button id="ed-save" class="btn btn-primary">保存</button>
        </div>
      </div>
    </div>
  `
  const input = document.getElementById('ed-value')
  input.focus()
  document.getElementById('ed-cancel').addEventListener('click', () => (root.innerHTML = ''))
  document.getElementById('ed-save').addEventListener('click', async () => {
    const next = input.value
    root.innerHTML = ''
    await onSave?.(next)
  })
}
