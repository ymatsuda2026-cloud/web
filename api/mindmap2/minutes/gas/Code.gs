/**
 * 議事録 v2 — GAS（ログイン・書き込みの窓口）
 *
 * 役割
 *   ・login     : 権限コードを確かめ、その role の「鍵束」（暗号化済み）とセッションを返す
 *   ・initUpload / putChunk : 音声を Drive の受付フォルダへ 3MB ずつ中継（今の minutes と同じ方式）
 *   ・put       : 暗号化済みの議事録を GitHub private リポジトリへ書く（書き込みトークンは GAS だけが持つ）
 *   ・setup     : Mac の setup_keys.py から、下のスクリプトプロパティをまとめて登録する
 *
 * GAS は中身を復号できない。権限の確認は「どのグループ鍵で包まれているか（index.json の k）」で行う。
 *
 * スクリプトプロパティ
 *   手で入れるのは SETUP_TOKEN だけ（setup_keys.py が作る長いランダム値。Mac の .env と同じもの）。
 *   ほかは setup_keys.py が setup で登録する。ソースやコメントには絶対に書かない。
 *     CODE_PEPPER     権限コードの HMAC 用の秘密値
 *     CODE_HASHES     {"HMAC(コード)": "role", ...}  元のコードは保存しない
 *     ROLE_GIDS       {"role": "グループID", ...}
 *     SESSION_SECRET  セッションの署名用の秘密値
 *     BUNDLE_<role>   その role の鍵束（権限コードで暗号化した {salt, iv, ct}）
 *     GH_TOKEN        データ用リポジトリへの書き込みトークン（fine-grained, Contents: Read and write）
 *     GH_OWNER / GH_REPO / GH_BRANCH  データ用リポジトリ
 *     AUDIO_FOLDER_ID 音声の受付フォルダ（Drive）
 */

var ADMIN_ROLE = 'xYz';
var SESSION_HOURS = 12;
var FILE_NAMES = ['t', 's', 'n']; // t: 文字起こし, s: 要約, n: メモ・ToDoの完了
var STATUSES = ['tw', 'tr', 'sw', 'ok', 'err'];
var MAX_FAILS = 30;     // 10分あたりのログイン失敗の上限（GAS では接続元を区別できないので全体で数える）
var FAIL_WINDOW = 600;

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var data;
    switch (body.action) {
      case 'login': data = login_(body.code); break;
      case 'initUpload': data = initUpload_(session_(body.session), body); break;
      case 'putChunk': session_(body.session); data = putChunk_(body); break;
      case 'put': data = put_(session_(body.session), body); break;
      case 'setup': data = setup_(body); break;
      default: throw new Error('unknown action');
    }
    return out_({ ok: true, data: data });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(k, required) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  if (required !== false && !v) throw new Error(k + ' が未設定です');
  return v;
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

// ============ ログイン ============

function login_(code) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('loginFails') || 0);
  if (fails >= MAX_FAILS) throw new Error('失敗が続いたため、しばらくログインを止めています。10分ほどしてからやり直してください。');

  var input = String(code || '').trim();
  var role = null;
  if (input) {
    var sig = Utilities.computeHmacSha256Signature(input, prop_('CODE_PEPPER'));
    role = JSON.parse(prop_('CODE_HASHES'))[hex_(sig)] || null;
  }
  if (!role) {
    cache.put('loginFails', String(fails + 1), FAIL_WINDOW);
    throw new Error('権限コードが違います。');
  }

  var gids = JSON.parse(prop_('ROLE_GIDS'));
  var gid = gids[role];
  if (!gid) throw new Error('この権限のグループ鍵がまだ作られていません（管理者に連絡してください）');
  var raw = prop_('BUNDLE_' + role, false);
  if (!raw) throw new Error('この権限の鍵束が登録されていません（管理者に連絡してください）');
  var sealed = JSON.parse(raw);

  var admin = role === ADMIN_ROLE;
  var exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return {
    role: role, admin: admin, gid: gid, adminGid: gids[ADMIN_ROLE],
    bundle: sealed, session: sign_({ r: role, g: gid, a: admin, x: exp }), exp: exp,
  };
}

function sign_(obj) {
  var payload = Utilities.base64EncodeWebSafe(JSON.stringify(obj));
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, prop_('SESSION_SECRET')));
  return payload + '.' + sig;
}

function session_(token) {
  var parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('ログインし直してください。');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], prop_('SESSION_SECRET')));
  if (sig !== parts[1]) throw new Error('ログインし直してください。');
  var s = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString('UTF-8'));
  if (!s.x || s.x < Date.now()) throw new Error('ログインの有効期限が切れました。開き直してください。');
  return { role: s.r, gid: s.g, admin: !!s.a };
}

// ============ 登録（Mac の setup_keys.py から） ============

var SETUP_KEYS = ['CODE_PEPPER', 'CODE_HASHES', 'ROLE_GIDS', 'SESSION_SECRET', 'GH_TOKEN', 'GH_OWNER', 'GH_REPO', 'GH_BRANCH', 'AUDIO_FOLDER_ID'];

function setupKeyOk_(k) {
  return SETUP_KEYS.indexOf(k) >= 0 || /^BUNDLE_[A-Za-z0-9_-]{1,40}$/.test(k);
}

/**
 * body: { token, set?: {キー: 値}, del?: [キー], check?: true }
 * token は SETUP_TOKEN と一致したときだけ通す。値は返さない（check はキーの有無だけ返す）
 */
function setup_(body) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('setupFails') || 0);
  if (fails >= 5) throw new Error('登録の失敗が続いたため、しばらく止めています。');
  var want = prop_('SETUP_TOKEN');
  var got = String(body.token || '');
  var a = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, want);
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, got);
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0 || want.length < 32) {
    cache.put('setupFails', String(fails + 1), FAIL_WINDOW);
    throw new Error('SETUP_TOKEN が違います');
  }
  var props = PropertiesService.getScriptProperties();
  var set = body.set || {};
  var keys = Object.keys(set);
  keys.forEach(function (k) {
    if (!setupKeyOk_(k)) throw new Error('登録できないキーです: ' + k);
    if (typeof set[k] !== 'string' || set[k].length > 9000) throw new Error('値が不正です: ' + k);
  });
  (body.del || []).forEach(function (k) { if (!setupKeyOk_(k)) throw new Error('消せないキーです: ' + k); });
  if (keys.length) {
    var o = {};
    keys.forEach(function (k) { o[k] = set[k]; });
    props.setProperties(o, false);
  }
  (body.del || []).forEach(function (k) { props.deleteProperty(k); });
  var all = props.getKeys();
  return {
    set: keys,
    deleted: body.del || [],
    have: all.filter(function (k) { return setupKeyOk_(k); }).sort(),
  };
}

// ============ 音声のアップロード（今の minutes と同じ中継方式） ============

function initUpload_(sess, body) {
  DriveApp.getRootFolder(); // Drive の権限を確実に要求させる
  if (!/^m_[a-z0-9]{12}\.[a-z0-9]{1,5}$/.test(String(body.filename || ''))) throw new Error('ファイル名が不正です');
  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': body.mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(body.size || 0),
    },
    payload: JSON.stringify({ name: body.filename, parents: [prop_('AUDIO_FOLDER_ID')] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Drive の受付に失敗しました (' + res.getResponseCode() + ')');
  var h = res.getAllHeaders();
  var url = h['Location'] || h['location'];
  if (!url) throw new Error('Drive のアップロード先を取得できませんでした');
  return { sessionUrl: url };
}

function putChunk_(body) {
  if (String(body.sessionUrl || '').indexOf('https://www.googleapis.com/upload/drive/') !== 0) throw new Error('送り先が不正です');
  var bytes = Utilities.base64Decode(body.chunk);
  var start = Number(body.offset);
  var end = start + bytes.length - 1;
  var res = UrlFetchApp.fetch(body.sessionUrl, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + body.total },
    payload: bytes,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 200 || code === 201) return { done: true, file: JSON.parse(res.getContentText()) };
  if (code === 308) return { done: false };
  throw new Error('音声の送信に失敗しました (' + code + ')');
}

// ============ GitHub ============

function ghUrl_(path) {
  return 'https://api.github.com/repos/' + prop_('GH_OWNER') + '/' + prop_('GH_REPO') + '/contents/' + path;
}

function ghHeaders_() {
  return { Authorization: 'Bearer ' + prop_('GH_TOKEN'), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function branch_() { return prop_('GH_BRANCH', false) || 'main'; }

/** → {text, sha} / 無ければ null */
function ghGet_(path) {
  var res = UrlFetchApp.fetch(ghUrl_(path) + '?ref=' + encodeURIComponent(branch_()), { headers: ghHeaders_(), muteHttpExceptions: true });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('GitHub の読み込みに失敗しました (' + res.getResponseCode() + ')');
  var j = JSON.parse(res.getContentText());
  var b64 = j.content;
  if (!b64 || j.encoding !== 'base64') { // 1MB を超えると content が空になるので blob API で取る
    var r2 = UrlFetchApp.fetch('https://api.github.com/repos/' + prop_('GH_OWNER') + '/' + prop_('GH_REPO') + '/git/blobs/' + j.sha,
      { headers: ghHeaders_(), muteHttpExceptions: true });
    if (r2.getResponseCode() !== 200) throw new Error('GitHub の読み込みに失敗しました (blob ' + r2.getResponseCode() + ')');
    b64 = JSON.parse(r2.getContentText()).content;
  }
  var text = Utilities.newBlob(Utilities.base64Decode(String(b64).replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { text: text, sha: j.sha };
}

/** 書けたら true、sha が古くて書けなければ false */
function ghPut_(path, text, sha, message) {
  var payload = {
    message: message || ('update ' + path),
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: branch_(),
  };
  if (sha) payload.sha = sha;
  var res = UrlFetchApp.fetch(ghUrl_(path), {
    method: 'put', contentType: 'application/json', headers: ghHeaders_(),
    payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 200 || code === 201) return true;
  if (code === 409 || code === 422) return false;
  throw new Error('GitHub への書き込みに失敗しました (' + code + ')');
}

function ghWrite_(path, text) {
  for (var i = 0; i < 3; i++) {
    var cur = ghGet_(path);
    if (ghPut_(path, text, cur && cur.sha)) return;
  }
  throw new Error('GitHub への書き込みが競合しました。もう一度試してください。');
}

function ghDelete_(path) {
  var cur = ghGet_(path);
  if (!cur) return;
  UrlFetchApp.fetch(ghUrl_(path), {
    method: 'delete', contentType: 'application/json', headers: ghHeaders_(),
    payload: JSON.stringify({ message: 'delete ' + path, sha: cur.sha, branch: branch_() }), muteHttpExceptions: true,
  });
}

/** index.json を読み・変え・書く。Mac 側と同時に書いて sha がずれたら読み直してやり直す */
function updateIndex_(fn) {
  for (var i = 0; i < 4; i++) {
    var cur = ghGet_('index.json');
    var list = cur ? JSON.parse(cur.text) : [];
    var result = fn(list);
    if (ghPut_('index.json', JSON.stringify(list), cur && cur.sha, 'index')) return result;
    Utilities.sleep(500 + i * 500);
  }
  throw new Error('一覧の更新が競合しました。もう一度試してください。');
}

// ============ 議事録の書き込み ============

function isSealed_(v) {
  return v && typeof v === 'object' && typeof v.iv === 'string' && typeof v.ct === 'string';
}

function isWrap_(v) {
  return isSealed_(v) && typeof v.e === 'string';
}

function checkKeys_(k, sess, adminGid) {
  if (!k || typeof k !== 'object') throw new Error('鍵がありません');
  var ids = Object.keys(k);
  ids.forEach(function (g) { if (!isWrap_(k[g])) throw new Error('鍵の形式が不正です'); });
  if (ids.indexOf(adminGid) < 0) throw new Error('管理者の鍵がありません');
  if (!sess.admin) {
    // 管理者以外は「自分のグループ＋管理者」で固定
    var want = [sess.gid, adminGid].filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
    if (ids.slice().sort().join(',') !== want.join(',')) throw new Error('閲覧グループは変えられません');
  }
}

/**
 * body: { id, entry?（新規）, patch?（更新）, files?: {t|s|n: 暗号化済み JSON}, del?: true }
 */
function put_(sess, body) {
  var id = String(body.id || '');
  if (!/^m_[a-z0-9]{12}$/.test(id)) throw new Error('ID が不正です');
  var adminGid = JSON.parse(prop_('ROLE_GIDS'))[ADMIN_ROLE];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // まず権限を確かめる（書く前に）
    var snap = ghGet_('index.json');
    var list0 = snap ? JSON.parse(snap.text) : [];
    var cur0 = list0.filter(function (x) { return x.id === id; })[0] || null;

    if (body.del) {
      if (!cur0) return { deleted: false };
      var mine = cur0.by === sess.gid && (cur0.st === 'tw' || cur0.st === 'err');
      if (!sess.admin && !mine) throw new Error('削除できるのは管理者だけです');
      updateIndex_(function (list) {
        for (var i = list.length - 1; i >= 0; i--) if (list[i].id === id) list.splice(i, 1);
      });
      FILE_NAMES.forEach(function (n) { ghDelete_('m/' + id + '/' + n + '.json'); });
      return { deleted: true };
    }

    var files = body.files || {};
    Object.keys(files).forEach(function (n) {
      if (FILE_NAMES.indexOf(n) < 0) throw new Error('ファイル名が不正です');
      if (!isSealed_(files[n])) throw new Error('暗号化されていないデータは保存できません');
    });

    if (!cur0) {
      var e = body.entry;
      if (!e) throw new Error('議事録が見つかりません');
      checkKeys_(e.k, sess, adminGid);
      if (!isSealed_(e.m)) throw new Error('タイトルが暗号化されていません');
      if (['tw', 'sw', 'ok'].indexOf(e.st) < 0) throw new Error('状態が不正です');
      var entry = {
        id: id, date: String(e.date || '').slice(0, 16), dur: Number(e.dur) || 0, st: e.st,
        src: e.src === 'text' ? 'text' : 'audio', by: sess.gid, upd: Date.now(), k: e.k, m: e.m,
      };
      Object.keys(files).forEach(function (n) { ghWrite_('m/' + id + '/' + n + '.json', JSON.stringify(files[n])); });
      updateIndex_(function (list) { list.push(entry); });
      return { entry: entry };
    }

    if (!sess.admin && !cur0.k[sess.gid]) throw new Error('この議事録を変更する権限がありません');
    var p = body.patch || {};
    if (p.k) checkKeys_(p.k, { admin: sess.admin, gid: sess.gid }, adminGid);
    if (p.k && !sess.admin) throw new Error('閲覧グループを変えられるのは管理者だけです');
    if (p.m && !(sess.admin || cur0.by === sess.gid)) throw new Error('タイトルを変えられるのは登録した人と管理者だけです');
    if (p.m && !isSealed_(p.m)) throw new Error('タイトルが暗号化されていません');
    if (p.st) {
      if (STATUSES.indexOf(p.st) < 0) throw new Error('状態が不正です');
      var okMove = sess.admin ||
        (p.st === 'ok' && (cur0.st === 'sw' || cur0.st === 'ok') && files.s) ||
        (p.st === 'tw' && cur0.st === 'err');
      if (!okMove) throw new Error('この状態には変えられません');
    }
    if (files.t && !sess.admin) throw new Error('文字起こしを書き換えられるのは管理者だけです');

    Object.keys(files).forEach(function (n) { ghWrite_('m/' + id + '/' + n + '.json', JSON.stringify(files[n])); });
    var updated = updateIndex_(function (list) {
      var e2 = list.filter(function (x) { return x.id === id; })[0];
      if (!e2) throw new Error('議事録が見つかりません');
      if (p.st) { e2.st = p.st; if (p.st !== 'err') delete e2.err; }
      if (p.k) e2.k = p.k;
      if (p.m) e2.m = p.m;
      if (p.date) e2.date = String(p.date).slice(0, 16);
      if (p.dur != null) e2.dur = Number(p.dur) || 0;
      e2.upd = Date.now();
      return e2;
    });
    return { entry: updated };
  } finally {
    lock.releaseLock();
  }
}
