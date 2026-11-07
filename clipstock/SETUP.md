# ClipStock — 導入手順

動画ナレッジの画面を、書庫（`/books`）と同じ作りに組み直したものです。名前は **ClipStock**。

```
Mac mini                                web-archive (GitHub private)         ブラウザ(ClipStock)
 文字起こし(既存) ─→ Notion ──┐
                                ├─ clipstock_export.py ─→ *.age(暗号化) ─→ 読むだけ・復号は端末の中
 要約の依頼 ←─ GAS ←──────────┘                                              ↑ 一覧は Notion を叩かない
   (Gemini は GAS 側のキー)                                                    要約・メモの書き戻しだけ GAS 経由
```

- 一覧・本文・サムネは **web-archive の暗号化ファイルだけ**を読みます。Notion は叩きません（速い理由）。
- 要約とメモの書き戻しだけが GAS → Notion に行きます。Notion と Gemini のキーはブラウザに置きません。
- 一覧に並ぶのは **状態が「要約済み」のものだけ**です。

---

## 1. web-archive を作る（1回）

1. GitHub（ymatsuda2026-cloud）に **private** の `web-archive` を作る（README 付きで可）。
2. Mac に clone：
   ```sh
   git clone git@github.com:ymatsuda2026-cloud/web-archive.git ~/clipstock-archive
   ```
   cron から push するので、パスフレーズなしの SSH 鍵か、キーチェーンに入った認証が必要です。
3. ブラウザ用の **読み取り専用トークン** を作る：GitHub → Settings → Developer settings →
   Fine-grained tokens → 対象は `web-archive` だけ、Repository permissions の **Contents を Read-only**。

## 2. Mac：書き出しスクリプト

```sh
pip install --break-system-packages pyrage requests pillow     # pillow は無くても動く(サムネが大きいまま)
mkdir -p ~/scripts && cp <ダウンロードしたもの>/scripts/clipstock_export.py ~/scripts/
```

`~/.clipstock.env`（既存の `~/.video_notion_sync.env` を流用するなら `CLIPSTOCK_ENV=` で指す）：

```
NOTION_TOKEN=secret_xxxxxxxx
WEB_NOTION_TOKEN=            # web記事DBを別の統合に繋いでいるときだけ
ARCHIVE_DIR=/Users/yuya/clipstock-archive
# VIDEO_DB_ID / WEB_DB_ID は省略で既存と同じ。WEB_DB_ID= (空) にすると web を読まない
```

初回だけ鍵を作る：

```sh
/opt/homebrew/bin/python3.14 ~/scripts/clipstock_export.py --init
```

`~/.config/clipstock/key.txt` ができます。**この鍵を失うと web-archive は誰にも読めなくなります。**
パスワードマネージャ等に控えてください（GitHub には上げない）。

動作確認 → 本番：

```sh
/opt/homebrew/bin/python3.14 ~/scripts/clipstock_export.py --dry-run   # 何も書かず、やることだけ表示
/opt/homebrew/bin/python3.14 ~/scripts/clipstock_export.py             # 差分だけ書き出して push
```

2回目以降は Notion の「最終更新」が変わった分だけ書き直します（変更なしなら 0 ファイル）。
cron の例（1時間おき。文字起こしのバッチのあとに回す）：

```cron
15 * * * * /opt/homebrew/bin/python3.14 /Users/yuya/scripts/clipstock_export.py >> /Users/yuya/clipstock_export.log 2>&1
```

web-archive の中身は次のとおり（すべて age で暗号化済み）。

```
index.json.age        一覧（全件・状態つき。本文は入れない）
notes.json.age        マーカーとメモ
night.json.age        文字起こしの状況（夜間処理画面）
items/<id>.json.age   1件ぶんの本文（要約・分野別・応用・活用・マップ・文字起こし）
thumbs/<id>.jpg.age   サムネ（幅360）
```

## 3. GAS：要約の窓口

既存の動画ナレッジの GAS（`gas/Code.gs` のプロジェクト）に足します。

1. `Summarize.gs` を新しいファイルとして貼る。
2. `Code.gs` の `doPost` の `switch (body.action)` に3行を足す（`default:` の手前）：
   ```js
   case 'summarize':     result = csSummarize_(body.pageId, body.source); break;
   case 'claudePrompt':  result = csClaudePrompt_(body.pageId, body.source); break;
   case 'importSummary': result = csImportSummary_(body.pageId, body.json, body.source); break;
   ```
3. スクリプトプロパティを足す：

   | キー | 値 |
   | --- | --- |
   | `GEMINI_API_KEY` | Gemini の API キー（必須） |
   | `GEMINI_MODEL` | 省略で `gemini-2.5-flash` |
   | `APPLY_CONTEXT` | 応用の切り口。省略可。例：`受託開発・SES・保守運用の現場` |

4. デプロイ → デプロイを管理 → 編集 → **新しいバージョン**で更新（URL は変わりません）。
   既存の `NOTION_TOKEN` と `ACCESS_TOKEN` はそのまま使います。

## 4. 画面を置く

`web` リポジトリの `clipstock/` で、旧画面を退避して新しい画面を置きます。

```sh
cd web/clipstock
git mv index.html old.html          # 旧画面。src/ css/ はそのまま使えるので残す
cp <ダウンロードしたもの>/{index.html,sw.js,manifest.webmanifest,icon-192.png,icon-512.png} .
cp <ダウンロードしたもの>/gas/Summarize.gs gas/
```

GitHub Pages で `https://ymatsuda2026-cloud.github.io/web/clipstock/` を開くと、鍵の画面が出ます。

初回の登録で入れるもの：

| 項目 | 値 |
| --- | --- |
| GitHub のユーザー名 / リポジトリ | `ymatsuda2026-cloud` / `web-archive` |
| アクセストークン | 1. で作った読み取り専用トークン |
| 復号の鍵 | `~/.config/clipstock/key.txt` の `AGE-SECRET-KEY-1…` の1行 |
| 要約の窓口（GAS の URL） | 3. でデプロイした `/exec` の URL（空欄なら閲覧のみ） |
| 窓口の共有トークン | GAS の `ACCESS_TOKEN` と同じ値 |
| 合言葉 | 8文字以上。忘れたら「設定を消して最初から」で入れ直し |

トークンと鍵は合言葉（PBKDF2 60万回 → AES-GCM）で包まれ、この端末のブラウザにだけ保存されます。
登録時に「リポジトリが見えるか」「その鍵で一覧が開けるか」を確かめます。

---

## 使い方

- **種別**：帯のメニュー（動画／Web記事）。タグは表示しません（Notion 側の値は触りません）。
- **一覧**：サムネ主体。小・中・大で並べる数を変えられます。「全画面」で一覧だけを大きく。
- **本文**：サマリ・分野別・応用・活用を1つの流れで。縦書き／横書き、文字サイズ。`[mm:ss]` は動画の再生位置へ。
- **変換管理**：要約待ち（文字起こし完了）を選んで「選択を要約する」。1本あたり1〜3分。
  「Claude.ai で要約」は、プロンプトを作ってコピー → Claude.ai で実行 → 返ってきた JSON を貼って取り込み。
- **要約した直後**は、次の書き出しまでこの端末の中で反映されます（暗号化して保持。書き出しが追いつくと自動で消えます）。

## 仕様上の割り切り

- **新しいマーカーを引く機能は未実装**です。旧画面で引いたマーカーは、ノートに出ます。メモはこの画面から保存できます。
- **夜間処理**は、Notion の状態の変化（新規→完了→要約済み）から作っています。文字起こしの失敗そのものは
  Notion に残らないので、「24時間以上、未処理のまま」を要確認として出します。
- 要約は GAS の実行時間（6分）に収めるため、5分を過ぎると残りの段（マップ・分野別・応用・活用）を諦めます。
  その場合は画面に「◯◯は作れませんでした」と出ます。再要約で作り直せます。
- 時刻リンクは AI に答えさせず、引用を文字起こしから探して付けます。見つからなければリンクは付きません。
- 長さ（サムネの右下）は、文字起こし末尾の時刻から出した目安です。
- 生体認証（Face ID）での開錠は付けていません。

## 確認したこと / していないこと

確認済み（偽の Notion・偽の GitHub・偽の GAS に対して）：書き出しの差分動作と暗号化、鍵の登録・開錠・誤り検出、
一覧・検索・種別・全画面、本文の表示（マーカー・時刻リンク・★・非公開）、マインドマップ、文字起こし、
メモ保存、変換管理（要約・Claude.ai 取り込み・失敗の表示）、ノート・記録・夜間処理、オフライン、
金庫とキャッシュに平文が残らないこと、Chromium での横書き・縦書き・スマホ幅の見た目。

**未確認**：実際の Notion・GAS・Gemini・GitHub に繋いだ通し（手元に認証情報が無いため）、
iOS Safari での縦書き、Service Worker の実機での更新挙動。最初は `--dry-run` と1〜2件の要約から試してください。
