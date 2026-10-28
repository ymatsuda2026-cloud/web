import { useState } from "react";

// ===== Notion の場所 =====
const DS = {
  gen: "collection://97753aa5-d6ca-478d-b14f-8fcf07c7f031", // 生成ポスト①
  src: "collection://3dc77514-9b4f-437d-8592-d5c934a3ee2a", // ポスト①
  set: "collection://e23069e7-054c-4d6e-887a-cb8a7d483ffa", // 自動ポスト設定
};
const MCP = [{ type: "url", url: "https://mcp.notion.com/mcp", name: "notion" }];
const RANGES = { p1: { min: 80, max: 120 }, p2: { min: 110, max: 138 }, limit: 140 };
const FALLBACK_NAMES = ["王道・共感重視", "心理描写・大人の色気重視", "短尺・辛口フック"];
const PLACEHOLDER = "ここにNotionから抽出したポストやメモを貼り付け";

const DEFAULT_TEMPLATE = `# 指示
あなたは「女性心理と性愛の解像度が高い大人の男性」として、X（旧Twitter）向けの2連スレッド投稿（ツリー投稿）を作成するプロフェッショナルです。
入力される【元のポスト・メモ】を元に、要件をすべて満たしたポストを3パターン作成してください。

# 目的・ポジショニング
- 女性読者から「この人は本当に女の体を分かってる」「共感しかない」「この人に抱かれたい」と思わせる。
- 一般的な男性の勘違い（激しさ、深さ、スピード至上主義など）との対比を用い、投稿主の「大人の余裕・包容力・圧倒的な安心感」を演出する。
- 即物的な下品さを徹底的に排除し、肌の温度・密着・心理描写によって艶っぽさと興奮を引き出す。

# 構成要件
必ず以下の「2部構成（2連スレッド）」に分割すること。
- 【1ポスト目（フック・問題提起）】文字数：80〜120文字（全角140文字以内厳守）。「普通の男の勘違い」や「女性の秘めた本音」を突いて手を止めさせる。末尾は必ず「↓」などで自然に2ポスト目を開かせる導線にする。
- 【2ポスト目（答え・回収）】文字数：110〜138文字（全角140文字以内厳守）。1部で提示した疑問に対する明確な「答え・本質」を一言で提示。元データの要点を簡潔な箇条書きや短いフレーズでリスト化。最後は「大人の余裕・包容力・余韻」を感じさせる一言で締め、保存・いいねを促す。

# 文体・ワーディングルール
- 解剖学的・医学的すぎる硬い単語は避け、情緒的・官能的な表現（芯、奥のツボ、肌の温度、重み、隙間ゼロなど）に昇華する。
- 説教くさくならず、自身の経験や女性への深い理解から自然と滲み出る落ち着いたトーンにする。
- 絵文字は使わないか、使っても最小限。

# 出力フォーマット
- パターン1：王道・共感重視（保存・いいね狙い）
- パターン2：心理描写・大人の色気重視（妄想・興奮を刺激）
- パターン3：短尺・辛口フック（インプレッション狙い）

---

【元のポスト・メモ】
${PLACEHOLDER}`;

// ===== 文字数（X の重み付け：全角2・半角1・URL23） =====
function xLength(s) {
  s = String(s || "");
  const urlRe = /https?:\/\/\S+/g;
  let n = (s.match(urlRe) || []).length * 23;
  s = s.replace(urlRe, "");
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}
const zen = (s) => Math.ceil(xLength(s) / 2);

// ===== Claude API =====
async function askClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      mcp_servers: MCP,
    }),
  });
  if (!res.ok) throw new Error(`Claude APIの呼び出しに失敗しました（${res.status}）`);
  const data = await res.json();
  const texts = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  for (let i = texts.length - 1; i >= 0; i--) {
    const parsed = tryParse(texts[i]);
    if (parsed) return parsed;
  }
  throw new Error("AIの返答をJSONとして読み取れませんでした");
}
function tryParse(text) {
  const clean = String(text).replace(/```json|```/g, "");
  const s = clean.indexOf("{");
  const e = clean.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(clean.slice(s, e + 1));
  } catch {
    return null;
  }
}

const JSON_ONLY = "最終的な返答はJSONオブジェクト1つだけにしてください。前置き・説明・コードブロック記号は書かないでください。文中の改行は \\n で表してください。";

const CONTEXT_STEPS = (item) => `次の手順でNotionの情報を集めてください。
1. Notionのデータソース ${DS.set}（自動ポスト設定）の全行を取得する。「キー」が template / regenAlways / patterns / accounts の行の「値」はJSON文字列なので、デコードして使う。template の行が無いときは、下の【既定テンプレート】を使う。
2. accounts（配列）の中から name が「${item.account || "（未選択）"}」のものを探す。見つかって、その template が空でなければ共通の template の代わりに使う。regenAlways も同じく、アカウントの値が空でなければそちらを使う。見つからなければ共通の設定を使う。
3. 生成ポスト①のページ ${item.url} を取得し、その「元ネタ」リレーション先のページ（データソース ${DS.src}）を取得して「本文抜粋」と「メモ」を読む。
4. テンプレート中の「${PLACEHOLDER}」を、本文抜粋とメモに置き換えたものを今回の指示とする。2で見つけたアカウントの persona が空でなければ、【このアカウントのペルソナ・追加指示】として指示の最後に加え、文体・立場・口調をそれに合わせる。

【既定テンプレート】
${DEFAULT_TEMPLATE}`;

function promptQueue() {
  return `Notionのデータソース ${DS.gen}（生成ポスト①）から、「状態」が「空」または「再生成」のページを、更新日時の新しい順に最大15件取得してください。
各ページについて、ページID（ハイフン付きUUID）、ページURL、タイトル、状態、アカウント（無ければ空文字）、再生成対象（マルチセレクトの値の配列。無ければ空配列）、再生成指示P1〜P3（無ければ空文字）を返してください。
${JSON_ONLY}
形式：{"items":[{"id":"","url":"","title":"","status":"空","account":"","targets":[],"regen":{"P1":"","P2":"","P3":""}}]}`;
}

function promptGenerate(item, n, extra) {
  return `${CONTEXT_STEPS(item)}

作業：今回の指示に従い、パターン${n}の1案（1ポスト目と2ポスト目）だけを作成してください。他のパターンは作りません。文字数の要件を必ず守ってください。${extra ? `\n今回だけの追加指示：${extra}` : ""}
${JSON_ONLY}
形式：{"name":"settings の patterns にあるパターン${n}の名前（無ければ空文字）","p1":"1ポスト目","p2":"2ポスト目"}`;
}

function promptRegenFromNotion(item, n) {
  return `${CONTEXT_STEPS(item)}
5. 同じページの「P${n}-1」「P${n}-2」「再生成指示P${n}」「再生成対象」を読む。

作業：パターン${n}について、再生成対象に含まれるポストだけを、再生成指示P${n}と2で決めた regenAlways に従って作り直してください。再生成対象に含まれないポストは、いまの文面を1文字も変えずにそのまま返してください。文字数の要件を必ず守ってください。
${JSON_ONLY}
形式：{"name":"パターン${n}の名前（無ければ空文字）","p1":"1ポスト目","p2":"2ポスト目"}`;
}

function promptKeep(item, n) {
  return `Notionのページ ${item.url} を取得し、プロパティ「P${n}-1」「P${n}-2」の値を1文字も変えずに返してください。また、データソース ${DS.set} の「キー」が patterns の行の「値」（JSON文字列）から、パターン${n}の名前を読んでください。
${JSON_ONLY}
形式：{"name":"パターン${n}の名前（無ければ空文字）","p1":"","p2":""}`;
}

function promptRegenLocal(item, n, cur, target, ins) {
  const which = target === "1" ? "1ポスト目だけ" : target === "2" ? "2ポスト目だけ" : "1ポスト目と2ポスト目の両方";
  return `${CONTEXT_STEPS(item)}

いまのパターン${n}の文面：
1ポスト目：${JSON.stringify(cur.p1)}
2ポスト目：${JSON.stringify(cur.p2)}

作業：今回の指示を前提に、パターン${n}の${which}を作り直してください。作り直さないポストは、いまの文面を1文字も変えずに返してください。2で決めた regenAlways にも従い、文字数の要件を必ず守ってください。
作り直しの指示：${ins || "（特になし。より良い表現に）"}
${JSON_ONLY}
形式：{"name":"パターン${n}の名前（無ければ空文字）","p1":"1ポスト目","p2":"2ポスト目"}`;
}

function promptRegister(item, pats) {
  const values = {
    "P1-1": pats[1].p1, "P1-2": pats[1].p2,
    "P2-1": pats[2].p1, "P2-2": pats[2].p2,
    "P3-1": pats[3].p1, "P3-2": pats[3].p2,
  };
  return `Notionのページ ${item.url}（データソース ${DS.gen}）のプロパティを更新してください。
- 次のJSONの各キーと同じ名前のテキストプロパティに、値を1文字も変えずにそのまま書き込む：
${JSON.stringify(values, null, 2)}
- 「状態」を「生成済」にする
- 「再生成対象」を空にする
${JSON_ONLY}
形式：成功したら {"ok":true}、失敗したら {"ok":false,"error":"理由"}`;
}

// ===== 画面部品 =====
function Count({ text, range }) {
  const n = zen(text);
  const over = n > RANGES.limit;
  const inRange = n >= range.min && n <= range.max;
  const cls = over ? "text-red-700 font-bold" : inRange ? "text-green-700" : "text-gray-600";
  return (
    <span className={`text-xs ${cls}`}>
      {n}字{over ? `（上限${RANGES.limit}超）` : `（目安${range.min}〜${range.max}）`}
    </span>
  );
}

function StatusBadge({ status }) {
  const cls = status === "再生成" ? "bg-orange-100 text-orange-900" : "bg-gray-200 text-gray-800";
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cls}`}>{status}</span>;
}

const emptyPattern = () => ({ p1: "", p2: "", name: "", loading: false, error: "", target: "both", ins: "" });

export default function App() {
  const [queue, setQueue] = useState([]);
  const [filter, setFilter] = useState("all");
  const [accFilter, setAccFilter] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [work, setWork] = useState({}); // id -> { extra, pats:{1,2,3}, registering, done }
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [batch, setBatch] = useState(null); // { current, total }
  const [message, setMessage] = useState({ text: "", error: false });

  const selected = queue.find((q) => q.id === selectedId) || null;
  const w = (selected && work[selected.id]) || { extra: "", pats: { 1: emptyPattern(), 2: emptyPattern(), 3: emptyPattern() } };
  const accounts = [...new Set(queue.map((q) => q.account || ""))];
  const byAcc = queue.filter((q) => !accFilter || (q.account || "") === accFilter);
  const shown = byAcc.filter((q) => filter === "all" || q.status === filter);
  const anyLoading = [1, 2, 3].some((n) => w.pats[n].loading);
  const ready = [1, 2, 3].every((n) => w.pats[n].p1 && w.pats[n].p2);

  const say = (text, error = false) => setMessage({ text, error });

  const updWork = (id, fn) =>
    setWork((prev) => {
      const base = prev[id] || { extra: "", pats: { 1: emptyPattern(), 2: emptyPattern(), 3: emptyPattern() } };
      return { ...prev, [id]: fn(base) };
    });
  const updPat = (id, n, patch) => updWork(id, (b) => ({ ...b, pats: { ...b.pats, [n]: { ...b.pats[n], ...patch } } }));

  async function loadQueue() {
    setLoadingQueue(true);
    say("Notionから生成待ちを取得しています…");
    try {
      const res = await askClaude(promptQueue());
      const items = (res.items || []).filter((i) => i && i.url && (i.status === "空" || i.status === "再生成"));
      setQueue(items);
      if (!items.find((i) => i.id === selectedId)) setSelectedId(items[0] ? items[0].id : null);
      say(items.length ? `${items.length}件の生成待ちがあります` : "生成待ちはありません");
    } catch (e) {
      say(e.message, true);
    } finally {
      setLoadingQueue(false);
    }
  }

  async function runPattern(item, n, promptText) {
    updPat(item.id, n, { loading: true, error: "" });
    try {
      const r = await askClaude(promptText);
      if (typeof r.p1 !== "string" || typeof r.p2 !== "string") throw new Error("1ポスト目・2ポスト目が返ってきませんでした");
      const patch = { p1: r.p1.trim(), p2: r.p2.trim(), name: r.name || FALLBACK_NAMES[n - 1], loading: false };
      updPat(item.id, n, patch);
      return patch;
    } catch (e) {
      updPat(item.id, n, { loading: false, error: e.message });
      throw e;
    }
  }

  async function generateAll(item, extra) {
    const jobs = [1, 2, 3].map((n) => {
      if (item.status === "再生成") {
        const targeted = (item.targets || []).some((t) => t.startsWith(`P${n}-`));
        return runPattern(item, n, targeted ? promptRegenFromNotion(item, n) : promptKeep(item, n));
      }
      return runPattern(item, n, promptGenerate(item, n, extra));
    });
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) throw new Error(`${failed}パターンの生成に失敗しました。カードの「再生成」でやり直せます`);
    return { 1: results[0].value, 2: results[1].value, 3: results[2].value };
  }

  async function onGenerate() {
    if (!selected) return;
    say("3パターンを生成しています…");
    try {
      await generateAll(selected, w.extra.trim());
      say("生成しました。内容を確認してNotionに登録してください");
    } catch (e) {
      say(e.message, true);
    }
  }

  async function onRegenOne(n) {
    const p = w.pats[n];
    if (!p.p1 && !p.p2) {
      say("先に生成してください", true);
      return;
    }
    say(`パターン${n}を作り直しています…`);
    try {
      await runPattern(selected, n, promptRegenLocal(selected, n, p, p.target === "both" ? "both" : p.target, p.ins.trim()));
      say(`パターン${n}を作り直しました`);
    } catch (e) {
      say(e.message, true);
    }
  }

  async function register(item, pats) {
    const over = [1, 2, 3].flatMap((n) => [pats[n].p1, pats[n].p2]).some((t) => zen(t) > RANGES.limit);
    if (over) throw new Error(`上限${RANGES.limit}字を超えているポストがあります。編集か再生成をしてください`);
    updWork(item.id, (b) => ({ ...b, registering: true }));
    try {
      const r = await askClaude(promptRegister(item, pats));
      if (!r.ok) throw new Error(r.error || "Notionへの登録に失敗しました");
      setQueue((q) => q.filter((x) => x.id !== item.id));
      updWork(item.id, (b) => ({ ...b, registering: false, done: true }));
    } catch (e) {
      updWork(item.id, (b) => ({ ...b, registering: false }));
      throw e;
    }
  }

  async function onRegister() {
    if (!selected) return;
    say("Notionに登録しています…");
    try {
      const title = selected.title;
      await register(selected, w.pats);
      const next = queue.find((q) => q.id !== selected.id);
      setSelectedId(next ? next.id : null);
      say(`「${title}」を生成済にしました`);
    } catch (e) {
      say(e.message, true);
    }
  }

  async function onBatch() {
    const items = shown.slice();
    if (!items.length) return;
    let ok = 0;
    const errors = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setBatch({ current: i + 1, total: items.length });
      setSelectedId(item.id);
      try {
        const pats = await generateAll(item, "");
        await register(item, pats);
        ok++;
      } catch (e) {
        errors.push(`${item.title}：${e.message}`);
      }
    }
    setBatch(null);
    say(errors.length ? `${ok}件を登録、${errors.length}件は失敗しました。${errors.join(" ／ ")}` : `${ok}件をすべて生成済にしました`, errors.length > 0);
  }

  const busy = loadingQueue || !!batch;

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold px-2 py-1 rounded bg-gray-900 text-white">claude.ai</span>
          <h1 className="text-lg font-bold">AI生成ワークベンチ</h1>
          <span className="text-xs text-gray-600">状態「空」「再生成」を生成</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={loadQueue} disabled={busy} className="h-10 px-4 rounded-lg border border-gray-300 bg-white text-sm disabled:opacity-50">
            {loadingQueue ? "取得中…" : "Notionから取得"}
          </button>
          <button onClick={onBatch} disabled={busy || !shown.length} className="h-10 px-4 rounded-lg bg-blue-700 text-white text-sm font-bold disabled:opacity-50">
            {batch ? `まとめて生成中 ${batch.current}/${batch.total}` : "表示中をまとめて生成・登録"}
          </button>
        </div>
      </header>

      {message.text && (
        <div role="status" className={`mx-4 mt-3 px-3 py-2 rounded-lg text-sm ${message.error ? "bg-red-100 text-red-900" : "bg-blue-50 text-blue-900"}`}>
          {message.text}
        </div>
      )}

      <div className="flex flex-wrap gap-4 p-4">
        <aside className="w-full md:w-72 flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-bold">生成キュー</h2>
            <span className="text-xs text-gray-600">{queue.length}件</span>
          </div>
          {accounts.length > 1 && (
            <label className="flex flex-col gap-1 text-xs text-gray-600">
              アカウント
              <select value={accFilter} onChange={(e) => setAccFilter(e.target.value)} disabled={!!batch}
                className="h-10 px-2 border border-gray-300 rounded-lg text-sm bg-white text-gray-900">
                <option value="">すべて（{queue.length}）</option>
                {accounts.map((a) => (
                  <option key={a || "none"} value={a}>{a || "アカウント未選択"}（{queue.filter((q) => (q.account || "") === a).length}）</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex gap-2">
            {[["all", "すべて"], ["空", "空"], ["再生成", "再生成"]].map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k}
                className={`h-9 px-3 rounded-full text-xs border ${filter === k ? "bg-gray-900 text-white border-gray-900" : "bg-white border-gray-300"}`}>
                {label} {k === "all" ? "" : byAcc.filter((q) => q.status === k).length}
              </button>
            ))}
          </div>
          {!queue.length && <p className="text-xs text-gray-600 py-2">「Notionから取得」を押すと、生成待ちの投稿が並びます。</p>}
          {shown.map((q) => (
            <button key={q.id} onClick={() => setSelectedId(q.id)} disabled={!!batch}
              className={`text-left p-3 rounded-lg bg-white flex flex-col gap-1 ${q.id === selectedId ? "border-2 border-blue-700" : "border border-gray-200"}`}>
              <span className="flex items-center gap-2"><StatusBadge status={q.status} /><span className="text-xs text-gray-600">{q.account || "アカウント未選択"}</span></span>
              <span className="text-sm font-medium">{q.title || "(無題)"}</span>
              {q.status === "再生成" && <span className="text-xs text-gray-600">対象：{(q.targets || []).join("・") || "未指定"}</span>}
            </button>
          ))}
        </aside>

        <main className="flex-1 min-w-0 flex flex-col gap-4">
          {!selected ? (
            <div className="bg-white border border-gray-200 rounded-xl p-6 text-sm text-gray-600">左の一覧から投稿を選んでください。</div>
          ) : (
            <>
              <section className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold">{selected.title || "(無題)"}</h2>
                    <div className="text-xs text-gray-600">{selected.account ? `${selected.account} のペルソナ・指示で生成します` : "アカウント未選択のため共通の指示で生成します"}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={selected.status} />
                    <a href={selected.url} target="_blank" rel="noreferrer" className="text-sm text-blue-700 underline">Notionで開く</a>
                  </div>
                </div>
                {selected.status === "再生成" ? (
                  <div className="text-sm bg-orange-50 text-orange-900 rounded-lg p-3 flex flex-col gap-1">
                    <span className="font-bold">再生成の依頼：{(selected.targets || []).join("・") || "対象未指定"}</span>
                    {[1, 2, 3].map((n) => selected.regen && selected.regen[`P${n}`] ? <span key={n}>パターン{n}：{selected.regen[`P${n}`]}</span> : null)}
                    <span className="text-xs">対象外のパターンはNotionの文面をそのまま読み込みます。</span>
                  </div>
                ) : (
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-bold">今回だけの追加指示（任意）</span>
                    <textarea rows={2} value={w.extra} placeholder="例：今回は季節感を入れて"
                      onChange={(e) => updWork(selected.id, (b) => ({ ...b, extra: e.target.value }))}
                      className="p-2 border border-gray-300 rounded-lg" />
                  </label>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-gray-600">指示はNotionの「自動ポスト設定」から読みます（アカウント別の指示があればそちらを優先）</span>
                  <span className="flex-1" />
                  <button onClick={onGenerate} disabled={anyLoading || busy || w.registering}
                    className="h-11 px-5 rounded-lg bg-blue-700 text-white text-sm font-bold disabled:opacity-50">
                    {anyLoading ? "生成中…" : selected.status === "再生成" ? "依頼どおりに再生成" : "3パターン生成"}
                  </button>
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <h2 className="text-sm font-bold">生成結果</h2>
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  {[1, 2, 3].map((n) => {
                    const p = w.pats[n];
                    return (
                      <article key={n} className="bg-white border border-gray-200 rounded-xl p-3 flex flex-col gap-2">
                        <div>
                          <div className="text-sm font-bold">パターン{n}</div>
                          <div className="text-xs text-gray-600">{p.name || FALLBACK_NAMES[n - 1]}</div>
                        </div>
                        {p.loading ? (
                          <div className="text-sm text-gray-600 py-8 text-center">作成中…</div>
                        ) : (
                          <>
                            <div className="flex justify-between items-baseline"><span className="text-xs font-bold">1ポスト目</span><Count text={p.p1} range={RANGES.p1} /></div>
                            <textarea aria-label={`パターン${n}の1ポスト目`} rows={5} value={p.p1}
                              onChange={(e) => updPat(selected.id, n, { p1: e.target.value })}
                              className="p-2 text-sm border border-gray-300 rounded-lg bg-gray-50" />
                            <div className="flex justify-between items-baseline"><span className="text-xs font-bold">2ポスト目</span><Count text={p.p2} range={RANGES.p2} /></div>
                            <textarea aria-label={`パターン${n}の2ポスト目`} rows={6} value={p.p2}
                              onChange={(e) => updPat(selected.id, n, { p2: e.target.value })}
                              className="p-2 text-sm border border-gray-300 rounded-lg bg-gray-50" />
                          </>
                        )}
                        {p.error && <div className="text-xs text-red-700">{p.error}</div>}
                        <div className="flex gap-2">
                          <select aria-label={`パターン${n}の再生成対象`} value={p.target}
                            onChange={(e) => updPat(selected.id, n, { target: e.target.value })}
                            className="h-10 px-2 border border-gray-300 rounded-lg text-sm bg-white">
                            <option value="both">両方</option>
                            <option value="1">1ポスト目</option>
                            <option value="2">2ポスト目</option>
                          </select>
                          <input aria-label={`パターン${n}への再生成指示`} value={p.ins} placeholder="再生成の指示"
                            onChange={(e) => updPat(selected.id, n, { ins: e.target.value })}
                            className="flex-1 min-w-0 h-10 px-2 border border-gray-300 rounded-lg text-sm" />
                        </div>
                        <button onClick={() => onRegenOne(n)} disabled={p.loading || busy || w.registering || (!p.p1 && !p.p2)}
                          className="h-11 rounded-lg border border-gray-300 bg-white text-sm disabled:opacity-50">
                          このパターンを再生成
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>

              <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-wrap items-center justify-end gap-3">
                <span className="text-xs text-gray-600">3パターンをNotionに書き込み、状態を「生成済」にします</span>
                <button onClick={onRegister} disabled={!ready || anyLoading || busy || w.registering}
                  className="h-11 px-5 rounded-lg bg-gray-900 text-white text-sm font-bold disabled:opacity-50">
                  {w.registering ? "登録中…" : "Notionに登録（生成済へ）"}
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
