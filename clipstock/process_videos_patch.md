# process_videos.py の変更 — 文字起こしに時刻を残す

アプリ側は本文の各行の頭にある `[12:34]` を読んで再生リンクを作ります。
今のスクリプトは `youtube-transcript-api` が返している開始秒を捨てているので、
そこだけ変えます。**変更は書き出し部分だけで、取得処理はそのままです。**

## 追加する関数

```python
def format_timecode(seconds: float) -> str:
    """秒を [12:34] / [1:02:03] の表記にする"""
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def build_timestamped_lines(fetched, window: int = 30, max_chars: int = 900):
    """
    セグメントをまとめて "[12:34] 本文" の行にする。

    1セグメントは2〜5秒しかないので、そのまま1行ずつ書くと本文が数百ブロックに
    膨らんで、Notionへの書き込み回数も表示も破綻する。約30秒ぶんを1行にまとめる。
    max_chars は Notion の rich_text 1件あたり2000字上限に対する余裕分。
    """
    lines = []
    start = None
    buf = []

    def flush():
        if buf:
            lines.append(f"[{format_timecode(start)}] {''.join(buf).strip()}")

    for seg in fetched:
        # 属性アクセスであることに注意(seg['text'] ではなく seg.text)
        text = seg.text.replace("\n", " ").strip()
        if not text:
            continue
        if start is None:
            start = seg.start
        over_window = seg.start - start >= window
        over_chars = sum(len(b) for b in buf) + len(text) > max_chars
        if buf and (over_window or over_chars):
            flush()
            start = seg.start
            buf = []
        buf.append(text + " ")

    flush()
    return lines
```

## 書き出し部分の差し替え

取得したあと、本文に流し込む行の作り方をこう変えます。

```python
ytt = YouTubeTranscriptApi()
fetched = ytt.fetch(video_id, languages=["ja"])

# 変更前: lines = [t.text for t in fetched]
lines = build_timestamped_lines(fetched)
```

`lines` をブロックにする部分（100件ずつ `PATCH /blocks/{id}/children` に投げている
ところ）は変えなくて大丈夫です。1行あたりの文字数が増える代わりに行数は減るので、
リクエスト回数はむしろ減ります。

## 既にある動画について

過去に取り込んだぶんには時刻が入っていません。アプリ側はそれを検知して
時刻なしとして普通に表示するので、放っておいても壊れません。

時刻を付けたい動画だけ、アプリの詳細画面の「…」から
**「文字起こしをやり直す」**（状態が「新規」に戻る）を押せば、
次回のバッチで時刻付きに入れ替わります。そのあと「すべて生成」で
分野別を作り直すと、各項目に再生リンクが付きます。

一括でやり直したい場合は、Notion側で対象の `状態` をまとめて「新規」に
変えてください。ただし全件やると `yt-dlp` と字幕取得を全部叩き直すので、
まず数本で試すことをおすすめします。

## 動作の確認

本文の1行目がこうなっていれば通っています。

```
[0:00] 今日はTransformerの仕組みを扱います。まず全体像から説明します。
```

アプリの原文タブで各行の頭に再生ボタンが出れば成功です。
出ない場合は、行頭の `[` の前に空白が入っていないか確認してください
（`[0:00]` の形でなければ時刻として読みません）。
