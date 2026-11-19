// src/config.js — デプロイごとに変える値（秘密ではない）
// GAS をウェブアプリとしてデプロイした URL（…/exec）
export const GAS_URL = 'https://script.google.com/macros/s/ここにデプロイIDを入れる/exec'
// 一覧を取り直す間隔（ほかの端末の登録を拾う）
export const POLL_MS = 120000
// Claude.ai で要約待ちを変換するときに開くページ（設定で端末ごとに変えられる）
export const CLAUDE_DEFAULT_URL = 'https://claude.ai/new'
// Mac の確認間隔（表示用。launchd の StartInterval と合わせる）
export const WORKER_EVERY_SEC = 300
