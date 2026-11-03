import { escapeHtml } from './render.js'
import { loadConfig, saveConfig, setupJsonbin, saveJsonbinPassphrase } from '../lib/videos-config.js'
import { loadSettings, saveSettings, newConnection } from '../lib/llm-settings.js'
import { verifyCode } from '../lib/gas.js'

/**
 * 初回設定画面。GAS URL と共有トークンが未設定のときに、起動直後に出す。
 *
 * 入力欄(GAS URL・共有トークン・一覧JSONの場所・コード・AI接続)はどちらの保存先でも同じで、
 * 保存先だけを選ぶ:
 *   JSONBin  … 入力した内容をJSONBinに保存する。以降の変更(設定画面での保存)もJSONBinに書く。
 *              Bin IDを入れればそのBinの保存済み設定を読み込み(空欄の項目はBinの値を使う)、
 *              空欄なら新しいBinを作る。
 *   この端末のみ … これまでどおりlocalStorageだけに保存する。JSONBinには何も送らない。
 *
 * 保存を押すまで何も書かない。Binを読めなかったときもこの端末の設定は変えない。
 *
 * @param {() => void} onDone 設定が済んだあとに呼ぶ(一覧の読み込みを始める)
 */
export function openSetup(onDone) {
  const config = loadConfig()
  let mode = config.useJsonbin ? 'jsonbin' : 'local'
  let verifiedRole = ''

  const root = document.getElementById('modal-root')
  root.innerHTML = `
    <div class="overlay">
      <div class="modal modal-sticky">
        <h2 class="modal-title">はじめの設定</h2>
        <div class="modal-body">
          <div class="foot-note">設定の保存先を選んでください。あとから設定画面(右上の歯車)でも変えられます</div>

          <label class="row">
            <input type="radio" name="su-mode" value="jsonbin" ${mode === 'jsonbin' ? 'checked' : ''} />
            <span>JSONBinを使う(下の設定をJSONBinに保存し、変更もJSONBinに書く)</span>
          </label>
          <label class="row">
            <input type="radio" name="su-mode" value="local" ${mode === 'local' ? 'checked' : ''} />
            <span>JSONBinを使わない(この端末のブラウザにだけ保存する)</span>
          </label>

          <div id="su-jsonbin">
            <label class="field-label">Bin ID</label>
            <input id="su-bin-id" class="input" value="${escapeHtml(config.jsonbinBinId)}" placeholder="空欄なら新しいBinを作ります" />
            <div class="foot-note">すでにBinがあるときはそのIDを入れると、保存してある設定を読み込みます。下の入力欄が空の項目はBinの値を使います</div>
            <label class="field-label">APIキー(X-Master-Key)</label>
            <input id="su-bin-key" class="input" type="password" value="${escapeHtml(config.jsonbinApiKey)}" placeholder="jsonbin.ioで発行したキー" />
            <label class="field-label">パスフレーズ(暗号化)</label>
            <input id="su-bin-pass" class="input" type="password" autocomplete="off" placeholder="Binを暗号化するパスフレーズ(新規なら好きな文字列)" />
            <div class="foot-note">Binの中身はこのパスフレーズでAES-256-GCM暗号化してから保存します(GAS URL・共有トークン・AIのAPIキーがそのまま載りません)。パスフレーズはこの端末のブラウザにだけ保存します。忘れると復号できないので控えておいてください</div>
          </div>

          <div id="su-settings">
            <label class="field-label">GAS URL</label>
            <input id="su-gas" class="input" value="${escapeHtml(config.gasUrl)}" placeholder="https://script.google.com/macros/s/.../exec" />

            <label class="field-label">共有トークン</label>
            <input id="su-token" class="input" value="${escapeHtml(config.accessToken)}" placeholder="GASの ACCESS_TOKEN と同じ値" />

            <label class="field-label">一覧JSONの場所</label>
            <input id="su-data" class="input" value="${escapeHtml(config.dataUrl)}" placeholder="空欄で data/clipstock/ を使う" />

            <label class="field-label">コード</label>
            <div class="row">
              <input id="su-code" class="input grow" value="${escapeHtml(config.code)}" />
              <button id="su-verify" class="btn">確認</button>
            </div>
            <div id="su-role" class="foot-note">使わなければ空欄のままで構いません</div>

            <label class="field-label">AI接続(あとから設定画面でも追加できます)</label>
            <input id="su-ai-label" class="input sm" placeholder="表示名(例: Gemini)" />
            <input id="su-ai-base" class="input sm" placeholder="baseUrl (例: https://generativelanguage.googleapis.com/v1beta/openai)" />
            <input id="su-ai-key" class="input sm" type="password" placeholder="APIキー" />
            <input id="su-ai-model" class="input sm" placeholder="モデル名(例: gemini-2.5-flash)" />
          </div>

          <div id="su-msg" class="foot-note"></div>
        </div>

        <div class="modal-foot">
          <button id="su-later" class="btn">あとで</button>
          <button id="su-go" class="btn btn-primary"></button>
        </div>
      </div>
    </div>
  `

  const $ = (id) => document.getElementById(id)
  const msg = (html) => ($('su-msg').innerHTML = html)
  const err = (e) => msg(`<span class="error-text">${escapeHtml(String(e?.message || e))}</span>`)

  function paintMode() {
    $('su-jsonbin').hidden = mode !== 'jsonbin'
    $('su-go').textContent = mode === 'jsonbin' ? 'JSONBinに保存して始める' : '保存して始める'
    msg('')
  }
  paintMode()

  root.querySelectorAll('input[name="su-mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      mode = r.value
      paintMode()
    })
  )

  // 閉じても次回の起動でまた出る(未設定のままなので)。一覧側にも案内が出る
  $('su-later').addEventListener('click', () => {
    root.innerHTML = ''
    onDone?.()
  })

  $('su-verify').addEventListener('click', async () => {
    const gasUrl = $('su-gas').value.trim()
    if (!gasUrl) return ($('su-role').innerHTML = '<span class="error-text">GAS URLを先に入力してください</span>')
    $('su-role').textContent = '確認中...'
    try {
      const res = await verifyCode(gasUrl, $('su-code').value.trim())
      verifiedRole = res.role
      $('su-role').innerHTML =
        res.role === 'err'
          ? '<span class="error-text">権限がありません</span>'
          : res.role === 'xYz'
            ? '<span class="ok-text">管理者 — 全機能が使えます</span>'
            : `<span class="ok-text">権限: ${escapeHtml(res.role)}</span>`
    } catch (e) {
      $('su-role').innerHTML = `<span class="error-text">${escapeHtml(String(e?.message || e))}</span>`
    }
  })

  $('su-go').addEventListener('click', async () => {
    const btn = $('su-go')
    btn.disabled = true
    try {
      if (mode === 'jsonbin') await goJsonbin()
      else goLocal()
    } catch (e) {
      err(e)
    } finally {
      btn.disabled = false
    }
  })

  /** 入力欄の内容を、AI接続1件(表示名・baseUrl・モデル名が揃っているときだけ)として登録する */
  function registerConnection() {
    const base = $('su-ai-base').value.trim()
    const model = $('su-ai-model').value.trim()
    if (!base || !model) return // 空のままなら今ある接続に触らない
    const settings = loadSettings()
    const conn = newConnection({
      label: $('su-ai-label').value.trim() || '接続1',
      baseUrl: base,
      apiKey: $('su-ai-key').value.trim(),
      models: [model],
    })
    // 初期状態の空の接続(baseUrlなし・モデルなし)は置き換え、既存の接続は残す
    const kept = settings.connections.filter((c) => c.baseUrl || (c.models || []).length)
    saveSettings({ ...settings, connections: [...kept, conn], activeConnectionId: conn.id, activeModel: model })
  }

  /**
   * 入力した設定をJSONBinに保存する。Bin IDがあればそのBinを先に読み(読めなければ何も書かない)、
   * 空欄ならBinを新しく作る。成功すると以降の設定画面での保存もJSONBinへ書かれる。
   */
  async function goJsonbin() {
    const binId = $('su-bin-id').value.trim()
    const apiKey = $('su-bin-key').value.trim()
    const passphrase = $('su-bin-pass').value.trim()
    if (!apiKey) throw new Error('APIキーを入力してください')
    if (!passphrase) throw new Error('パスフレーズを入力してください(Binの中身を暗号化するため)')
    msg(binId ? '読み込んで保存中...' : 'Binを作って保存中...')
    const saved = await setupJsonbin({
      binId,
      apiKey,
      passphrase,
      overrides: {
        gasUrl: $('su-gas').value.trim(),
        accessToken: $('su-token').value.trim(),
        dataUrl: $('su-data').value.trim(),
        code: $('su-code').value.trim(),
        role: verifiedRole,
      },
      beforeSave: registerConnection,
    })
    root.innerHTML = ''
    if (!binId) {
      // 作ったBin IDは設定画面に残るが、控えておかないと別の端末で読めない
      alert(`JSONBinに保存しました。\n\nBin ID: ${saved.jsonbinBinId}\n\n別の端末ではこのBin ID・APIキー・パスフレーズを入力すると同じ設定を読み込めます。控えておいてください。`)
    }
    onDone?.()
  }

  /** この端末のlocalStorageだけに保存する。JSONBinへは何も送らない */
  function goLocal() {
    const gasUrl = $('su-gas').value.trim()
    const accessToken = $('su-token').value.trim()
    if (!gasUrl || !accessToken) throw new Error('GAS URLと共有トークンは必須です')

    saveConfig({
      ...config,
      gasUrl,
      accessToken,
      dataUrl: $('su-data').value.trim(),
      code: $('su-code').value.trim(),
      role: verifiedRole || config.role,
      useJsonbin: false,
    })
    saveJsonbinPassphrase('') // 使わない選択なので、以前のパスフレーズも残さない
    registerConnection()

    root.innerHTML = ''
    onDone?.()
  }
}
