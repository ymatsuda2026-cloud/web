# 議事録 v2（第1段階）

ClipStock と同じ作りで、議事録を暗号化して GitHub の private リポジトリに保管します。
権限コードでログインし、閲覧できるグループの議事録だけが開けます。

## 中身

| フォルダ | 置き場所 | 役割 |
|---|---|---|
| `web/` | `ymatsuda-cmyk/tools` の `minutes2/`（GitHub Pages） | アプリ本体（一覧・詳細・変換管理・登録・設定） |
| `gas/Code.gs` | 新しい GAS プロジェクト（今の minutes の GAS とは別） | ログイン、音声の中継、暗号化済みデータの書き込み |
| `mac/` | Mac mini | 鍵の準備（`setup_keys.py`）、5分おきの監視（`minutes_worker.py`） |
| `skill/minutes2-claude-summarizer/` | Claude.ai のスキル | 要約待ちを Claude.ai で要約して Notion に書く |

データ用リポジトリ（例：`ymatsuda-cmyk/minutes-data`、private）に置かれるもの：

| ファイル | 中身 |
|---|---|
| `index.json` | 一覧：ID・日時・長さ・状態・登録元、会議の鍵（グループ公開鍵で包んだもの）、暗号化したタイトルとタグ |
| `pub.json` | グループの公開鍵（秘密ではない） |
| `m/<ID>/t.json` `s.json` `n.json` | 文字起こし・要約・メモ（すべて会議の鍵で暗号化） |
| `worker.json` | Mac の最終確認時刻 |

## 準備（初回だけ）

### 1. GitHub
1. private リポジトリ `minutes-data` を作る（空のままでよい）。
2. fine-grained トークンを2つ作る。どちらも対象は `minutes-data` だけ。
   - 書き込み用：Contents = Read and write（Mac と GAS が使う）
   - 読み取り用：Contents = Read-only（鍵束に入れて各端末へ配る）

### 2. jsonbin
アカウントを作り、Master Key を控える（鍵束の置き場。中身は権限コードで暗号化します）。

### 3. Mac：鍵を作る
```sh
mkdir -p ~/.minutes2 && cp mac/.env.example ~/.minutes2/.env && chmod 600 ~/.minutes2/.env
# .env を書く（GH_*・JSONBIN_KEY・DRIVE_DIR など）
python3 -m venv ~/.minutes2/venv && ~/.minutes2/venv/bin/pip install -r mac/requirements.txt
cd mac && ~/.minutes2/venv/bin/python setup_keys.py init --roles jba,kijun,xYz
```
- `--roles` には今の権限（role）をそのまま並べます。管理者 `xYz` は必須です。
- 終わると「GAS のスクリプトプロパティ」と「新しい権限コード」が表示されます。
  **権限コードはこの画面でしか表示されません。** 各グループの人に安全な方法で渡してください。
- 表示された `JSONBIN_BIN_ID` を `.env` にも書き足します。
- `~/.minutes2/keys.json` に全グループの秘密鍵が入ります。この Mac の外に出さないでください（Time Machine 等の暗号化バックアップは可）。

### 4. GAS
1. 新しいプロジェクトを作り、`gas/Code.gs` を貼る。
2. プロジェクトの設定 → スクリプト プロパティに、手順3で表示された値と次を入れる。
   `JSONBIN_KEY` `GH_TOKEN`（書き込み用）`GH_OWNER` `GH_REPO` `GH_BRANCH` `AUDIO_FOLDER_ID`（音声の受付フォルダの ID）
3. デプロイ → ウェブアプリ（実行ユーザー：自分、アクセス：全員）。初回に Drive の許可を求められます。
4. 表示された URL（…/exec）を `web/src/config.js` の `GAS_URL` に入れる。

### 5. アプリ
`web/` の中身を `tools` リポジトリの `minutes2/` に置いて push。`https://ymatsuda-cmyk.github.io/tools/minutes2/` で開きます。

### 6. Mac の監視
1. Google ドライブ for desktop で、音声の受付フォルダを Mac に同期する（`DRIVE_DIR` に設定した場所）。
2. `mac/com.minutes2.worker.plist` のパスを書き換えて `~/Library/LaunchAgents/` に置き、
   `launchctl load ~/Library/LaunchAgents/com.minutes2.worker.plist`
3. ログは `~/.minutes2/worker.log`。アプリの変換管理に「Mac mini 監視中」と出れば動いています。

### 7. Claude.ai で要約（使うときだけ）
1. Notion に作業DB「議事録 要約作業」を作る。プロパティ：名前（タイトル）／ID（テキスト）／状態（セレクト：要約待ち・要約済み）／メモ（テキスト）
2. Notion のインテグレーションを作ってDBに接続し、`NOTION_TOKEN` と `NOTION_DB_ID` を `.env` に書く。
3. `skill/minutes2-claude-summarizer/SKILL.md` の DB ID を書き換え、フォルダを zip にして Claude.ai のスキルに追加する。
4. アプリの設定 →「Claude.ai で要約するページ」に、使うプロジェクトのリンクを入れる。

Notion には要約待ちの文字起こしが一時的に（平文で）置かれ、要約を回収したら Mac が消します。

## 運用

| やりたいこと | 方法 |
|---|---|
| 権限コードを変える | `setup_keys.py rotate --role jba` → 表示された `CODE_HASHES` を GAS に入れる |
| グループを増やす | `setup_keys.py add-role --role eigyo`（管理者の権限コードを聞かれます） |
| 読み取りトークンを替える | `.env` を書き換えて `setup_keys.py rebuild`（全グループのコードを聞かれます） |
| 閲覧グループを変える | アプリで管理者が詳細 →「閲覧グループ」 |

## 安全のための注意
- 権限コード・ペッパー・トークンをソースやコメントに書かないでください（今の `minutes/gas/Code.gs` の `verifyCode_` のコメントは削除し、今のコードは入れ替えを）。
- 権限コードは GAS 側で鍵付きハッシュ（HMAC）にして照合します。10分に30回失敗すると、しばらくログインを止めます。
- 閲覧グループから外しても、外す前にその端末が読み込んだ内容は残ることがあります。人が抜けたときは、そのグループのコードを `rotate` してください。
- 音声ファイルは Drive の受付フォルダに暗号化せずに置かれます（ファイル名はランダムな ID）。

## 第1段階に入っていないもの（第2段階の候補）
- 今の minutes（Notion 議事録DB）からの移行スクリプト
- マインドマップ、要約の手直し編集、学習ルール、横断チャット
- 時刻を押したときの音声再生（今は文字起こしの該当行へ移動）
- 管理画面からの権限コード変更（今は Mac の `setup_keys.py`）
