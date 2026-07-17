# discord-gptlive-bridge

Discord のボイスチャンネルと OpenAI Realtime API を直接接続し、AIとの音声会話を Discord Bot として中継する Windows 専用の Discord Bot です。

以前のバージョンは Chrome 上で手動起動する ChatGPT Live を仮想オーディオケーブル経由で中継する方式でしたが、現在は **OpenAI Realtime API を直接呼び出す方式(API版)** に移行しています。Chrome・VB-CABLEなどの仮想オーディオデバイス・手動起動は不要になりました。

## 1. このアプリの目的

- Discord のボイスチャンネル(VC)参加者の音声を、OpenAI Realtime API へ直接送信する
- Realtime API の応答音声を受信し、Discord Bot として VC へ発話させる
- モデル自身の応答音声がDiscord経由で再度モデルに聞こえてしまう「ハウリング」を、割り込み検知時の再生音量ダッキングで抑制する
  (ユーザーの発話検知そのものはRealtime APIのサーバー側VADに一任しており、Discordからの送信音声をローカルで減衰・ミュートすることはない)

## 2. 全体構成図

```
[Discord VC参加者]
      │ 音声(Opus)
      ▼
┌─────────────────────────────────────────────┐
│  Discord Bot (このアプリ, Node.js/TypeScript)   │
│                                               │
│  @discordjs/voice で受信                       │
│   → prism-media で Opus→PCM デコード(ユーザー毎)  │
│   → PcmMixer で複数ユーザーをミックス             │
│   → 48kHz/2ch → 24kHz/mono へリサンプル          │
│   → 減衰・ミュートせずそのままWebSocketで送信       │
│     (モデル発話中でも常時送信。割り込み検知はAPI側)  │
└─────────────────────────────────────────────┘
      │ wss:// (OpenAI Realtime API, gpt-realtime系)
      ▼
[OpenAI Realtime API がユーザー発話を聞き取り、音声で応答]
      │ サーバー側VADがユーザー発話を検知すると応答を自動中断
      ▼
┌─────────────────────────────────────────────┐
│  Discord Bot (このアプリ)                       │
│  Realtime APIの応答音声(24kHz/mono)を受信         │
│   → 48kHz/2ch へリサンプル                      │
│   → 割り込み検知中はBARGE_IN_GPT_PLAYBACK_LEVELで  │
│     再生音量をダッキング                          │
│   → @discordjs/voice の AudioPlayer で VC へ再生  │
└─────────────────────────────────────────────┘
      │ 音声
      ▼
[Discord VC参加者(Botの発話として聞こえる)]
```

「モデルが発話中か」「ユーザーが割り込んだか」は、いずれも独自の音量しきい値判定ではなく、Realtime API自体のサーバー側VAD(ターン検出)イベントから直接取得します。

## 3. 必要ソフト

| ソフト | 用途 | 備考 |
|---|---|---|
| Node.js (v20以上) | 実行環境 | v24 で動作確認済み |
| npm | パッケージ管理 | |
| OpenAI APIキー | Realtime API利用 | [OpenAI Platform](https://platform.openai.com/) で発行。Realtime APIの利用には課金が発生します |

VB-CABLEやChromeなど、以前のバージョンで必要だった仮想オーディオデバイス・ブラウザは不要です。

## 4. Discord Botの作成方法

1. https://discord.com/developers/applications を開く
2. 「New Application」から新規アプリケーションを作成(名前は任意)
3. 左メニュー「Bot」→「Reset Token」でトークンを発行し、控えておく(**絶対に公開しない**)
4. 左メニュー「OAuth2」→「General」で「Application ID」(Client ID)を控えておく

## 5. Discord Developer Portalで必要な設定

- 「Bot」タブの「Privileged Gateway Intents」は本アプリでは**特別な特権インテントは不要**です(Message Content Intent 等は使用していません)
- 「Bot」タブで Public Bot をオフにしておくと、自分以外が招待できなくなり安全です(任意)

## 6. Botの招待方法

以下の形式の URL をブラウザで開き、対象サーバーを選んで認可してください。

```
https://discord.com/api/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3181568
```

- `<CLIENT_ID>` は手順4で控えた Application ID に置き換えてください
- `scope=bot%20applications.commands` はBot本体とスラッシュコマンドの両方に必須です
- `permissions=3181568` は 表示(View Channels)・メッセージ送信(Send Messages)・ファイル添付(Attach Files)・VC接続(Connect)・VC発話(Speak) の権限です

## 7. 必要なGateway Intents

`src/discord/client.ts` で以下のみを指定しています。

- `Guilds`
- `GuildVoiceStates`(VC参加状態の追跡に必須)

スラッシュコマンドのみを使うため `GuildMessages` や `MessageContent` などは不要です。

## 8. OpenAI APIキーの取得方法

1. https://platform.openai.com/ でアカウントを作成/ログイン
2. 「API keys」からシークレットキーを発行し、控えておく(**絶対に公開しない**)
3. Realtime APIの利用には課金設定(クレジットカード登録など)が必要です。詳細は OpenAI の料金ページを確認してください

## 9. .envの設定

`.env.example` をコピーして `.env` を作成し、値を設定してください。

```env
DISCORD_TOKEN=            # 手順3で取得したBotトークン
DISCORD_CLIENT_ID=        # 手順4で取得したApplication ID
DISCORD_GUILD_ID=         # テストに使うサーバーのID(サーバー名を右クリック→IDをコピー。開発者モードを有効にする必要あり)

OPENAI_API_KEY=            # 手順8で取得したOpenAI APIキー
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_VOICE=marin
OPENAI_VOICE_SPEED=0.8     # 再生速度倍率(0.25〜1.5、APIの既定値は1.0)

INPUT_SAMPLE_RATE=48000
INPUT_CHANNELS=2

OUTPUT_SAMPLE_RATE=48000
OUTPUT_CHANNELS=2

LOG_LEVEL=info

IDLE_TIMEOUT_MINUTES=15

BARGE_IN_ENABLED=true
BARGE_IN_GPT_PLAYBACK_LEVEL=0.2

AIR_READING_ENABLED=true
# AIR_READING_PROMPT=任意の上書きプロンプト（改行は\n）
```

`.env` は `.gitignore` 済みで、Git管理対象外です。

### 空気読みモード

`AIR_READING_ENABLED=true` の場合、`src/config/air-reading.ts` のプロンプトが Realtime セッションの `instructions` として**自動的に設定されます**。以前のバージョンと異なり、Chromeへの手動コピー&ペーストは不要です。`/airprompt` で現在設定されている内容を確認できます。`AIR_READING_PROMPT` で内容を上書きできます。

### 直前クリップ

中継中はDiscord参加者とAI応答の未減衰音声をミックスし、直近60秒だけを固定長のPCMリングバッファへ保持します。`/clip` または `/clip seconds:30` でWAVとして `clips/` に保存し、Discordへ添付します。60秒の添付サイズを抑えるため、保存時はモノラルへ変換します。INPUTとOUTPUTのサンプルレート・チャンネル数が異なる場合は無効になります。

### 賢い割り込み

`BARGE_IN_ENABLED=true` の場合、Realtime APIのサーバー側VADがユーザーの発話開始・終了を検知し、モデルの発話中にユーザーが話し始めると自動的にモデル側の応答を割り込み(truncate)します。Discordからの送信音声はモデル発話中でも常にそのままAPIへ送っており(ローカルで減衰・ミュートすることはありません)、これによりAPI側のVADが確実にユーザーの発話を検知できます。割り込みが検知されている間は、Discord側で再生するモデルの音量を `BARGE_IN_GPT_PLAYBACK_LEVEL`(0〜1)まで下げます。割り込みの検知・解除タイミングそのものはAPI側のVADに委ねているため、以前のバージョンにあった `BARGE_IN_VOICE_THRESHOLD` 等のローカルしきい値調整は不要になりました。

### 無音時の自動停止(コスト対策)

Discordからの音声は `/start` している間、誰も話していなくても常時Realtime APIへ送信され続けます(賢い割り込みの検知をAPI側のVADに委ねているため)。つまり音声入力の課金は「実際に会話した時間」ではなく「`/start`している時間」に比例します。`IDLE_TIMEOUT_MINUTES`(既定15分)を設定すると、Discord参加者・モデルのどちらもその時間発話しなかった場合に中継を自動的に `/stop` します。`/start`をつけっぱなしにして忘れた場合のコストを構造的に抑えられます。`0`にすると無効化されます。

### API使用料金の目安

OpenAI公式の料金ページ([2026年7月時点](https://platform.openai.com/docs/pricing))によると、Realtime APIの音声はモデルごとに以下の単価です(1Mトークンあたり)。

| モデル | 音声入力 | 音声出力 | 音声入力(キャッシュ) |
|---|---|---|---|
| `gpt-realtime-2.1` | $32.00 | $64.00 | $0.40 |
| `gpt-realtime-2.1-mini`(既定) | $10.00 | $20.00 | $0.30 |

音声は「入力100ms=1token(≒600 tokens/分)、出力50ms=1token(≒1,200 tokens/分)」に相当するため、`gpt-realtime-2.1-mini`では概算で**音声入力$0.006/分・音声出力$0.024/分**になります(会話品質は標準モデルより劣る可能性があるため、実際に試してから選んでください)。

`/start`している時間全体に音声入力コストがかかり、モデルが実際に発話している時間だけ音声出力コストがかかります。1時間接続してモデルが30%発話した場合の概算は、`gpt-realtime-2.1-mini`で約$0.79/時間、`gpt-realtime-2.1`で約$2.53/時間です(会話履歴のキャッシュにより実際はこれより安くなることが多いです)。正確な金額は[OpenAIの使用量ダッシュボード](https://platform.openai.com/usage)で確認してください。

## 10. インストール方法

```powershell
npm install
```

## 11. スラッシュコマンド登録方法

```powershell
npm run register
```

`DISCORD_GUILD_ID` に対してのみ登録するため、反映は数秒程度で即座に行われます(グローバル登録ではないため他サーバーには表示されません)。コマンドの内容(名前・説明)を変更した場合は再実行してください。

## 12. 起動方法

開発時(ファイル変更で自動再起動):

```powershell
npm run dev
```

本番相当(ビルドしてから起動):

```powershell
npm run build
npm start
```

終了は `Ctrl+C` です(SIGINTを受けてVC退出・中継停止・切断処理を行ってから終了します)。

## 13. 動作確認方法

1. `npm run dev` でBotを起動し、ログに `Discordログイン成功` が出ることを確認
2. Discordの対象サーバーのボイスチャンネルに参加した状態で `/join` を実行し、Botが同じVCに参加することを確認
3. `/status` で `VC接続状態: 接続中` を確認
4. `/start` を実行し、`OpenAI Realtime API: 接続中` になることを確認
5. Discordで話しかけ、AIがそれを聞き取って応答することを確認
6. AIの応答がDiscordのVC内で(Botの発話として)聞こえることを確認
7. `/status` で `GPT発話状態` がAIの発話に連動して変化することを確認
8. AIが話している途中でDiscordから話し、`/status` が `賢い割り込み: 割り込み中` になることを確認
9. `/clip seconds:30` でDiscordとAIの直前音声が添付されることを確認
10. `/airprompt` で現在設定されている性格プロンプトが表示されることを確認
11. `/stop` → `/leave` で終了

## 14. ハウリングした場合の対処方法

- Discordからの送信音声は、モデル発話中でも常にそのままRealtime APIへ送信しています(割り込み検知をAPI側のVADに委ねるため、ローカルで減衰・ミュートすることはありません)。そのため本アプリ側で減衰量を調整できるパラメータはなく、ハウリングの主な原因はDiscordクライアント側のスピーカー/マイクの音響的な回り込みです
- `BARGE_IN_GPT_PLAYBACK_LEVEL` を下げる(0.2→0.1や0)と、割り込み検知中のモデル再生音量をより強く下げられます
- 本アプリは発話検知による割り込み制御であり、完全なエコーキャンセル(AEC)ではありません。Discord側のスピーカー音量やマイク感度が高すぎるとハウリングの原因になります
- それでも改善しない場合、Discordクライアント側のエコーキャンセル・ノイズ抑制設定を確認してください

## 15. 音が聞こえない場合の確認項目

- `/status` で `中継状態: 実行中`、`OpenAI Realtime API: 接続中` になっているか
- `OPENAI_API_KEY` が正しいか、OpenAIアカウントの課金設定が有効か
- ログにエラーが出ていないか(`OpenAIConnectionError`/`OpenAISessionError` 関連のエラーが出ていないか確認してください)
- Discordクライアント側でBotの音量がミュートになっていないか

## 16. 現在の制限事項

- **Windowsのみ対応**です(Mac/Linuxは非対応。ただしAPI版では音声デバイスへの直接アクセスがなくなったため、将来的な他OS対応の障壁は下がっています)
- ハウリング対策は割り込み検知時の再生音量ダッキングのみで、**完全なエコーキャンセル(AEC)は未実装**です
- 複数ギルドでの同時運用は想定していません(1プロセスにつき実運用は1サーバー・1VCを想定。内部的にはギルドID単位で状態を保持していますが、動作確認は単一ギルドのみです)
- OpenAI Realtime APIの利用には課金が発生します。料金体系はOpenAIの公式ドキュメントを参照してください
- 「投稿して」音声トリガーによるテキスト投稿機能、会話ログの自動文字起こし機能は、旧バージョン(ローカルWhisper依存)からの移行中のため一時的に利用できません(復活作業は別途進行中)
- `Ctrl+C`(SIGINT)による終了処理は自動テストできておらず、動作確認は開発者による手動実施のみです(下記テスト手順参照)

---

## 手動テスト手順

自動化できない項目(実際のDiscord接続・OpenAI API接続が必要なもの)は、以下の手順で手動確認してください。

| # | 項目 | 手順 | 期待結果 |
|---|---|---|---|
| 1 | npm install成功 | `npm install` | エラーなく完了 |
| 2 | TypeScriptビルド成功 | `npm run build` | エラーなく `dist/` が生成される |
| 3 | 型エラーなし | `npm run typecheck` | エラーなし |
| 4 | Lintエラーなし | `npm run lint` | エラーなし |
| 5 | Discord Token未設定エラー | `.env` の `DISCORD_TOKEN` を空にして `npm start` | 「環境変数 DISCORD_TOKEN が設定されていません」と表示し終了コード1で終了 |
| 6 | OpenAI APIキー未設定エラー | `.env` の `OPENAI_API_KEY` を空にして `npm start` | 「環境変数 OPENAI_API_KEY が設定されていません」と表示し終了コード1で終了 |
| 7 | Botログイン成功 | 正しい`.env`で `npm run dev` | ログに `Discordログイン成功` |
| 8 | コマンド登録成功 | `npm run register` | ログに `スラッシュコマンド登録完了` |
| 9 | VC参加成功 | VC参加中に `/join` | Botが同じVCに参加、`/status`で接続中 |
| 10 | VC退出成功 | `/leave` | Botが退出、`/status`で未接続 |
| 11 | コマンド実行者がVC未参加 | VCに入らず `/join` | 「先にボイスチャンネルへ参加してから」エラー |
| 12 | 不正なAPIキーエラー | `.env`の`OPENAI_API_KEY`を不正な値にして`/start` | 「OpenAI Realtime APIへの接続に失敗しました」エラー、中継はロールバックされ`/status`で停止のまま |
| 13 | 音声受信開始 | `/start`後に発話 | ログに `音声受信開始: user=...` |
| 14 | 音声受信終了 | 発話をやめる | ログに `音声受信終了: user=...` |
| 15 | 中継の双方向動作 | `/start`後、Discordで発話→AIが応答 | 双方向で聞こえる(13章参照) |
| 16 | GPT発話状態の連動 | AI発話中に確認 | `/status`の`GPT発話状態`が`発話中`になる。ログに`GPT発話開始`が出力 |
| 17 | /start重複防止 | 中継中にもう一度`/start` | 「中継は既に開始されています」エラー |
| 18 | /stopの安全な終了 | 中継停止後にもう一度`/stop` | エラーにならず「中継は開始されていません」と表示 |
| 19 | Realtime API切断時の再接続 | ネットワーク切断などでWebSocketが切れる | ログに再接続試行が出力され、成功すると`/status`が`接続中`に復帰 |
| 20 | Ctrl+C時の正常終了 | `npm run dev`実行中のターミナルで`Ctrl+C` | ログに終了処理開始→VC退出→終了完了が出て、プロセスが終了する |
| 21 | 賢い割り込み | AI発話中にDiscordで発話 | `/status`が`賢い割り込み: 割り込み中`になりAI音量が下がる。発話終了後に復帰 |
| 22 | 直前クリップ | 中継開始後に`/clip seconds:30` | DiscordとAIの直前ミックス音声WAVが添付される |
| 23 | 空気読みプロンプト | `/airprompt` | Realtimeセッションに自動設定されているプロンプトが本人だけに表示される |
| 24 | 無音時の自動停止 | `IDLE_TIMEOUT_MINUTES`を短く(例: 1)設定し、`/start`後に誰も話さず待つ | 設定時間経過後、ログに「発話がなかったため中継を自動停止します」が出力され、`/status`で停止状態になる |
