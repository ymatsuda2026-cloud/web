/**
 * ClipStock 用「要約の窓口」。既存の Code.gs と同じ Apps Script プロジェクトに追加する。
 *
 * 要約に使う AI:
 *   ClipStock の変換管理「要約AI」で設定した AI(Gemini / Claude / OpenAI)を使う。
 *   キーは依頼のたびにブラウザから届き、ここには保存しない(ブラウザ側は暗号化して記録に保存)。
 *   画面で未設定のときだけ、次のスクリプトプロパティの Gemini を使う(どちらも省略可):
 *   GEMINI_API_KEY   Gemini の API キー
 *   GEMINI_MODEL     省略時 gemini-2.5-flash
 *   APPLY_CONTEXT    応用の切り口(省略可。例: 「受託開発・SES・保守運用の現場」)
 *
 * Code.gs の doPost の switch に次の2行を足す(SETUP.md 参照):
 *   case 'summarize':     result = csSummarize_(body.pageId, body.source, body.ai); break;
 *   case 'testAi':        result = csTestAi_(body.ai); break;
 *   case 'aiPlan':        result = csAiPlan_(body.pageId, body.source, body.limit); break;
 *   case 'importSummary': result = csImportSummary_(body.pageId, body.json, body.source, body.model); break;
 *
 *   case 'aiChat':        result = csAiChat_(body.ai, body.system, body.user); break;
 *   case 'aiModels':      result = csAiModels_(body.ai); break;
 *
 * Ollama も GAS から呼ぶ。GAS は Google のサーバーで動くので、ngrok などで https にした URL が要る
 * (http://localhost は届かない)。手元のモデルは遅く、5段を1回の実行(6分まで)に収めにくいので、
 * 段ごとに分けて呼ぶ: aiPlan で文字起こしと指示文を受け取る → 画面が aiChat を段ごとに呼ぶ
 *                   → importSummary で、ここと同じ変換(時刻付け)をして保存する
 *   case 'importSummary': result = csImportSummary_(body.pageId, body.json, body.source); break;
 *
 * (Claude.ai に貼るプロンプトは ClipStock の画面側で作る。ここでは作らない)
 *
 * 流れ: 文字起こしを Notion から読む → Gemini で5段(サマリ/マインドマップ/分野別/応用/活用)
 *       → 時刻は AI に答えさせず、引用を原文から探して付ける → saveGenerated_ で書き戻す
 *       (書き戻すと 状態 が「要約済み」になり、次の書き出しで ClipStock の一覧に並ぶ)
 */

var CS_TRANSCRIPT_LIMIT = 100000;   // 文字起こしを渡す上限(文字)
var CS_BUDGET_MS = 300000;          // GAS は6分で切れる。5分を過ぎたら残りの段を諦める
var CS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
var CS_OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
var CS_ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
var CS_DEFAULT_MODEL = { gemini: 'gemini-2.5-flash', anthropic: 'claude-sonnet-5-5', openai: 'gpt-5-mini', ollama: '' };
var CS_PROVIDER_NAME = { gemini: 'Gemini', anthropic: 'Claude', openai: 'OpenAI', ollama: 'Ollama' };
var CS_OLLAMA_CTX = 16384;
var CS_AI = null;                   // この依頼で使う AI({provider, model, key})。csUseAi_ で決める

// ================= エントリー =================

/** 設定した AI で5段を順に作って保存する。サマリが作れなければ保存せずエラー */
function csSummarize_(pageId, source, ai) {
  var started = Date.now();
  csUseAi_(ai);
  var detail = csDetail_(pageId, source);
  var transcript = String(csTranscript_(pageId, source) || '');
  if (transcript.replace(/\s/g, '').length < 50) throw new Error('文字起こしがありません(または短すぎます)');

  var text = transcript.slice(0, CS_TRANSCRIPT_LIMIT);
  var timed = csHasTimecodes_(text);
  var segments = timed ? csSplitTranscript_(text) : [];
  var input = '動画タイトル: ' + detail.title + '\n\n' + text;
  var model = csModel_();
  var out = {};
  var failed = [];

  // 1) サマリ(必須)
  var s1 = csJson_(csAsk_(input + csTail_(CS_P.summary)));
  out.summary = String(s1.summary || '').trim();
  if (!out.summary) throw new Error('サマリを作れませんでした');

  var steps = [
    ['mindmap', '作成: マインドマップ', function () {
      var p = csJson_(csAsk_(input + csTail_(CS_P.mindmap + (timed ? CS_MINDMAP_QUOTE : ''))));
      out.mindmap = csMindmapToText_(p, segments);
    }],
    ['fields', '作成: 分野別', function () {
      var p = csJson_(csAsk_(input + csTail_(CS_P.fields + (timed ? CS_FIELDS_QUOTE : CS_FIELDS_PLAIN))));
      out.fields = csFieldsToText_(p.fields, segments);
    }],
    ['apply', '作成: 応用', function () {
      var p = csJson_(csAsk_(csApplyContext_(detail.title, out) + csTail_(CS_P.apply + csContextHint_())));
      out.apply = csApplyToText_(p.apply);
    }],
    ['ideas', '作成: 活用', function () {
      var p = csJson_(csAsk_(csApplyContext_(detail.title, out) + csTail_(CS_P.ideas)));
      out.ideas = csIdeasToText_(p.ideas);
    }],
  ];
  steps.forEach(function (st) {
    if (Date.now() - started > CS_BUDGET_MS) { failed.push(st[0]); return; }
    try { st[2](); } catch (err) { failed.push(st[0]); }
  });

  saveGenerated_(pageId, out, model, transcript.length, source);
  return { detail: out, model: model, provider: CS_AI.provider, rawCount: transcript.length, failed: failed, generatedAt: new Date().toISOString() };
}

/** 「要約AI」の設定を試す(Notion には触らない)。短い問いを1回だけ送る */
function csTestAi_(ai) {
  csUseAi_(ai);
  var p = csJson_(csAsk_('次のJSONをそのまま返してください: {"ok": true}' + '\n' + CS_NO_FENCE));
  return { ok: !!p.ok, provider: CS_AI.provider, model: CS_AI.model, fromScript: !!CS_AI.fromScript };
}

/**
 * ブラウザ側の AI(Ollama)で要約するための材料を返す。Notion には書かない。
 * limit: 文字起こしを渡す上限(文字)。手元のモデルは読める長さが短いので、ブラウザが決める
 */
function csAiPlan_(pageId, source, limit) {
  var detail = csDetail_(pageId, source);
  var transcript = String(csTranscript_(pageId, source) || '');
  if (transcript.replace(/\s/g, '').length < 50) throw new Error('文字起こしがありません(または短すぎます)');
  var max = Math.min(CS_TRANSCRIPT_LIMIT, Math.max(2000, Number(limit) || CS_TRANSCRIPT_LIMIT));
  var text = transcript.slice(0, max);
  var timed = csHasTimecodes_(text);
  return {
    title: detail.title,
    input: '動画タイトル: ' + detail.title + '\n\n' + text,
    rawCount: transcript.length,
    truncated: transcript.length > max,
    tails: {
      summary: csTail_(CS_P.summary),
      mindmap: csTail_(CS_P.mindmap + (timed ? CS_MINDMAP_QUOTE : '')),
      fields: csTail_(CS_P.fields + (timed ? CS_FIELDS_QUOTE : CS_FIELDS_PLAIN)),
      apply: csTail_(CS_P.apply + csContextHint_()),
      ideas: csTail_(CS_P.ideas),
    },
    system: '日本語で回答してください。',
  };
}

/** Claude.ai(またはブラウザ側の AI)が返したJSONを取り込んで保存する。model は保存する作成元の名前 */
function csImportSummary_(pageId, jsonText, source, model) {
  var by = String(model || '').trim().slice(0, 80) || 'Claude.ai';
  var parsed = csJson_(String(jsonText || ''));
  var transcript = String(csTranscript_(pageId, source) || '');
  var timed = csHasTimecodes_(transcript);
  var segments = timed ? csSplitTranscript_(transcript) : [];
  var out = {};
  out.summary = String(parsed.summary || '').trim();
  if (!out.summary) throw new Error('summary が見つかりません。JSONの形を確認してください');
  if (parsed.mindmap) out.mindmap = csMindmapToText_(parsed.mindmap, segments);
  if (parsed.fields) out.fields = csFieldsToText_(parsed.fields, segments);
  if (parsed.apply) out.apply = csApplyToText_(parsed.apply);
  if (parsed.ideas) out.ideas = csIdeasToText_(parsed.ideas);
  saveGenerated_(pageId, out, by, transcript.length, source);
  return { detail: out, model: by, rawCount: transcript.length, failed: [], generatedAt: new Date().toISOString() };
}

// ================= Notion 読み出し =================

function csDetail_(pageId, source) { return fetchDetail_(pageId, source); }
function csTranscript_(pageId, source) { return fetchTranscript_(pageId, source).text; }

// ================= AI(Gemini / Claude / OpenAI) =================

/** ブラウザから届いた設定を使う。無ければスクリプトプロパティの Gemini */
function csUseAi_(ai) {
  ai = ai || {};
  var provider = String(ai.provider || '').toLowerCase();
  var key = String(ai.key || '').trim();
  if (provider === 'ollama') {
    var url = csOllamaBase_(ai.url);
    if (!/^https:\/\//i.test(url)) throw new Error('Ollama の URL は https で公開したもの(ngrok など)を入れてください。GAS は Google のサーバーで動くので、http://localhost や LAN の IP には届きません');
    var model = String(ai.model || '').trim();
    if (!model) throw new Error('Ollama のモデル名が空です。変換管理の「要約AI」で選んでください');
    CS_AI = { provider: 'ollama', model: model, key: key, url: url, ctx: Math.max(2048, Number(ai.ctx) || CS_OLLAMA_CTX) };
    return CS_AI;
  }
  if (provider && key) {
    if (!(provider in CS_DEFAULT_MODEL)) throw new Error('対応していない AI です: ' + provider);
    CS_AI = { provider: provider, model: String(ai.model || '').trim() || CS_DEFAULT_MODEL[provider], key: key };
    return CS_AI;
  }
  var p = PropertiesService.getScriptProperties();
  var gk = p.getProperty('GEMINI_API_KEY');
  if (!gk) throw new Error('AI_NOT_SET: 要約AIが設定されていません。ClipStock の変換管理「要約AI」で、AI と API キーを設定してください');
  CS_AI = { provider: 'gemini', model: p.getProperty('GEMINI_MODEL') || CS_DEFAULT_MODEL.gemini, key: gk, fromScript: true };
  return CS_AI;
}

function csModel_() { return (CS_AI || csUseAi_(null)).model; }

function csContextHint_() {
  var c = PropertiesService.getScriptProperties().getProperty('APPLY_CONTEXT');
  return c ? '\n応用の切り口: ' + c : '';
}

function csTail_(instructions) { return '\n\n----------------\n\n' + instructions + '\n' + CS_NO_FENCE; }

function csAsk_(user, sys) {
  var ai = CS_AI || csUseAi_(null);
  var name = CS_PROVIDER_NAME[ai.provider];
  var system = sys || '日本語で回答してください。';
  var req;
  if (ai.provider === 'ollama') {
    req = { url: ai.url + '/api/chat', headers: csOllamaHeaders_(ai),
      body: { model: ai.model, stream: false, format: 'json', keep_alive: '10m',
        options: { temperature: 0.3, num_ctx: ai.ctx },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] } };
  } else if (ai.provider === 'anthropic') {
    req = { url: CS_ANTHROPIC_ENDPOINT,
      headers: { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' },
      body: { model: ai.model, max_tokens: 8192, system: system + CS_NO_FENCE, messages: [{ role: 'user', content: user }] } };
  } else {
    var body = { model: ai.model, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (ai.provider === 'gemini') body.temperature = 0.3;   // OpenAI の新しいモデルは temperature を受け付けないことがあるので送らない
    req = { url: ai.provider === 'openai' ? CS_OPENAI_ENDPOINT : CS_ENDPOINT,
      headers: { Authorization: 'Bearer ' + ai.key }, body: body };
  }
  var tries429 = 0, tries5xx = 0;
  for (;;) {
    var res;
    try {
      res = UrlFetchApp.fetch(req.url, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: req.headers, payload: JSON.stringify(req.body),
      });
    } catch (e) {
      throw new Error(name + '(' + (ai.url || req.url) + ')につながりません: ' + (e && e.message || e));
    }
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (ai.provider === 'ollama') csOllamaCheck_(ai, code, text);
    if (code === 200) {
      var content = csContent_(ai.provider, JSON.parse(text));
      if (!String(content || '').trim()) throw new Error(name + ' から応答がありませんでした');
      return content;
    }
    if (code === 401 || code === 403) throw new Error(name + ' の API キーが違うか、使えない状態です(HTTP ' + code + ')。変換管理の「要約AI」で確かめてください');
    if (code === 404) throw new Error(name + ' のモデル「' + ai.model + '」が見つかりません。変換管理の「要約AI」でモデル名を確かめてください');
    if (code === 429) {
      // 1日(または残高)の上限は待っても直らない。分あたりの上限だけ指数バックオフで待つ
      var hard = /insufficient_quota|billing|credit balance|exceeded your current quota/i.test(text) && !/per minute|rpm|rate.?limit/i.test(text);
      if (hard) throw new Error(name + ' の利用上限(または残高)に達しています。時間をおくか、契約の状態を確かめてください');
      if (tries429 >= 3) throw new Error(name + ' の利用制限が続いています。少し待ってやり直してください');
      Utilities.sleep(15000 * Math.pow(2, tries429++));
      continue;
    }
    if ((code >= 500 || code === 529) && tries5xx < 2) { Utilities.sleep(5000); tries5xx++; continue; }
    throw new Error(name + ' HTTP ' + code + ': ' + text.slice(0, 200));
  }
}

/** 応答から本文を取り出す(Claude は content[] の text、ほかは choices[0].message.content) */
function csContent_(provider, json) {
  if (provider === 'ollama') return json.message && json.message.content;
  if (provider === 'anthropic') {
    return (json.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('');
  }
  return json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
}

// ---------- Ollama ----------
function csOllamaBase_(u) { return String(u || '').trim().replace(/\/+$/, '').replace(/\/(api|v1)$/, ''); }

/** ngrok の無料版は確認ページをはさむので、印を付けて飛ばす(旧画面 llm-client.js と同じ) */
function csOllamaHeaders_(ai) {
  var h = { 'ngrok-skip-browser-warning': 'true' };
  if (ai.key) h.Authorization = 'Bearer ' + ai.key;
  return h;
}

/** トンネルや Ollama の失敗を、直し方の分かる言葉にする(200 なら何もしない) */
function csOllamaCheck_(ai, code, text) {
  if (code === 200 && /^\s*</.test(text)) throw new Error('Ollama ではなく、確認ページなどの HTML が返りました。URL を確かめてください');
  if (code === 200) return;
  if (/ERR_NGROK|ngrok/i.test(text) && code >= 400) throw new Error('Ollama(' + ai.url + ')につながりません。ngrok のトンネルが止まっているか、URL が変わっています(HTTP ' + code + ')');
  if (code === 404 && /model/i.test(text)) throw new Error('Ollama にモデル「' + ai.model + '」がありません。Ollama の機械で ollama pull ' + ai.model + ' を実行するか、「要約AI」でモデルを選び直してください');
  if (code === 401 || code === 403) throw new Error('Ollama に断られました(HTTP ' + code + ')。トンネルの鍵(API キー)を確かめてください');
  if (code === 502 || code === 503 || code === 504) throw new Error('Ollama(' + ai.url + ')につながりません。Mac の Ollama が起動しているか確かめてください(HTTP ' + code + ')');
}

/** 1回だけ AI に聞く(画面が段ごとに呼ぶ。Ollama のように遅い AI 用) */
function csAiChat_(ai, system, user) {
  csUseAi_(ai);
  if (!String(user || '').trim()) throw new Error('問いが空です');
  return { content: csAsk_(String(user), system ? String(system) : ''), model: CS_AI.model };
}

/** Ollama に入っているモデルの一覧 */
function csAiModels_(ai) {
  var a = Object.assign({}, ai || {}, { model: (ai && ai.model) || '-' });
  csUseAi_(a);
  if (CS_AI.provider !== 'ollama') return { models: [] };
  var res;
  try { res = UrlFetchApp.fetch(CS_AI.url + '/api/tags', { muteHttpExceptions: true, headers: csOllamaHeaders_(CS_AI) }); }
  catch (e) { throw new Error('Ollama(' + CS_AI.url + ')につながりません: ' + e.message); }
  var code = res.getResponseCode(), text = res.getContentText();
  csOllamaCheck_(CS_AI, code, text);
  var j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('Ollama ではない応答が返りました。URL を確かめてください: ' + text.slice(0, 120)); }
  return { models: (j.models || []).map(function (m) { return m.name; }).filter(String) };
}

function csJson_(text) {
  var t = String(text == null ? '' : text).trim();
  var a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('応答からJSONを取り出せませんでした');
  return JSON.parse(t.slice(a, b + 1));
}

// ================= プロンプト =================

var CS_NO_FENCE = '前後に説明文やコードフェンス(```)を付けず、JSONだけを出力してください。日本語で書いてください。';

var CS_P = {
  summary:
    '上の文字起こしを読み、サマリを次のJSONで返してください。\n' +
    '{ "summary": "..." }\n' +
    '- 5〜8文。何の話か、結論、押さえるべき点を、元を見なくても掴めるように書く。\n' +
    '- 箇条書きにしない。文字起こしに無いことを書かない。',
  mindmap:
    '上の文字起こしの構造をマインドマップにして、次のJSONで返してください。\n' +
    '{ "title": "主題", "branches": [ { "label": "大項目", "children": [ { "label": "小項目", "children": [] } ] } ] }\n' +
    '- 大項目は4〜7、各項目の子は2〜5、深さは最大3。ラベルは短く(20字程度)。',
  fields:
    '上の文字起こしを分野ごとに整理して、次のJSONで返してください。\n' +
    '{ "fields": [ { "name": "分野名", "summary": "その分野の要点を1〜2文", "points": [ POINT ] } ] }\n' +
    '- 分野は内容に応じて2〜5(例: 技術、経営、運用、法務、教育)。points は各2〜5件。',
  apply:
    '上のサマリと分野別要約を踏まえ、この内容を実務に応用する案を次のJSONで返してください。\n' +
    '{ "apply": [ { "title": "応用案の題", "summary": "どう使うか1〜2文", "steps": ["最初の一歩", "次の一歩"] } ] }\n' +
    '- 2〜4件。抽象論ではなく、明日から試せる形にする。',
  ideas:
    '上のサマリと分野別要約を踏まえ、面白い・意外な活用アイデアを次のJSONで返してください。\n' +
    '{ "ideas": [ { "title": "アイデアの題", "summary": "1〜2文" } ] }\n' +
    '- 3〜5件。応用案と重複させない。',
};

var CS_MINDMAP_QUOTE =
  '\n- 各項目に "quote" を足す: この項目の根拠になった原文の一文を、原文から一字一句そのまま写す(20〜60字)。\n' +
  '  言い換えは禁止。該当が無い項目(自分でまとめた見出し)は空文字。時刻や秒数は書かない。';
var CS_FIELDS_QUOTE = '\n' +
  '- POINT は { "text": "具体的な事実・数値・手順を1行で", "quote": "根拠の原文を一字一句そのまま(20〜60字)" }。\n' +
  '  quote は原文に実在する文字列のみ。言い換えは禁止。該当が無ければ空文字。時刻や秒数は書かない。';
var CS_FIELDS_PLAIN = '\n- POINT は "具体的な事実・数値・手順を1行で" の文字列。';

function csApplyContext_(title, out) {
  return ['動画タイトル: ' + title, '', '# サマリ', out.summary || '', '', '# 分野別要約', out.fields || ''].join('\n').slice(0, 8000);
}

// ================= タイムコード(clipstock/src/lib/timecode.js の移植) =================

var CS_TC = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/;

function csParseTimecode_(text) {
  var m = String(text == null ? '' : text).match(CS_TC);
  if (!m) return null;
  return (m[1] ? Number(m[1]) : 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function csFormatTimecode_(seconds) {
  var s = Math.max(0, Math.floor(Number(seconds) || 0));
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  var mm = h ? ('0' + m).slice(-2) : String(m);
  return (h ? h + ':' : '') + mm + ':' + ('0' + sec).slice(-2);
}
function csStripTimecode_(text) {
  return String(text == null ? '' : text).replace(new RegExp(CS_TC.source, 'g'), '').replace(/\s{2,}/g, ' ').trim();
}
function csHasTimecodes_(text) { return csParseTimecode_(text) !== null; }
function csWithTimecode_(text, seconds) {
  var body = String(text == null ? '' : text).trim();
  return (seconds === null || seconds === undefined) ? body : body + ' [' + csFormatTimecode_(seconds) + ']';
}
function csSplitTranscript_(text) {
  var out = [];
  String(text == null ? '' : text).split('\n').forEach(function (line) {
    if (!line.trim()) return;
    var at = csParseTimecode_(line);
    var body = at === null ? line.trim() : csStripTimecode_(line);
    if (!body) return;
    var prev = out[out.length - 1];
    if (prev && prev.at === at) prev.text += ' ' + body; else out.push({ at: at, text: body });
  });
  return out;
}
function csNormalize_(text) {
  return String(text == null ? '' : text).normalize('NFKC').toLowerCase()
    .replace(/[\s、。,.！？!?「」『』()（）・:：;；\-—ー~〜"'`]/g, '');
}
/** 引用を原文から探して秒を返す。見つからなければ null(嘘の時刻は出さない) */
function csResolveQuote_(quote, segments) {
  var q = csNormalize_(quote);
  if (q.length < 6 || !segments.length) return null;
  var full = '', owner = [];
  segments.forEach(function (seg, i) {
    var n = csNormalize_(seg.text);
    full += n;
    for (var k = 0; k < n.length; k++) owner.push(i);
  });
  var minLen = Math.max(6, Math.floor(q.length * 0.5));
  for (var len = q.length; len >= minLen; len = Math.floor(len * 0.8)) {
    var idx = full.indexOf(q.slice(0, len));
    if (idx !== -1) {
      var seg = segments[owner[idx]];
      return seg && seg.at !== null ? seg.at : null;
    }
  }
  return null;
}

// ================= 保存形式への変換(generate.js / sections.js の移植) =================

function csSerializeSections_(sections) {
  if (!Array.isArray(sections)) return '';
  return sections.map(function (s) {
    var out = [];
    if (s.heading) out.push('## ' + String(s.heading).trim());
    if (s.body) out.push(String(s.body).trim());
    (s.points || []).forEach(function (p) {
      var t = String(p == null ? '' : p).trim();
      if (t) out.push('- ' + t);
    });
    return out.join('\n');
  }).filter(Boolean).join('\n');
}

function csMindmapToText_(parsed, segments) {
  var title = String((parsed && parsed.title) || '').trim() || '動画の主題';
  var lines = ['# ' + title];
  function walk(nodes, depth) {
    (Array.isArray(nodes) ? nodes : []).forEach(function (raw) {
      var label = String((raw && raw.label) || '').trim();
      if (!label) return;
      var at = segments.length ? csResolveQuote_(String((raw && raw.quote) || ''), segments) : null;
      var text = csWithTimecode_(label, at);
      if (depth === 0) lines.push('## ' + text);
      else { var pad = ''; for (var i = 0; i < depth - 1; i++) pad += '  '; lines.push(pad + '- ' + text); }
      if (raw && Array.isArray(raw.children) && raw.children.length) walk(raw.children, depth + 1);
    });
  }
  walk(parsed && parsed.branches, 0);
  return lines.join('\n');
}

function csFieldsToText_(list, segments) {
  return csSerializeSections_((Array.isArray(list) ? list : []).map(function (f) {
    var points = [], earliest = null;
    (Array.isArray(f && f.points) ? f.points : []).forEach(function (p) {
      var text = String((typeof p === 'string' ? p : (p && p.text)) || '').trim();
      if (!text) return;
      var quote = typeof p === 'string' ? '' : String((p && p.quote) || '');
      var at = segments.length ? csResolveQuote_(quote, segments) : null;
      if (at !== null && (earliest === null || at < earliest)) earliest = at;
      points.push(csWithTimecode_(text, at));
    });
    return { heading: csWithTimecode_(String((f && f.name) || '').trim(), earliest), body: String((f && f.summary) || '').trim(), points: points };
  }));
}

function csApplyToText_(list) {
  return csSerializeSections_((Array.isArray(list) ? list : []).map(function (a) {
    return { heading: String((a && a.title) || '').trim(), body: String((a && a.summary) || '').trim(), points: Array.isArray(a && a.steps) ? a.steps : [] };
  }));
}

function csIdeasToText_(list) {
  return csSerializeSections_((Array.isArray(list) ? list : []).map(function (a) {
    return { heading: String((a && a.title) || '').trim(), body: String((a && a.summary) || '').trim(), points: [] };
  }));
}

// ================= 診断(動作には使わない) =================

/**
 * エディタで関数 csSelfTest を選んで「実行」→「実行ログ」で結果を読む。
 * 何も保存しない。「デプロイした版にこのコードが入っているか」ではなく、
 * 「今エディタにあるコードとプロパティが揃っているか」を調べる。
 */
function csSelfTest() {
  var p = PropertiesService.getScriptProperties();
  var lines = [];
  ['ACCESS_TOKEN', 'NOTION_TOKEN', 'VIDEO_DB_ID'].forEach(function (k) {
    lines.push('プロパティ ' + k + ': ' + (p.getProperty(k) ? 'OK' : '★未設定'));
  });
  lines.push('プロパティ GEMINI_API_KEY: ' + (p.getProperty('GEMINI_API_KEY') ? 'あり' : 'なし(ClipStock の「要約AI」で設定していれば不要)'));
  lines.push('プロパティ WEB_NOTION_TOKEN / WEB_DB_ID: ' + (p.getProperty('WEB_NOTION_TOKEN') ? 'あり' : 'なし(web記事を使わなければ不要)') + ' / ' + (p.getProperty('WEB_DB_ID') ? 'あり' : 'なし'));
  [['doPost', typeof doPost], ['saveField_', typeof saveField_], ['saveMemo_', typeof saveMemo_], ['fetchDetail_', typeof fetchDetail_],
   ['fetchTranscript_', typeof fetchTranscript_], ['saveGenerated_', typeof saveGenerated_], ['csSummarize_', typeof csSummarize_], ['csImportSummary_', typeof csImportSummary_], ['csTestAi_', typeof csTestAi_], ['csAiPlan_', typeof csAiPlan_], ['csAiChat_', typeof csAiChat_], ['csAiModels_', typeof csAiModels_]]
    .forEach(function (x) { lines.push('関数 ' + x[0] + ': ' + (x[1] === 'function' ? 'OK' : '★見つかりません(貼り付けが足りない)')); });
  if (typeof doPost === 'function') {
    var body = { action: 'importSummary', token: p.getProperty('ACCESS_TOKEN'), pageId: '', json: '', source: 'video' };
    var res = doPost({ postData: { contents: JSON.stringify(body) } }).getContent();
    lines.push('doPost に空の取り込みを送った結果: ' + res);
    lines.push('  → 「応答からJSONを取り出せませんでした」なら正常。「unknown action」なら doPost に case を足していない。「unauthorized」なら ACCESS_TOKEN が未設定。');
  }
  Logger.log(lines.join('\n'));
}

/**
 * ブラウザで /exec の URL を開いたときに、デプロイされている版の中身が分かるようにする。
 * ここに「★」が出る項目があれば、その版には必要な部品が入っていない(=新しいバージョンでデプロイし直す)。
 * 値そのものは出さない(入っているかどうかだけ)。
 */
function doGet() {
  var p = PropertiesService.getScriptProperties();
  var info = {
    ok: true, service: 'clipstock', deployedAt: new Date().toISOString(),
    doPost: typeof doPost === 'function',
    summarize: typeof csSummarize_ === 'function',
    importSummary: typeof csImportSummary_ === 'function',
    testAi: typeof csTestAi_ === 'function',
    aiPlan: typeof csAiPlan_ === 'function',
    aiChat: typeof csAiChat_ === 'function',
    aiModels: typeof csAiModels_ === 'function',
    saveField: typeof saveField_ === 'function',
    hasAccessToken: !!p.getProperty('ACCESS_TOKEN'),
    hasNotionToken: !!p.getProperty('NOTION_TOKEN'),
    hasGeminiKey: !!p.getProperty('GEMINI_API_KEY'),
  };
  return ContentService.createTextOutput(JSON.stringify(info, null, 2)).setMimeType(ContentService.MimeType.JSON);
}
