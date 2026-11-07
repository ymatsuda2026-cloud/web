/**
 * ClipStock 用「要約の窓口」。既存の Code.gs と同じ Apps Script プロジェクトに追加する。
 *
 * 追加するスクリプトプロパティ:
 *   GEMINI_API_KEY   Gemini の API キー(必須。ブラウザには持たせない)
 *   GEMINI_MODEL     省略時 gemini-2.5-flash
 *   APPLY_CONTEXT    応用の切り口(省略可。例: 「受託開発・SES・保守運用の現場」)
 *
 * Code.gs の doPost の switch に次の2行を足す(SETUP.md 参照):
 *   case 'summarize':     result = csSummarize_(body.pageId, body.source); break;
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

// ================= エントリー =================

/** Gemini で5段を順に作って保存する。サマリが作れなければ保存せずエラー */
function csSummarize_(pageId, source) {
  var started = Date.now();
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
  return { detail: out, model: model, rawCount: transcript.length, failed: failed, generatedAt: new Date().toISOString() };
}

/** Claude.ai が返したJSONを取り込んで保存する */
function csImportSummary_(pageId, jsonText, source) {
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
  saveGenerated_(pageId, out, 'Claude.ai', transcript.length, source);
  return { detail: out, model: 'Claude.ai', rawCount: transcript.length, failed: [], generatedAt: new Date().toISOString() };
}

// ================= Notion 読み出し =================

function csDetail_(pageId, source) { return fetchDetail_(pageId, source); }
function csTranscript_(pageId, source) { return fetchTranscript_(pageId, source).text; }

// ================= Gemini =================

function csModel_() { return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash'; }

function csContextHint_() {
  var c = PropertiesService.getScriptProperties().getProperty('APPLY_CONTEXT');
  return c ? '\n応用の切り口: ' + c : '';
}

function csTail_(instructions) { return '\n\n----------------\n\n' + instructions + '\n' + CS_NO_FENCE; }

function csAsk_(user) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です');
  var body = {
    model: csModel_(),
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '日本語で回答してください。' },
      { role: 'user', content: user },
    ],
  };
  var tries429 = 0, tries5xx = 0;
  for (;;) {
    var res = UrlFetchApp.fetch(CS_ENDPOINT, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify(body),
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code === 200) {
      var json = JSON.parse(text);
      var content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!String(content || '').trim()) throw new Error('AIから応答がありませんでした');
      return content;
    }
    if (code === 429) {
      // 1日の上限は待っても直らない。分あたりの上限だけ指数バックオフで待つ
      var daily = /quota|exceeded your current quota/i.test(text) && !/per minute|rpm/i.test(text);
      if (daily) throw new Error('Gemini の1日の利用上限に達しています。日付が変わるまで待ってください');
      if (tries429 >= 3) throw new Error('Gemini の利用制限が続いています。少し待ってやり直してください');
      Utilities.sleep(15000 * Math.pow(2, tries429++));
      continue;
    }
    if (code >= 500 && tries5xx < 2) { Utilities.sleep(5000); tries5xx++; continue; }
    throw new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 200));
  }
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
