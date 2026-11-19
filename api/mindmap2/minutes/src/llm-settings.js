// gemma-chat アプリと同じ localStorage キーを共有する。
// 接続(baseURL+APIキー)とその配下のモデル一覧を一箇所で管理し、
// どちらのアプリからも追加・切り替えができるようにするための意図的な共有。
// 中身は gemma-chat 側の src/lib/settings.js と同一に保つこと
// (このファイルを変更したら、そちらにも同じ内容を反映すること)。

const KEY = 'gemma-chat.settings'

function makeId() {
  return Math.random().toString(36).slice(2, 8)
}

/**
 * 接続 = baseURL + APIキーの組。1接続に複数モデルをぶら下げられる。
 */
export function newConnection(over = {}) {
  return {
    id: makeId(),
    label: '新しい接続',
    baseUrl: '',
    apiKey: '',
    numCtx: 32768,
    gasUrl: '',
    controlToken: '',
    think: null,
    models: [],
    ...over,
  }
}

export const DEFAULT_SETTINGS = {
  connections: [],
  activeConnectionId: null,
  activeModel: null,
  temperature: 0.7,
  systemPrompt: '必ず日本語で回答してください。',
}

/**
 * 旧形式からの移行。
 * 世代1: { baseUrl, apiKey, model, ... } (プロファイル概念すら無い最古の形式)
 * 世代2: { profiles: [{ id, label, baseUrl, apiKey, model, ... }], activeId }
 * 世代3(現行): { connections: [{ id, label, baseUrl, apiKey, models: [...], ... }], activeConnectionId, activeModel }
 */
function migrate(raw) {
  let s = { ...raw }

  // 世代1 -> 世代2相当のprofilesへ寄せる
  if (!Array.isArray(s.connections) && !Array.isArray(s.profiles) && (s.baseUrl || s.apiKey)) {
    s.profiles = [{
      id: 'a',
      label: s.model || 'メイン',
      baseUrl: s.baseUrl || '',
      apiKey: s.apiKey || '',
      model: s.model || '',
      numCtx: s.numCtx || 32768,
      gasUrl: s.gasUrl || '',
      controlToken: s.controlToken || '',
    }]
    s.activeId = 'a'
  }

  // 世代2 -> 世代3(1プロファイル1モデルだったものを、モデル1件の接続として扱う)
  if (Array.isArray(s.profiles) && !Array.isArray(s.connections)) {
    s.connections = s.profiles.map((p) => ({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl || '',
      apiKey: p.apiKey || '',
      numCtx: p.numCtx || 32768,
      gasUrl: p.gasUrl || '',
      controlToken: p.controlToken || '',
      think: p.think ?? null,
      models: p.model ? [p.model] : [],
    }))
    const activeP = s.profiles.find((p) => p.id === s.activeId)
    s.activeConnectionId = activeP?.id ?? s.connections[0]?.id ?? null
    s.activeModel = activeP?.model || s.connections[0]?.models[0] || null
    delete s.profiles
    delete s.activeId
  }

  if (!Array.isArray(s.connections)) s.connections = []
  if (!s.connections.length) s.connections = [newConnection()]

  if (!s.connections.some((c) => c.id === s.activeConnectionId)) {
    s.activeConnectionId = s.connections[0].id
  }
  const active = s.connections.find((c) => c.id === s.activeConnectionId)
  if (!active.models?.includes(s.activeModel)) {
    s.activeModel = active.models?.[0] ?? null
  }

  return { ...DEFAULT_SETTINGS, ...s }
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    return migrate(raw ? JSON.parse(raw) : {})
  } catch {
    return { ...DEFAULT_SETTINGS, connections: [newConnection()] }
  }
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s))
}

export function activeConnection(s) {
  return s.connections.find((c) => c.id === s.activeConnectionId) ?? s.connections[0] ?? null
}

/** 現在アクティブな接続+モデルから、API呼び出し用のパラメータを組み立てる */
export function connectionOf(s) {
  const c = activeConnection(s)
  if (!c) return null
  const model = c.models?.includes(s.activeModel) ? s.activeModel : c.models?.[0]
  if (!model) return null
  return {
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    model,
    numCtx: c.numCtx,
    temperature: s.temperature,
    think: c.think ?? null,
  }
}

/** トップバー等での表示用に、現在アクティブなモデル名だけを返す */
export function activeModelName(s) {
  return connectionOf(s)?.model ?? null
}

/** 接続を横断した「接続ラベル + モデル名」の一覧。クイック切り替えメニュー用 */
export function allModels(s) {
  return s.connections.flatMap((c) =>
    (c.models || []).map((model) => ({
      connectionId: c.id,
      connectionLabel: c.label,
      model,
      active: c.id === s.activeConnectionId && model === s.activeModel,
    }))
  )
}
