/**
 * 動画ナレッジ用 GAS プロキシ
 *
 * 役割:
 *  - Notion API はブラウザから直接叩けない(CORSヘッダーが無い)ため、
 *    このスクリプトが仲介する。
 *  - フロントは text/plain で JSON を POST する(プリフライトを発生させないため)。
 *    Content-Type を application/json にすると OPTIONS preflight が飛び、
 *    GAS は OPTIONS に応答できないため必ず失敗する。
 *  - 議事録アプリ(minutes)の Code.gs と同じ思想。別デプロイにしても、
 *    1つの GAS に両方の action を入れて共用しても動く。
 *
 * 事前設定 (スクリプトプロパティ):
 *  - NOTION_TOKEN     Notion Integration のシークレット(動画DB側)
 *  - WEB_NOTION_TOKEN web記事DBを別の統合に接続しているときのシークレット
 *                     (未設定なら NOTION_TOKEN を使う)
 *  - ACCESS_TOKEN     フロントの videos:config.accessToken と一致させる共有トークン
 *  - code             権限コードと権限の対応 JSON 例: {"dfkjnga":"xYz","abc":"team"}
 *  - VIDEO_DB_ID      動画DBのID(省略時は下の DEFAULT_DB_ID を使う)
 *  - WEB_DB_ID        web記事DBのID(省略時は DEFAULT_WEB_DB_ID。空文字にするとwebを読まない)
 *  - STATUS_COUNTS    状態ごとの件数の集計(自動で書かれる。手で入れる必要はない)
 *                     初回に setupStatusCountsTrigger() を一度実行して定期更新を張ること
 *
 * デプロイ:
 *  - 種類: ウェブアプリ / 実行するユーザー: 自分 / アクセス: 全員
 *    (URLを知っていれば誰でも叩けるため ACCESS_TOKEN のチェックを必ず通す)
 */

var NOTION_VERSION = '2022-06-28';
var DEFAULT_DB_ID = '3630e7a535dc8154ac62d41f7611540f';
var DEFAULT_WEB_DB_ID = '4130e7a535dc83509c9a01cd6ac0a6a7';

// ---- プロパティ名(Notion側のカラム名とここを一致させること) ----
var PROP_TITLE    = '動画タイトル';   // title
var PROP_WEB_TITLE = 'タイトル';       // title  web記事DB側の名前。他のカラム名は動画DBと共通
var PROP_URL      = 'URL';            // url  ※MCPでは userDefined:URL と表示されるが REST では "URL"
var PROP_THUMB    = 'サムネイル';     // url
var PROP_TAGS     = 'タグ';           // multi_select
var PROP_STATUS   = '状態';           // select
var PROP_SUMMARY  = '要約';           // rich_text  カード用サマリ
var PROP_MINDMAP  = 'マインドマップ'; // rich_text  markmap用マークダウン
var PROP_FIELDS   = '分野別要約';     // rich_text  セクション形式(要追加)
var PROP_APPLY    = '応用';           // rich_text  セクション形式(要追加)
var PROP_IDEAS    = '活用アイデア';   // rich_text  セクション形式(要追加)
var PROP_MEMO     = 'メモ';           // rich_text  (要追加)
var PROP_MODEL    = '要約モデル';     // rich_text  (要追加)
var PROP_GENERATED = '要約日時';      // date       (要追加)
var PROP_RAW_COUNT = '原文文字数';    // number     (要追加)
var PROP_PUBLIC   = '公開';           // checkbox   マインドマップ一覧に並べるか (要追加)
var PROP_CATEGORY = '分類';           // select     空ならまとめて1つ、入っていれば一覧JSONを分ける
var PROP_CREATED  = '作成日時';       // created_time

// ---- 状態の値 ----
var STATUS_NEW        = '新規';     // 未処理。Mac mini 側バッチが拾う
var STATUS_RETRY      = '再取得';   // 既存の文字起こしを置き換える対象
var STATUS_RUNNING    = '処理中';
var STATUS_DONE       = '完了';     // 文字起こし済み・要約待ち
var STATUS_SUMMARIZED = '要約済み'; // AI生成完了
var STATUS_EXCLUDED   = '除外';     // 論理削除。Notionページ自体は残す

var ADMIN_ROLE = 'xYz';

// ============ エントリーポイント ============

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);

    // コード検証だけは共有トークン不要で受ける(初回はまだトークンが手元に無い)
    if (body.action === 'verifyCode') {
      return jsonOutput_({ ok: true, data: verifyCode_(body.code) });
    }

    assertToken_(body);

    switch (body.action) {
      case 'listVideos':
        result = listVideos_();
        break;
      case 'listIdeas':
        result = listIdeas_();
        break;
      case 'fetchTranscript':
        result = fetchTranscript_(body.pageId, body.source);
        break;
      case 'fetchDetail':
        result = fetchDetail_(body.pageId, body.source);
        break;
      case 'saveGenerated':
        result = saveGenerated_(body.pageId, body.detail, body.model, body.rawCount, body.source);
        break;
      case 'saveField':
        result = saveField_(body.pageId, body.field, body.value, body.source);
        break;
      case 'saveMemo':
        result = saveMemo_(body.pageId, body.memo, body.source);
        break;
      case 'saveTags':
        result = saveTags_(body.pageId, body.tags, body.source);
        break;
      case 'mergeTag':
        result = mergeTag_(body.from, body.to);
        break;
      case 'saveTitle':
        result = saveTitle_(body.pageId, body.title, body.source);
        break;
      case 'saveCategory':
        result = saveCategory_(body.pageId, body.category, body.source);
        break;
      case 'setStatus':
        result = setStatus_(body.pageId, body.status, body.source);
        break;
      case 'updateRawCount':
        result = updateRawCount_(body.pageId, body.count, body.source);
        break;
      case 'setPublic':
        result = setPublic_(body.pageId, body.isPublic, body.source);
        break;
      case 'deleteVideo':
        result = deleteVideo_(body.pageId, body.source);
        break;
      case 'requestRebuild':
        result = requestRebuild_(body.reason);
        break;
      case 'takeRebuildRequest':
        result = takeRebuildRequest_();
        break;
      case 'statusCounts':
        result = statusCounts_(body.refresh);
        break;
      default:
        throw new Error('unknown action: ' + body.action);
    }
    return jsonOutput_({ ok: true, data: result });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String((err && err.message) || err) });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function assertToken_(body) {
  var expected = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN');
  if (!expected || body.token !== expected) {
    throw new Error('unauthorized');
  }
}

function dbId_() {
  return PropertiesService.getScriptProperties().getProperty('VIDEO_DB_ID') || DEFAULT_DB_ID;
}

/** web記事DBのID。プロパティを空文字にしておけばwebを読まない運用にできる */
function webDbId_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('WEB_DB_ID');
  return raw === null ? DEFAULT_WEB_DB_ID : String(raw).trim();
}

/**
 * 取り込み元に対応する Notion のシークレット。
 * web記事DBは別の統合に接続していることがあるため、動画DBとトークンを分けられる。
 */
function notionToken_(source) {
  var props = PropertiesService.getScriptProperties();
  var base = props.getProperty('NOTION_TOKEN') || '';
  if (source !== 'web') return base;
  return props.getProperty('WEB_NOTION_TOKEN') || base;
}

/** 動画用とweb用で別々のトークンを持っているか */
function hasSeparateWebToken_() {
  return notionToken_('web') !== notionToken_('video');
}

// ============ Notion 共通ヘルパー ============

function notionFetch_(path, method, payload, source) {
  var options = {
    method: method || 'get',
    headers: {
      Authorization: 'Bearer ' + notionToken_(source),
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    muteHttpExceptions: true,
  };
  if (payload) options.payload = JSON.stringify(payload);

  var res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, options);
  var code = res.getResponseCode();
  var json = JSON.parse(res.getContentText());
  if (code >= 300) {
    var err = new Error('Notion API ' + code + ': ' + (json.message || res.getContentText()));
    err.statusCode = code;
    throw err;
  }
  return json;
}

/**
 * ページ単位の読み書き。
 * 一覧JSONが古いなどで取り込み元が分からないことがあるので、
 * 404(その統合に共有されていない)なら、もう片方のトークンで1度だけやり直す。
 */
function notionPageFetch_(path, method, payload, source) {
  try {
    return notionFetch_(path, method, payload, source);
  } catch (err) {
    if (err.statusCode !== 404 || !hasSeparateWebToken_()) throw err;
    return notionFetch_(path, method, payload, source === 'web' ? 'video' : 'web');
  }
}

function plainTextOf_(richTextArray) {
  return (richTextArray || []).map(function (t) { return t.plain_text; }).join('');
}

function richTextOf_(properties, name) {
  var prop = properties[name];
  return prop && prop.rich_text ? plainTextOf_(prop.rich_text) : '';
}

function numberOf_(properties, name) {
  var prop = properties[name];
  return prop && typeof prop.number === 'number' ? prop.number : 0;
}

function urlOf_(properties, name) {
  var prop = properties[name];
  return (prop && prop.url) || '';
}

function selectOf_(properties, name) {
  var prop = properties[name];
  return (prop && prop.select && prop.select.name) || '';
}

function multiSelectOf_(properties, name) {
  var prop = properties[name];
  if (!prop || !prop.multi_select) return [];
  return prop.multi_select.map(function (o) { return o.name; });
}

function checkboxOf_(properties, name) {
  var prop = properties[name];
  return Boolean(prop && prop.checkbox);
}

function titleOf_(properties, name) {
  var prop = properties[name];
  return prop && prop.title ? plainTextOf_(prop.title) : '';
}

/** title 型のプロパティ名を探す。DBごとに名前が違う(動画タイトル / タイトル)ため */
function titlePropName_(properties) {
  for (var key in properties) {
    if (properties[key] && properties[key].type === 'title') return key;
  }
  return PROP_TITLE;
}

function titleAnyOf_(properties) {
  return titleOf_(properties, titlePropName_(properties));
}

function dateOf_(properties, name) {
  var prop = properties[name];
  return (prop && prop.date && prop.date.start) || null;
}

/**
 * rich_text プロパティのペイロードを作る。
 * 1オブジェクトあたり2000字が Notion の上限なので、超える分は
 * 複数オブジェクトに分割して詰める(配列は最大100要素 = 実質20万字)。
 * これにより「2000字で切り捨て」を回避している。
 */
function richTextProp_(text) {
  var s = String(text == null ? '' : text);
  if (!s) return { rich_text: [] };
  var chunks = [];
  for (var i = 0; i < s.length && chunks.length < 100; i += 2000) {
    chunks.push({ text: { content: s.slice(i, i + 2000) } });
  }
  return { rich_text: chunks };
}

/** ページ本文のブロックを全件取得する(ページネーション対応) */
function fetchAllBlocks_(blockId, source) {
  var blocks = [];
  var cursor = null;
  do {
    var path = 'blocks/' + blockId + '/children?page_size=100';
    if (cursor) path += '&start_cursor=' + cursor;
    var res = notionPageFetch_(path, 'get', null, source);
    blocks = blocks.concat(res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return blocks;
}

// ============ アクション実装 ============

/**
 * 一覧を返す。カード表示と検索に必要な項目だけを返し、
 * 長文(分野別要約・応用・活用アイデア・マインドマップ)は
 * 有無のフラグだけにしてペイロードを軽く保つ。
 */
function listVideos_() {
  var items = [];
  eachSourcePage_(function (page, source) {
    var item = toListItem_(page, source);
    if (item) items.push(item);
  });
  return { items: sortByCreatedDesc_(items), fetchedAt: new Date().toISOString() };
}

/**
 * 動画DBとweb記事DBを順に走査する。
 * webDBはあとから足したもので、共有し忘れなどで落ちても動画側は出したいので、
 * webの取得に失敗しても握りつぶす(一覧が空になるより古い動画一覧のほうがまし)。
 */
function eachSourcePage_(fn) {
  queryDbAll_(dbId_(), [{ property: PROP_CREATED, direction: 'descending' }], 'video').forEach(function (page) {
    fn(page, 'video');
  });

  var webId = webDbId_();
  if (!webId) return;
  try {
    // web側は作成日時カラムの有無に依存させたくないので、ページの作成時刻で並べる
    queryDbAll_(webId, [{ timestamp: 'created_time', direction: 'descending' }], 'web').forEach(function (page) {
      fn(page, 'web');
    });
  } catch (err) {
    // 一覧は動画だけで返す
  }
}

/** DBの全ページを取得する(ページネーション対応) */
function queryDbAll_(databaseId, sorts, source) {
  var pages = [];
  var cursor = null;
  do {
    var payload = { page_size: 100, sorts: sorts };
    if (cursor) payload.start_cursor = cursor;
    var res = notionFetch_('databases/' + databaseId + '/query', 'post', payload, source);
    pages = pages.concat(res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return pages;
}

function sortByCreatedDesc_(items) {
  return items.sort(function (a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/** 一覧の1件。状態が空欄でもvideoと同様に「新規」として取り込む */
function toListItem_(page, source) {
  var p = page.properties;
  var status = selectOf_(p, PROP_STATUS);

  return {
    key: page.id,
    source: source,
    title: titleAnyOf_(p) || '(タイトル未取得)',
    category: selectOf_(p, PROP_CATEGORY),
    url: urlOf_(p, PROP_URL),
    thumb: urlOf_(p, PROP_THUMB),
    status: status || STATUS_NEW,
    tags: multiSelectOf_(p, PROP_TAGS),
    createdAt: (p[PROP_CREATED] && p[PROP_CREATED].created_time) || page.created_time,
    editedAt: page.last_edited_time,
    summary: richTextOf_(p, PROP_SUMMARY),
    model: richTextOf_(p, PROP_MODEL) || null,
    generatedAt: dateOf_(p, PROP_GENERATED),
    rawCouAnt: numberOf_(p, PROP_RAW_COUNT),
    isPublic: checkboxOf_(p, PROP_PUBLIC),
    has: {
      mindmap: Boolean(richTextOf_(p, PROP_MINDMAP)),
      fields: Boolean(richTextOf_(p, PROP_FIELDS)),
      apply: Boolean(richTextOf_(p, PROP_APPLY)),
      ideas: Boolean(richTextOf_(p, PROP_IDEAS)),
      memo: Boolean(richTextOf_(p, PROP_MEMO)),
    },
  };
}

/**
 * 応用・活用アイデアだけを全件返す。「アイデア一覧」画面が使う。
 * 一覧(listVideos)に混ぜると毎回のペイロードが重くなるため別アクションにしている。
 */
function listIdeas_() {
  var items = [];
  eachSourcePage_(function (page, source) {
    var p = page.properties;
    var apply = richTextOf_(p, PROP_APPLY);
    var ideas = richTextOf_(p, PROP_IDEAS);
    if (!apply && !ideas) return;
    var status = selectOf_(p, PROP_STATUS);
    items.push({
      key: page.id,
      source: source,
      title: titleAnyOf_(p),
      url: urlOf_(p, PROP_URL),
      thumb: urlOf_(p, PROP_THUMB),
      tags: multiSelectOf_(p, PROP_TAGS),
      status: status || STATUS_NEW,
      apply: apply,
      ideas: ideas,
    });
  });

  return { items: items };
}

/**
 * 文字起こし全文を取得する。ページ本文のテキスト系ブロックを上から連結する。
 */
function fetchTranscript_(pageId, source) {
  var page = notionPageFetch_('pages/' + pageId, 'get', null, source);
  var blocks = fetchAllBlocks_(pageId, source);

  var lines = [];
  blocks.forEach(function (b) {
    var rt = b[b.type] && b[b.type].rich_text;
    if (rt) {
      var text = plainTextOf_(rt);
      if (text) lines.push(text);
    }
  });

  return { text: lines.join('\n'), updatedAt: page.last_edited_time };
}

/** AI生成物とメモをまとめて取得する(詳細を開いたときの1リクエスト) */
function fetchDetail_(pageId, source) {
  var page = notionPageFetch_('pages/' + pageId, 'get', null, source);
  var p = page.properties;
  return {
    title: titleAnyOf_(p),
    url: urlOf_(p, PROP_URL),
    thumb: urlOf_(p, PROP_THUMB),
    status: selectOf_(p, PROP_STATUS),
    tags: multiSelectOf_(p, PROP_TAGS),
    summary: richTextOf_(p, PROP_SUMMARY),
    mindmap: richTextOf_(p, PROP_MINDMAP),
    fields: richTextOf_(p, PROP_FIELDS),
    apply: richTextOf_(p, PROP_APPLY),
    ideas: richTextOf_(p, PROP_IDEAS),
    memo: richTextOf_(p, PROP_MEMO),
    model: richTextOf_(p, PROP_MODEL) || null,
    generatedAt: dateOf_(p, PROP_GENERATED),
    rawCount: numberOf_(p, PROP_RAW_COUNT),
    isPublic: checkboxOf_(p, PROP_PUBLIC),
    updatedAt: page.last_edited_time,
  };
}

/** フロントのフィールド名 -> Notionプロパティ名 */
var FIELD_MAP = {
  summary: PROP_SUMMARY,
  mindmap: PROP_MINDMAP,
  fields: PROP_FIELDS,
  apply: PROP_APPLY,
  ideas: PROP_IDEAS,
};

/**
 * AI生成物を書き戻す。detail に含まれるフィールドだけを更新するので、
 * 「分野別だけ作り直す」のような部分生成にも同じ入口で対応できる。
 * 要約日時・モデル・状態も同時に更新する。
 */
function saveGenerated_(pageId, detail, model, rawCount, source) {
  detail = detail || {};
  var props = {};
  Object.keys(FIELD_MAP).forEach(function (k) {
    if (typeof detail[k] === 'string') props[FIELD_MAP[k]] = richTextProp_(detail[k]);
  });
  if (Array.isArray(detail.tags)) {
    props[PROP_TAGS] = {
      multi_select: detail.tags.filter(Boolean).map(function (n) { return { name: String(n).slice(0, 100) }; }),
    };
  }
  if (model) props[PROP_MODEL] = richTextProp_(model);
  props[PROP_GENERATED] = { date: { start: new Date().toISOString() } };
  props[PROP_STATUS] = { select: { name: STATUS_SUMMARIZED } };
  if (typeof rawCount === 'number' && rawCount > 0) props[PROP_RAW_COUNT] = { number: rawCount };

  patchSynced_(pageId, { properties: props }, source);
  return { saved: true };
}

/**
 * 人手による1フィールドの編集を保存する。
 * saveGenerated_ と違い、要約日時・モデル・状態は変更しない
 * (AIが生成した時刻とモデルの記録を手編集で上書きしないため)。
 */
function saveField_(pageId, field, value, source) {
  var prop = FIELD_MAP[field];
  if (!prop) throw new Error('unknown field: ' + field);
  var props = {};
  props[prop] = richTextProp_(value);
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true };
}

function saveMemo_(pageId, memo, source) {
  var props = {};
  props[PROP_MEMO] = richTextProp_(memo);
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true };
}

function saveTags_(pageId, tags, source) {
  var names = (Array.isArray(tags) ? tags : []).filter(Boolean);
  var props = {};
  props[PROP_TAGS] = {
    multi_select: names.map(function (name) { return { name: String(name).slice(0, 100) }; }),
  };
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true, tags: names };
}

/**
 * タグを統合する。from が付いている全ページを from -> to に書き換える。
 * 現在のタグはサーバ側で読み直すので、フロントの一覧が古くても壊れない。
 *
 * 書き換えたページはフィルタ(from を含む)から外れるため、カーソルで先へ進めるのではなく
 * 「0件になるまで先頭から取り直す」形にしている。カーソルを使うと、削られて詰まった分を
 * 読み飛ばしてしまう。
 */
function mergeTag_(from, to) {
  var fromName = String(from || '').trim();
  var toName = String(to || '').trim();
  if (!fromName || !toName) throw new Error('from と to は必須です');
  if (fromName === toName) throw new Error('from と to が同じです');

  var updated = 0;
  var errors = [];
  var targets = [{ id: dbId_(), source: 'video' }];
  var webId = webDbId_();
  if (webId) targets.push({ id: webId, source: 'web' });

  targets.forEach(function (target) {
    var databaseId = target.id;
    // 6分の実行上限に収めるための保険。10巡(最大1000件)で打ち切る
    for (var round = 0; round < 10; round++) {
      var res;
      try {
        res = notionFetch_('databases/' + databaseId + '/query', 'post', {
          page_size: 100,
          filter: { property: PROP_TAGS, multi_select: { contains: fromName } },
        }, target.source);
      } catch (err) {
        errors.push(databaseId + ': ' + ((err && err.message) || err));
        break;
      }
      if (!res.results.length) break;

      var before = updated;
      res.results.forEach(function (page) {
        try {
          var current = multiSelectOf_(page.properties, PROP_TAGS);
          var next = [];
          current.forEach(function (t) {
            var name = t === fromName ? toName : t;
            if (next.indexOf(name) === -1) next.push(name);
          });
          var props = {};
          props[PROP_TAGS] = {
            multi_select: next.map(function (name) { return { name: name }; }),
          };
          notionFetch_('pages/' + page.id, 'patch', { properties: props }, target.source);
          updated++;
        } catch (err) {
          errors.push(page.id + ': ' + ((err && err.message) || err));
        }
      });

      // 1件も進まなかったら、同じページで失敗し続けている。無限ループを避けて抜ける
      if (updated === before) break;
    }
  });

  return { updated: updated, failed: errors.length, errors: errors, from: fromName, to: toName };
}

function saveTitle_(pageId, title, source) {
  // タイトル欄の名前はDBによって違うので、ページから引く
  var page = notionPageFetch_('pages/' + pageId, 'get', null, source);
  var props = {};
  props[titlePropName_(page.properties)] = { title: [{ text: { content: String(title || '').slice(0, 2000) } }] };
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true, title: title };
}

/**
 * 分類を保存する。空文字なら外す。
 * 一覧JSONの分かれ方が変わるが、反映は次のcronでJSONを作り直してからになる。
 * Notionのselectは未登録の選択肢名でもAPI側で自動追加される。
 */
function saveCategory_(pageId, category, source) {
  var name = String(category || '').trim();
  var props = {};
  props[PROP_CATEGORY] = { select: name ? { name: name.slice(0, 100) } : null };
  patchSynced_(pageId, { properties: props }, source);
  return { saved: true, category: name };
}

/**
 * 状態を変更する。
 *  - 「再取得」に戻す = 次回バッチで文字起こしをやり直させる
 *  - 「除外」= 一覧から外す論理削除(Notionページ自体は消さない)
 * Notionのselectは未登録の選択肢名でもAPI側で自動追加されるため、
 * 事前にオプションを作っておく必要はない。
 */
function setStatus_(pageId, status, source) {
  var allowed = [STATUS_NEW, STATUS_RETRY, STATUS_RUNNING, STATUS_DONE, STATUS_SUMMARIZED, STATUS_EXCLUDED];
  if (allowed.indexOf(status) === -1) throw new Error('unknown status: ' + status);
  var props = {};
  props[PROP_STATUS] = { select: { name: status } };
  patchSynced_(pageId, { properties: props }, source);
  return { saved: true, status: status };
}

function updateRawCount_(pageId, count, source) {
  var props = {};
  props[PROP_RAW_COUNT] = { number: Number(count) || 0 };
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true };
}

/** マインドマップ一覧に出すかどうか。列が無いDBでは Notion が 400 を返す */
function setPublic_(pageId, isPublic, source) {
  var props = {};
  props[PROP_PUBLIC] = { checkbox: Boolean(isPublic) };
  notionPageFetch_('pages/' + pageId, 'patch', { properties: props }, source);
  return { saved: true, isPublic: Boolean(isPublic) };
}

/**
 * ページを削除する。Notion API に完全削除は無いのでアーカイブ(ゴミ箱)になる。
 * 一覧のクエリには出てこなくなり、Notion側では30日間復元できる。
 * 「除外」(setStatus)はページを残す論理削除なので、用途が違う。
 */
function deleteVideo_(pageId, source) {
  if (!pageId) throw new Error('pageId は必須です');
  patchSynced_(pageId, { archived: true }, source);
  return { deleted: true, pageId: pageId };
}

/**
 * スクリプトプロパティ "code" からコードと権限の対応を引く。
 * JSON形式: {"コード": "権限", ...}  該当が無ければ 'err'。
 */
function verifyCode_(code) {
  var raw = PropertiesService.getScriptProperties().getProperty('code') || '';
  var input = String(code || '').trim();
  if (!input) return { role: 'err' };

  var map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    return { role: 'err' };
  }

  var role = map[input];
  if (!role) return { role: 'err' };
  return { role: role, isAdmin: role === ADMIN_ROLE };
}

// ============ 一覧JSONの作り直し依頼 ============

/**
 * 一覧JSON(index-*.json / idea-*.json)は Mac 側の Python が作る。
 * ブラウザから Mac は叩けないので、ここに「作り直してほしい」という印を置き、
 * Mac 側の常騐スクリプトが takeRebuildRequest で拾って実行する。
 */
var REBUILD_PROP = 'REBUILD_REQUEST';

function requestRebuild_(reason) {
  var props = PropertiesService.getScriptProperties();
  var current = parseRebuild_(props.getProperty(REBUILD_PROP));
  var reasons = current.reasons || [];
  var label = String(reason || 'unknown');
  if (reasons.indexOf(label) === -1) reasons.push(label);
  props.setProperty(REBUILD_PROP, JSON.stringify({
    requestedAt: new Date().toISOString(),
    reasons: reasons.slice(0, 20),
  }));
  return { requested: true };
}

/** Mac 側が呼ぶ。印を返して消す（取りこぼしは次回の定期実行で拾う） */
function takeRebuildRequest_() {
  var props = PropertiesService.getScriptProperties();
  var current = parseRebuild_(props.getProperty(REBUILD_PROP));
  if (current.requestedAt) props.deleteProperty(REBUILD_PROP);
  return { requestedAt: current.requestedAt || null, reasons: current.reasons || [] };
}

function parseRebuild_(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

// ============ 状態ごとの件数 ============

/**
 * 件数を出すためだけに毎回Notionを全件走査すると、件数が増えるほどカードの表示が遅くなる。
 * 集計結果だけをスクリプトプロパティに置き、カードはそれを読むだけにする。
 *
 * 更新は2通り:
 *  - 定期トリガー(setupStatusCountsTrigger)で作り直す。Mac側バッチのように
 *    GASを通らない状態変更を拾うため。
 *  - このGASを通る書き込み(状態・分類・生成・削除)では、その場で1件ぶんの差分を当てる。
 *    次のトリガーを待たずに画面へ出すため。
 *
 * 形: { updatedAt, counts: { <video|web>: { <分類>: { total, status:{}, partial:{} } } } }
 * 「除外」は一覧に出さない論理削除なので、どの数にも入れない。
 */
var STATUS_COUNTS_PROP = 'STATUS_COUNTS';

/** 段の構成。フロントの generate.js の STAGES / MUSIC_STAGES と対で持つ */
var STAGE_MODES = {
  '': ['summary', 'mindmap', 'fields', 'apply', 'ideas'],
  music: ['summary', 'fields'],
};

function emptyBucket_() {
  return { total: 0, status: {}, partial: { '': 0, music: 0 } };
}

function bucketOf_(counts, source, category) {
  if (!counts[source]) counts[source] = {};
  if (!counts[source][category]) counts[source][category] = emptyBucket_();
  return counts[source][category];
}

/** その段がすでに埋まっているか。サマリだけは有無フラグではなく本文を見る */
function stageFilled_(item, stageId) {
  return stageId === 'summary' ? Boolean(item.summary) : Boolean(item.has[stageId]);
}

/** 1件ぶんを集計に足す(delta=1)／引く(delta=-1) */
function applyToCounts_(counts, item, delta) {
  if (!item || item.status === STATUS_EXCLUDED) return;
  var bucket = bucketOf_(counts, item.source, item.category || '');
  bucket.total += delta;
  bucket.status[item.status] = (bucket.status[item.status] || 0) + delta;
  if (item.status !== STATUS_SUMMARIZED) return;

  // 生成が途中で落ちて段が欠けているもの。スペースの mode で段の数が変わる
  Object.keys(STAGE_MODES).forEach(function (mode) {
    var missing = STAGE_MODES[mode].some(function (stageId) {
      return !stageFilled_(item, stageId);
    });
    if (missing) bucket.partial[mode] += delta;
  });
}

/** ページがどちらのDBのものか。フロントから渡る source より確実 */
function sourceOfPage_(page) {
  var parent = (page && page.parent) || {};
  var id = String(parent.database_id || '').replace(/-/g, '');
  var web = String(webDbId_() || '').replace(/-/g, '');
  return id && web && id === web ? 'web' : 'video';
}

function buildStatusCounts_() {
  var counts = {};
  eachSourcePage_(function (page, source) {
    applyToCounts_(counts, toListItem_(page, source), 1);
  });
  return { updatedAt: new Date().toISOString(), counts: counts };
}

/** 定期トリガーから呼ぶ。Notionを走査して集計を作り直す */
function refreshStatusCounts() {
  var data = buildStatusCounts_();
  PropertiesService.getScriptProperties().setProperty(STATUS_COUNTS_PROP, JSON.stringify(data));
  return data;
}

/** カードが読む入口。refresh=true のときだけ作り直す(手動更新ボタン用) */
function statusCounts_(refresh) {
  if (!refresh) {
    var raw = PropertiesService.getScriptProperties().getProperty(STATUS_COUNTS_PROP);
    if (raw) {
      try {
        var data = JSON.parse(raw);
        if (data && data.counts) return data;
      } catch (e) {
        // 壊れていれば作り直す
      }
    }
  }
  return refreshStatusCounts();
}

/**
 * 更新した1件ぶんだけ集計を直す。
 * 集計がまだ無ければ何もしない(初回の statusCounts_ で全件から作られる)。
 */
function adjustStatusCounts_(before, after) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(STATUS_COUNTS_PROP);
  if (!raw) return;

  var data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return;
  }
  if (!data || !data.counts) return;

  if (before) applyToCounts_(data.counts, toListItem_(before, sourceOfPage_(before)), -1);
  if (after) applyToCounts_(data.counts, toListItem_(after, sourceOfPage_(after)), 1);
  data.updatedAt = new Date().toISOString();
  props.setProperty(STATUS_COUNTS_PROP, JSON.stringify(data));
}

/**
 * ページを更新し、集計に差分を当てる。
 * 変更前の状態を知るために更新前に1度読む(集計をやり直すより安い)。
 * 集計が失敗しても更新そのものは成功として返す。ずれは次のトリガーで直る。
 */
function patchSynced_(pageId, payload, source) {
  var before = null;
  try {
    before = notionPageFetch_('pages/' + pageId, 'get', null, source);
  } catch (e) {
    // 読めなくても更新は通す
  }
  var after = notionPageFetch_('pages/' + pageId, 'patch', payload, source);
  try {
    adjustStatusCounts_(before, payload.archived ? null : after);
  } catch (e) {
    // 集計のずれで書き込みを失敗扱いにしない
  }
  return after;
}

/** 初回に1度だけ手で実行する。10分ごとに集計を作り直すトリガーを張る */
function setupStatusCountsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'refreshStatusCounts') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('refreshStatusCounts').timeBased().everyMinutes(10).create();
  return { created: true };
}
