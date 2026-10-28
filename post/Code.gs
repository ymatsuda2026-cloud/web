/**
 * X自動ポスト 中継API（Google Apps Script）
 *
 * GitHub Pages の管理画面と claude.ai の生成画面から呼ばれ、Notion の
 * 「抽出ポスト①」（元ネタ）「生成ポスト①」「自動ポスト設定」を読み書きする。
 *
 * 抽出ポスト①の「アカウント」に指定されたアカウントごとに、生成ポスト①へ
 * 状態「空」の行を自動で作る（syncSources。installTrigger で15分ごとに実行）。
 *
 * スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   NOTION_TOKEN  : Notion インテグレーションのシークレット
 *   APP_KEY       : 画面側と共有する認証キー（任意の長い文字列）
 *   SRC_DB        : 抽出ポスト① のデータベースID
 *   GEN_DB        : 生成ポスト① のデータベースID
 *   SETTINGS_DB   : 自動ポスト設定 のデータベースID
 *
 * 呼び出し方：POST で本文に JSON 文字列 {"key":APP_KEY,"action":"...", ...}
 * （Content-Type は付けない＝text/plain。ブラウザの事前確認を避けるため）
 */

const NOTION_VERSION = '2022-06-28';
const STATUSES = ['空', '生成済', '候補', '採用', '再生成'];
const SLOTS = ['P1-1', 'P1-2', 'P2-1', 'P2-2', 'P3-1', 'P3-2'];
const PATTERNS = ['1', '2', '3'];

// setStatus で許す状態の移動（移動元 → 移動先）
// 空→生成済 と 再生成→生成済（生成結果つき）は saveGenerated、→採用 は adopt で行う
const TRANSITIONS = {
  '生成済': ['候補'],
  '候補': ['生成済'],
  '採用': ['候補'],
  '再生成': ['生成済']
};

const DEFAULT_SETTINGS = {
  template: [
    '# 指示',
    'あなたは「女性心理と性愛の解像度が高い大人の男性」として、X（旧Twitter）向けの2連スレッド投稿（ツリー投稿）を作成するプロフェッショナルです。',
    '入力される【元のポスト・メモ】を元に、要件をすべて満たしたポストを3パターン作成してください。',
    '',
    '# 目的・ポジショニング',
    '- 女性読者から「この人は本当に女の体を分かってる」「共感しかない」「この人に抱かれたい」と思わせる。',
    '- 一般的な男性の勘違い（激しさ、深さ、スピード至上主義など）との対比を用い、投稿主の「大人の余裕・包容力・圧倒的な安心感」を演出する。',
    '- 即物的な下品さを徹底的に排除し、肌の温度・密着・心理描写によって艶っぽさと興奮を引き出す。',
    '',
    '# 構成要件',
    '必ず以下の「2部構成（2連スレッド）」に分割すること。',
    '',
    '- **【1ポスト目（フック・問題提起）】**',
    '  - 文字数：80〜120文字（全角140文字以内厳守）',
    '  - 「普通の男の勘違い」や「女性の秘めた本音」を突いて手を止めさせる。',
    '  - 末尾は必ず「↓」などで自然に2ポスト目を開かせる導線にする。',
    '',
    '- **【2ポスト目（答え・回収）】**',
    '  - 文字数：110〜138文字（全角140文字以内厳守）',
    '  - 1部で提示した疑問に対する明確な「答え・本質」を一言で提示。',
    '  - 元データの要点を簡潔な箇条書きや短いフレーズでリスト化。',
    '  - 最後は「大人の余裕・包容力・余韻」を感じさせる一言で締め、保存・いいねを促す。',
    '',
    '# 文体・ワーディングルール',
    '- 解剖学的・医学的すぎる硬い単語（膀胱壁、生殖器など）は避け、情緒的・官能的な表現（芯、奥のツボ、肌の温度、重み、隙間ゼロなど）に昇華する。',
    '- 説教くさくならず、自身の経験や女性への深い理解から自然と滲み出る落ち着いたトーンにする。',
    '- 絵文字は使わないか、使っても最小限（基本はテキストと改行の美しさで読ませる）。',
    '',
    '# 出力フォーマット',
    '以下の3パターンを出力してください。',
    '- パターン1：王道・共感重視（保存・いいね狙い）',
    '- パターン2：心理描写・大人の色気重視（妄想・興奮を刺激）',
    '- パターン3：短尺・辛口フック（インプレッション狙い）',
    '',
    '各パターンの【1ポスト目】【2ポスト目】の下に、正確な文字数（全角換算）を明記してください。',
    '',
    '---',
    '',
    '【元のポスト・メモ】',
    'ここにNotionから抽出したポストやメモを貼り付け'
  ].join('\n'),
  regenAlways: '前回の文面と同じ言い回しを避ける。対象に指定されていないポストは変えない。',
  ranges: { p1: { min: 80, max: 120 }, p2: { min: 110, max: 138 }, limit: 140 },
  patterns: [
    { name: '王道・共感重視', aim: '保存・いいね狙い' },
    { name: '心理描写・大人の色気重視', aim: '妄想・興奮を刺激' },
    { name: '短尺・辛口フック', aim: 'インプレッション狙い' }
  ],
  accounts: []
};
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

// アカウント設定：{ name, method:'自動'|'手動', tags:[扱うタグ], persona, template, regenAlways }
// template・regenAlways が空なら共通の設定を使う
function normalizeAccounts_(list) {
  return (Array.isArray(list) ? list : []).map(a => ({
    name: String((a && a.name) || '').trim(),
    method: a && a.method === '手動' ? '手動' : '自動',
    tags: Array.isArray(a && a.tags) ? a.tags.map(t => String(t).trim()).filter(Boolean) : [],
    persona: String((a && a.persona) || ''),
    template: String((a && a.template) || ''),
    regenAlways: String((a && a.regenAlways) || '')
  })).filter(a => a.name);
}

// アカウントが設定されているときは、設定にある名前だけを受け付ける
function checkAccount_(name, settings, required) {
  name = String(name || '').trim();
  if (!settings.accounts.length) return name;
  if (!name) {
    if (required) throw new Error('アカウントを選んでください');
    return '';
  }
  if (!settings.accounts.some(a => a.name === name)) throw new Error('設定にないアカウントです: ' + name);
  return name;
}

/* ===== 入口 ===== */

function doGet() {
  return json_({ ok: true, app: 'x-auto-post', message: 'POSTで呼び出してください' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!req.key || req.key !== cfg_('APP_KEY')) return json_({ ok: false, error: '認証キーが違います' });
    const fn = ACTIONS[req.action];
    if (!fn) return json_({ ok: false, error: '不明な操作です: ' + req.action });
    return json_({ ok: true, data: fn(req) });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

const ACTIONS = {
  ping: () => ({ pong: true, time: new Date().toISOString() }),
  getSettings: () => getSettings_(),
  saveSettings: req => saveSettings_(req.settings || {}),
  listSources: req => listSources_(req),
  listPosts: req => listPosts_(req),
  listQueue: () => listQueue_(),
  getPost: req => getPost_(req.id),
  createPost: req => createPost_(req),
  savePost: req => savePost_(req.id, req.fields || {}),
  setStatus: req => setStatus_(req.id, req.status),
  requestRegen: req => requestRegen_(req),
  saveGenerated: req => saveGenerated_(req),
  adopt: req => adopt_(req),
  deletePost: req => deletePost_(req.id),
  syncSources: () => syncSources_()
};

/* ===== 設定 ===== */

function getSettings_() {
  const rows = queryAll_(cfg_('SETTINGS_DB'), null, null, 100);
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  rows.forEach(r => {
    const k = text_(r.properties['キー']);
    if (SETTING_KEYS.indexOf(k) < 0) return;
    try { out[k] = JSON.parse(text_(r.properties['値'])); } catch (e) { /* 壊れた値は既定値のまま */ }
  });
  out.accounts = normalizeAccounts_(out.accounts);
  return out;
}

function saveSettings_(settings) {
  if ('accounts' in settings) {
    settings.accounts = normalizeAccounts_(settings.accounts);
    const names = settings.accounts.map(a => a.name);
    if (new Set(names).size !== names.length) throw new Error('同じアカウント名が重複しています');
  }
  const db = cfg_('SETTINGS_DB');
  const rows = queryAll_(db, null, null, 100);
  const byKey = {};
  rows.forEach(r => { byKey[text_(r.properties['キー'])] = r.id; });
  if ('accounts' in settings) {
    try { syncAccountOptions_(settings.accounts.map(a => a.name)); }
    catch (e) { console.warn('アカウントの選択肢を更新できませんでした: ' + e.message); }
  }
  SETTING_KEYS.forEach(k => {
    if (!(k in settings)) return;
    const props = { '値': { rich_text: rt_(JSON.stringify(settings[k])) } };
    if (byKey[k]) {
      notion_('patch', '/pages/' + byKey[k], { properties: props });
    } else {
      props['キー'] = { title: rt_(k) };
      notion_('post', '/pages', { parent: { database_id: db }, properties: props });
    }
  });
  return getSettings_();
}

/* ===== 元ネタ（ポスト①） ===== */

function listSources_(req) {
  const and = [];
  if (req.q) and.push({ property: 'タイトル', title: { contains: String(req.q) } });
  if (req.assigned) and.push({ property: 'アカウント', multi_select: { contains: String(req.assigned) } });
  const tags = (req.tags || (req.tag ? [req.tag] : [])).filter(Boolean);
  if (tags.length) {
    const or = tags.map(t => ({ property: 'タグ', multi_select: { contains: String(t) } }));
    and.push(or.length === 1 ? or[0] : { or: or });
  }
  const body = {
    page_size: Math.min(Number(req.limit) || 50, 100),
    sorts: [{ property: '取得日', direction: 'descending' }]
  };
  if (and.length) body.filter = and.length === 1 ? and[0] : { and: and };
  if (req.cursor) body.start_cursor = req.cursor;
  const res = notion_('post', '/databases/' + cfg_('SRC_DB') + '/query', body);
  return { items: res.results.map(mapSource_), next: res.has_more ? res.next_cursor : null };
}

function msNames_(p) {
  return ((p && p.multi_select) || []).map(o => o.name);
}

function mapSource_(p) {
  const pr = p.properties;
  return {
    id: p.id,
    url: p.url,
    title: text_(pr['タイトル']),
    author: text_(pr['投稿者']),
    postUrl: (pr['投稿URL'] && pr['投稿URL'].url) || '',
    excerpt: text_(pr['本文抜粋']),
    memo: text_(pr['メモ']),
    tags: ((pr['タグ'] && pr['タグ'].multi_select) || []).map(o => o.name),
    likes: pr['いいね数'] ? pr['いいね数'].number : null,
    rts: pr['RT数'] ? pr['RT数'].number : null,
    fetchedAt: pr['取得日'] && pr['取得日'].date ? pr['取得日'].date.start : '',
    generatedCount: pr['生成ポスト'] && pr['生成ポスト'].relation ? pr['生成ポスト'].relation.length : 0,
    accounts: msNames_(pr['アカウント']),
    imported: msNames_(pr['取り込み済み'])
  };
}

/* ===== 生成ポスト① ===== */

function listPosts_(req) {
  const or = [];
  (req.statuses || []).forEach(s => { if (STATUSES.indexOf(s) >= 0) or.push({ property: '状態', select: { equals: s } }); });
  let filter = or.length ? (or.length === 1 ? or[0] : { or: or }) : null;
  if (req.account) {
    const acc = { property: 'アカウント', select: { equals: String(req.account) } };
    filter = filter ? { and: [filter, acc] } : acc;
  }
  const rows = queryAll_(cfg_('GEN_DB'), filter, [{ timestamp: 'last_edited_time', direction: 'descending' }], 500);
  return rows.map(mapPost_);
}

// claude.ai 側の生成キュー：空・再生成の行と、元ネタの本文抜粋・メモ
function listQueue_() {
  const posts = listPosts_({ statuses: ['空', '再生成'] });
  const cache = {};
  posts.forEach(p => {
    const sid = p.sourceIds[0];
    if (!sid) return;
    if (!cache[sid]) cache[sid] = mapSource_(notion_('get', '/pages/' + sid));
    p.source = cache[sid];
  });
  return { posts: posts, settings: getSettings_() };
}

function getPost_(id) {
  need_(id, 'id');
  const post = mapPost_(notion_('get', '/pages/' + id));
  post.source = post.sourceIds[0] ? mapSource_(notion_('get', '/pages/' + post.sourceIds[0])) : null;
  return post;
}

function mapPost_(p) {
  const pr = p.properties;
  const slots = {};
  SLOTS.forEach(s => { slots[s] = text_(pr[s]); });
  return {
    id: p.id,
    url: p.url,
    title: text_(pr['タイトル']),
    status: sel_(pr['状態']) || '空',
    account: sel_(pr['アカウント']),
    sourceIds: ((pr['元ネタ'] && pr['元ネタ'].relation) || []).map(r => r.id),
    slots: slots,
    regen: { P1: text_(pr['再生成指示P1']), P2: text_(pr['再生成指示P2']), P3: text_(pr['再生成指示P3']) },
    regenTargets: ((pr['再生成対象'] && pr['再生成対象'].multi_select) || []).map(o => o.name),
    adoptedPattern: sel_(pr['採用パターン']),
    post1: text_(pr['1ポスト目']),
    post2: text_(pr['2ポスト目']),
    scheduledAt: pr['投稿予定日時'] && pr['投稿予定日時'].date ? pr['投稿予定日時'].date.start : '',
    method: sel_(pr['投稿方法']),
    sendData: text_(pr['送信データ']),
    created: p.created_time,
    updated: p.last_edited_time
  };
}

function createPost_(req) {
  need_(req.sourceId, 'sourceId');
  const account = checkAccount_(req.account, getSettings_(), true);
  if (account && !req.force) {
    const dup = queryAll_(cfg_('GEN_DB'), {
      and: [
        { property: '元ネタ', relation: { contains: req.sourceId } },
        { property: 'アカウント', select: { equals: account } }
      ]
    }, null, 10);
    if (dup.length) throw new Error('DUPLICATE:このネタは「' + account + '」にすでに' + dup.length + '件追加されています');
  }
  const src = mapSource_(notion_('get', '/pages/' + req.sourceId));
  const props = {
    'タイトル': { title: rt_(src.title || '(無題)') },
    '元ネタ': { relation: [{ id: src.id }] },
    '状態': { select: { name: '空' } }
  };
  if (account) props['アカウント'] = { select: { name: account } };
  const created = mapPost_(notion_('post', '/pages', { parent: { database_id: cfg_('GEN_DB') }, properties: props }));
  if (account) markImported_(src, [account]);
  return created;
}

// 抽出ポスト①の「取り込み済み」にアカウントを足す（自動取り込みで二重に作らないため）
function markImported_(src, names) {
  const merged = src.imported.slice();
  names.forEach(n => { if (merged.indexOf(n) < 0) merged.push(n); });
  if (merged.length === src.imported.length) return;
  notion_('patch', '/pages/' + src.id, { properties: { '取り込み済み': { multi_select: merged.map(n => ({ name: n })) } } });
  src.imported = merged;
}

// 抽出ポスト①の「アカウント」にあって「取り込み済み」にないアカウントの分だけ、
// 生成ポスト①に「空」の行を作る。生成ポスト①の行を削除しても作り直さない
// （作り直したいときは抽出ポスト①の「取り込み済み」からそのアカウントを外す）
function syncSources_() {
  const settings = getSettings_();
  const known = settings.accounts.map(a => a.name);
  const rows = queryAll_(cfg_('SRC_DB'), { property: 'アカウント', multi_select: { is_not_empty: true } },
    [{ property: '取得日', direction: 'descending' }], 1000);
  const result = { created: 0, unknownAccounts: [], remaining: 0 };
  const started = Date.now();
  for (const row of rows) {
    const src = mapSource_(row);
    const todo = src.accounts.filter(a => src.imported.indexOf(a) < 0);
    if (!todo.length) continue;
    if (Date.now() - started > 4 * 60 * 1000) { result.remaining++; continue; } // GASの実行時間制限に余裕を残す
    const done = [];
    todo.forEach(account => {
      if (known.length && known.indexOf(account) < 0) {
        if (result.unknownAccounts.indexOf(account) < 0) result.unknownAccounts.push(account);
        return;
      }
      const dup = queryAll_(cfg_('GEN_DB'), {
        and: [
          { property: '元ネタ', relation: { contains: src.id } },
          { property: 'アカウント', select: { equals: account } }
        ]
      }, null, 1);
      if (!dup.length) {
        notion_('post', '/pages', {
          parent: { database_id: cfg_('GEN_DB') },
          properties: {
            'タイトル': { title: rt_(src.title || '(無題)') },
            '元ネタ': { relation: [{ id: src.id }] },
            '状態': { select: { name: '空' } },
            'アカウント': { select: { name: account } }
          }
        });
        result.created++;
      }
      done.push(account);
    });
    if (done.length) markImported_(src, done);
  }
  return result;
}

// 時間主導トリガーから呼ぶ
function syncSourcesTrigger() {
  const r = syncSources_();
  console.log('自動取り込み: ' + r.created + '件作成' +
    (r.unknownAccounts.length ? '／設定にないアカウント: ' + r.unknownAccounts.join(', ') : '') +
    (r.remaining ? '／残り' + r.remaining + '件は次回' : ''));
}

// エディタから一度実行すると、15分ごとの自動取り込みを設定する
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncSourcesTrigger')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncSourcesTrigger').timeBased().everyMinutes(15).create();
  console.log('15分ごとの自動取り込みを設定しました');
}

// 設定のアカウント名を、Notion側の「アカウント」の選択肢にも追加する
function syncAccountOptions_(names) {
  if (!names.length) return;
  const targets = [
    { db: cfg_('SRC_DB'), props: ['アカウント', '取り込み済み'], type: 'multi_select' },
    { db: cfg_('GEN_DB'), props: ['アカウント'], type: 'select' }
  ];
  targets.forEach(t => {
    const meta = notion_('get', '/databases/' + t.db);
    const update = {};
    t.props.forEach(pn => {
      const p = meta.properties[pn];
      if (!p || p.type !== t.type) return;
      const existing = (p[t.type].options || []).map(o => ({ id: o.id, name: o.name, color: o.color }));
      const have = existing.map(o => o.name);
      const add = names.filter(n => have.indexOf(n) < 0).map(n => ({ name: n }));
      if (add.length) update[pn] = { [t.type]: { options: existing.concat(add) } };
    });
    if (Object.keys(update).length) notion_('patch', '/databases/' + t.db, { properties: update });
  });
}

// 本文や投稿条件の保存（状態は変えない）
function savePost_(id, f) {
  need_(id, 'id');
  const props = {};
  if ('title' in f) props['タイトル'] = { title: rt_(f.title) };
  if ('account' in f) props['アカウント'] = selectVal_(checkAccount_(f.account, getSettings_(), false));
  if ('post1' in f) props['1ポスト目'] = { rich_text: rt_(f.post1) };
  if ('post2' in f) props['2ポスト目'] = { rich_text: rt_(f.post2) };
  if ('adoptedPattern' in f) {
    if (f.adoptedPattern && PATTERNS.indexOf(String(f.adoptedPattern)) < 0) throw new Error('採用パターンは1〜3で指定してください');
    props['採用パターン'] = selectVal_(f.adoptedPattern ? String(f.adoptedPattern) : '');
  }
  if ('scheduledAt' in f) props['投稿予定日時'] = { date: f.scheduledAt ? { start: f.scheduledAt } : null };
  if ('method' in f) props['投稿方法'] = selectVal_(f.method);
  if (!Object.keys(props).length) throw new Error('保存する項目がありません');
  return mapPost_(notion_('patch', '/pages/' + id, { properties: props }));
}

function setStatus_(id, status) {
  need_(id, 'id');
  const cur = mapPost_(notion_('get', '/pages/' + id));
  const allowed = TRANSITIONS[cur.status] || [];
  if (allowed.indexOf(status) < 0) throw new Error('「' + cur.status + '」から「' + status + '」には変更できません');
  const props = { '状態': { select: { name: status } } };
  if (cur.status === '再生成') props['再生成対象'] = { multi_select: [] }; // 依頼の取り消し
  return mapPost_(notion_('patch', '/pages/' + id, { properties: props }));
}

function requestRegen_(req) {
  need_(req.id, 'id');
  const cur = mapPost_(notion_('get', '/pages/' + req.id));
  if (['生成済', '候補', '再生成'].indexOf(cur.status) < 0) throw new Error('「' + cur.status + '」の投稿は再生成を依頼できません');
  const targets = (req.targets || []).filter(t => SLOTS.indexOf(t) >= 0);
  if (!targets.length) throw new Error('再生成するポストを1つ以上選んでください');
  const ins = req.instructions || {};
  const props = {
    '状態': { select: { name: '再生成' } },
    '再生成対象': { multi_select: targets.map(t => ({ name: t })) },
    '再生成指示P1': { rich_text: rt_(ins.P1) },
    '再生成指示P2': { rich_text: rt_(ins.P2) },
    '再生成指示P3': { rich_text: rt_(ins.P3) }
  };
  return mapPost_(notion_('patch', '/pages/' + req.id, { properties: props }));
}

// 生成結果の書き込み（claude.ai 側から使う場合）
function saveGenerated_(req) {
  need_(req.id, 'id');
  const cur = mapPost_(notion_('get', '/pages/' + req.id));
  if (['空', '再生成'].indexOf(cur.status) < 0) throw new Error('「' + cur.status + '」の投稿には生成結果を書き込めません');
  const slots = req.slots || {};
  const props = { '状態': { select: { name: '生成済' } }, '再生成対象': { multi_select: [] } };
  SLOTS.forEach(s => { if (s in slots) props[s] = { rich_text: rt_(slots[s]) }; });
  return mapPost_(notion_('patch', '/pages/' + req.id, { properties: props }));
}

function adopt_(req) {
  need_(req.id, 'id');
  const cur = mapPost_(notion_('get', '/pages/' + req.id));
  if (['生成済', '候補'].indexOf(cur.status) < 0) throw new Error('「' + cur.status + '」の投稿は採用できません');
  const pattern = String(req.pattern || '');
  if (PATTERNS.indexOf(pattern) < 0) throw new Error('採用するパターンを選んでください');
  const post1 = String(req.post1 || '').trim();
  const post2 = String(req.post2 || '').trim();
  if (!post1 || !post2) throw new Error('1ポスト目と2ポスト目の両方を入力してください');
  const settings = getSettings_();
  const account = checkAccount_(req.account || cur.account, settings, true);
  const limit = (settings.ranges.limit || 140) * 2;
  [[post1, '1ポスト目'], [post2, '2ポスト目']].forEach(([t, name]) => {
    const n = xLength_(t);
    if (n > limit) throw new Error(name + 'が上限を超えています（全角換算 ' + Math.ceil(n / 2) + '字）');
  });
  const method = req.method === '手動' ? '手動' : '自動';
  const send = {
    id: cur.id,
    account: account,
    pattern: Number(pattern),
    method: method === '自動' ? 'api' : 'manual',
    scheduled_at: req.scheduledAt || null,
    thread: [
      { order: 1, text: post1 },
      { order: 2, text: post2, reply_to: 1 }
    ],
    created_at: new Date().toISOString()
  };
  const props = {
    '状態': { select: { name: '採用' } },
    '採用パターン': { select: { name: pattern } },
    '1ポスト目': { rich_text: rt_(post1) },
    '2ポスト目': { rich_text: rt_(post2) },
    '投稿方法': { select: { name: method } },
    '投稿予定日時': { date: req.scheduledAt ? { start: req.scheduledAt } : null },
    '送信データ': { rich_text: rt_(JSON.stringify(send, null, 2)) }
  };
  if (account) props['アカウント'] = { select: { name: account } };
  return mapPost_(notion_('patch', '/pages/' + req.id, { properties: props }));
}

function deletePost_(id) {
  need_(id, 'id');
  notion_('patch', '/pages/' + id, { archived: true });
  return { deleted: id };
}

/* ===== 共通 ===== */

// X の文字数カウント（全角=2、半角=1、URL=23）
function xLength_(s) {
  s = String(s || '');
  const urlRe = /https?:\/\/\S+/g;
  let n = (s.match(urlRe) || []).length * 23;
  s = s.replace(urlRe, '');
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const light = c <= 0x10FF || (c >= 0x2000 && c <= 0x200D) || (c >= 0x2010 && c <= 0x201F) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

function queryAll_(dbId, filter, sorts, max) {
  const out = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    const res = notion_('post', '/databases/' + dbId + '/query', body);
    out.push.apply(out, res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && out.length < (max || 500));
  return out;
}

function notion_(method, path, payload) {
  const opt = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + cfg_('NOTION_TOKEN'), 'Notion-Version': NOTION_VERSION }
  };
  if (payload) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(payload);
  }
  const res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();
  const body = text ? JSON.parse(text) : {};
  if (code >= 300) throw new Error('Notion API ' + code + ': ' + (body.message || text));
  return body;
}

function text_(p) {
  if (!p) return '';
  const arr = p.rich_text || p.title || [];
  return arr.map(t => t.plain_text).join('');
}

function sel_(p) {
  return p && p.select ? p.select.name : '';
}

function selectVal_(v) {
  return v ? { select: { name: String(v) } } : { select: null };
}

// Notion のテキストは1要素2000字までなので分割する
function rt_(s) {
  const chars = Array.from(String(s == null ? '' : s));
  const out = [];
  for (let i = 0; i < chars.length; i += 1800) {
    out.push({ type: 'text', text: { content: chars.slice(i, i + 1800).join('') } });
  }
  return out;
}

function need_(v, name) {
  if (!v) throw new Error(name + ' を指定してください');
}

function cfg_(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('スクリプトプロパティ ' + k + ' が設定されていません');
  return v;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ===== 動作確認（エディタから実行） ===== */

function checkSetup() {
  ['NOTION_TOKEN', 'APP_KEY', 'SRC_DB', 'GEN_DB', 'SETTINGS_DB'].forEach(cfg_);
  console.log('抽出ポスト①:', listSources_({ limit: 3 }).items.map(s => s.title + ' ' + s.accounts.join(',')));
  console.log('生成ポスト①:', listPosts_({}).length + '件');
  console.log('設定キー:', Object.keys(getSettings_()));
}
