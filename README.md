# discord-gptlive-bridge

Discord のボイスチャンネルと、Chrome 上で手動起動する ChatGPT Live の音声を、仮想オーディオケーブル経由で相互に中継する Windows 専用の Discord Bot です。

OpenAI API・Realtime API は一切使用しません。ChatGPT Live はユーザーが Chrome で手動起動し、音声のみを本アプリが Discord ⇔ Windows の仮想オーディオデバイス間で中継します。

## 1. このアプリの目的

- Discord のボイスチャンネル(VC)参加者の音声を、Windows の仮想オーディオデバイス経由で Chrome 上の ChatGPT Live のマイク入力へ渡す
- ChatGPT Live の応答音声を、Windows の仮想オーディオデバイス経由で取得し、Discord Bot として VC へ発話させる
- ChatGPT Live 自身の声が再度 ChatGPT Live に聞こえてしまう「ハウリング」を、半二重方式のゲート制御で防止する

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
│   → VAD Gate で ChatGPT Live 発話中は減衰/ミュート │
│     (ユーザーが割り込んだ間だけゲートを開放)          │
│   → audify(RtAudio/WASAPI)で 仮想デバイスA へ書込  │
└─────────────────────────────────────────────┘
      │ 仮想デバイスA (例: CABLE-A Input)
      ▼
[Chrome: ChatGPT Live のマイク入力 = 仮想デバイスAの録音側(CABLE-A Output)]
      │
      │  (ChatGPT Live が会話を聞き、音声で応答)
      ▼
[Chrome: ChatGPT Live の音声出力 = 仮想デバイスBの再生側(CABLE-B Input)]
      │ 仮想デバイスB (例: CABLE-B Output)
      ▼
┌─────────────────────────────────────────────┐
│  Discord Bot (このアプリ)                       │
│  audify(RtAudio/WASAPI)で 仮想デバイスB から取得   │
│   → VAD Gate が発話検知(ここでの音量が上の減衰判定に使用)│
│   → @discordjs/voice の AudioPlayer で VC へ再生  │
└─────────────────────────────────────────────┘
      │ 音声
      ▼
[Discord VC参加者(Botの発話として聞こえる)]
```

重要: 仮想デバイスは **A と B で完全に別のペア**を使います。同じケーブルを両方向に使うと、Bot自身が発した音を再度拾ってしまうループ(ハウリング)の原因になります。

## 3. 必要ソフト

| ソフト | 用途 | 備考 |
|---|---|---|
| Node.js (v20以上) | 実行環境 | v24 で動作確認済み |
| npm | パッケージ管理 | |
| VB-CABLE A+B (VB-Audio) | 仮想オーディオデバイス2組 | 無料。単体の VB-CABLE だけでは1組しか手に入らないため **A+B 版**が必要 |
| Google Chrome | ChatGPT Live 起動用 | |
| FFmpeg | 補助的な診断用途 | 本アプリ自体の音声中継処理では使用していません(理由は後述)。手動デバッグ用に入れておくと便利です |

**FFmpegについての注記**: 開発時は FFmpeg の `dshow`/`dsound` で仮想デバイスへの入出力を行う想定でしたが、実装過程で **FFmpeg にはライブ再生デバイスへ出力するマルチプレクサが存在しない**ことが判明しました(`ffmpeg -devices` で確認すると、デバイスの列は全て録音専用の `D` のみで、再生対応の `E` はありません)。そのため、実際の音声入出力は [`audify`](https://www.npmjs.com/package/audify)(RtAudio/PortAudio系のネイティブバインディング、WASAPI経由)に統一しています。FFmpeg は `/devices` コマンドやデバイス列挙処理にも使用していません。それでも FFmpeg はトラブルシューティング用の手動コマンド(19章)で使えるため、インストールしておくことを推奨します。

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

## 8. VB-CABLEまたはVoiceMeeterの設定

本アプリは **2組の独立した仮想オーディオデバイスペア**を必要とします(片方向につき1ペア)。

推奨: **VB-CABLE A+B**(https://vb-audio.com/Cable/ の "VB-CABLE A+B Virtual Audio Device" セクション)

1. ZIPをダウンロードして展開
2. `VBCABLE_ABSetup_x64.exe` を**管理者として実行**してインストール
3. 必要なら再起動

インストール後、以下の4つのデバイスが増えます。

- `CABLE-A Input (VB-Audio Virtual Cable A)` … 再生側。Discord→GPT方向の書き込み先
- `CABLE-A Output (VB-Audio Virtual Cable A)` … 録音側。Chromeのマイク入力に設定する
- `CABLE-B Input (VB-Audio Virtual Cable B)` … 再生側。Chromeの音声出力に設定する
- `CABLE-B Output (VB-Audio Virtual Cable B)` … 録音側。GPT→Discord方向の読み取り元

VoiceMeeter を使う場合も考え方は同じで、Discord→GPT用とGPT→Discord用に独立した仮想バスを2つ用意し、それぞれのデバイス名を`.env`に設定してください。

## 9. Windowsの音声デバイス設定

通常はOSのデフォルト入出力デバイスを変更する必要はありません(本アプリはデバイス名を直接指定して読み書きするため)。ただし、以下は確認してください。

- サウンドの設定でVB-CABLEの4つのデバイスが有効(無効化されていない)になっていること
- 「アプリごとの音量とデバイスの設定」(Windowsの「サウンドの詳細設定」)で、Chromeの出力/入力を明示的に指定できます。これを使うと、システム全体の既定デバイスを変更せずに済むため便利です(手順は10・11章参照)

## 10. ChromeでChatGPT Liveのマイクを仮想ケーブルAにする方法

1. ChatGPTのページでマイク許可を求められたら「CABLE-A Output (VB-Audio Virtual Cable A)」を選択
2. 既に許可済みの場合: Chromeのアドレスバー左の鍵アイコン→「サイトの設定」→マイクのデバイスを「CABLE-A Output」に変更
3. または Windows の「設定→システム→サウンド→アプリの音量とデバイスの設定」で Chrome の入力デバイスを「CABLE-A Output」に個別指定する方法でも構いません

## 11. Chromeの出力を仮想ケーブルBへ変更する方法

1. Windows の「設定→システム→サウンド→アプリの音量とデバイスの設定」を開く
2. 一覧から Chrome を探し、出力を「CABLE-B Input (VB-Audio Virtual Cable B)」に変更

これにより、Chromeで再生される音声(ChatGPT Liveの応答)だけが CABLE-B へ流れ、他のアプリの音は影響を受けません。

## 12. .envの設定

`.env.example` をコピーして `.env` を作成し、値を設定してください。

```env
DISCORD_TOKEN=            # 手順4で取得したBotトークン
DISCORD_CLIENT_ID=        # 手順4で取得したApplication ID
DISCORD_GUILD_ID=         # テストに使うサーバーのID(サーバー名を右クリック→IDをコピー。開発者モードを有効にする必要あり)

DISCORD_TO_GPT_DEVICE=CABLE-A Input (VB-Audio Virtual Cable A)
GPT_TO_DISCORD_DEVICE=CABLE-B Output (VB-Audio Virtual Cable B)

INPUT_SAMPLE_RATE=48000
INPUT_CHANNELS=2

OUTPUT_SAMPLE_RATE=48000
OUTPUT_CHANNELS=2

LOG_LEVEL=info

VOICE_ACTIVITY_THRESHOLD=0.02
GPT_SPEAKING_HOLD_MS=500
DISCORD_INPUT_DUCKING=true
DISCORD_INPUT_DUCKING_LEVEL=0.1

BARGE_IN_ENABLED=true
BARGE_IN_GPT_PLAYBACK_LEVEL=0.2
BARGE_IN_VOICE_THRESHOLD=0.025
BARGE_IN_ATTACK_MS=100
BARGE_IN_RELEASE_MS=400

AIR_READING_ENABLED=true
# AIR_READING_PROMPT=任意の上書きプロンプト（改行は\n）
```

デバイス名は `/devices` コマンド(または `npm run devices`)で表示される名前を**括弧内を含めて全文そのまま**貼り付けてください。空白や日本語が含まれていても、内部的には配列引数として安全に渡しているため問題ありません(シェル経由の文字列結合はしていません)。

`.env` は `.gitignore` 済みで、Git管理対象外です。

### 空気読みモード

`/airprompt` で、ChatGPT Liveへ設定する聞き役用プロンプトを表示できます。Chromeとの連携は音声デバイス経由なので、BotからChatGPTへプロンプトを自動注入することはできません。会話開始前にChatGPT Liveの指示へ設定してください。`AIR_READING_PROMPT` で内容を上書きできます。

### 直前クリップ

中継中はDiscord参加者とGPTの未減衰音声をミックスし、直近60秒だけを固定長のPCMリングバッファへ保持します。`/clip` または `/clip seconds:30` でWAVとして `clips/` に保存し、Discordへ添付します。文字起こしやWhisperは使用しません。60秒の添付サイズを抑えるため、保存時はモノラルへ変換します。INPUTとOUTPUTのサンプルレート・チャンネル数が異なる場合は無効になります。

### 賢い割り込み

`BARGE_IN_ENABLED=true` の場合、Discordの発話イベントで受信を開始した後、デコード済みPCMをローカルVADで再判定します。音量が `BARGE_IN_VOICE_THRESHOLD` を `BARGE_IN_ATTACK_MS` 以上連続して超えた場合だけ、GPT→Discordの再生音量を下げ、Discord→GPTゲートを開いてユーザー音声をChatGPTへ渡します。最後にしきい値を超えてから `BARGE_IN_RELEASE_MS` 後に、GPT音量と通常のゲート制御を復帰します。

クーラーなどの定常ノイズで誤反応する場合は `BARGE_IN_VOICE_THRESHOLD` を少し上げ、咳払いなど短い音で反応する場合は `BARGE_IN_ATTACK_MS` を長くしてください。上げすぎると小声や短い呼びかけを拾いにくくなるため、`0.005`・`40ms`程度ずつ調整するのが目安です。割り込み中のGPT音量は `BARGE_IN_GPT_PLAYBACK_LEVEL`（0〜1）で調整できます。

## 13. インストール方法

```powershell
npm install
```

## 14. スラッシュコマンド登録方法

```powershell
npm run register
```

`DISCORD_GUILD_ID` に対してのみ登録するため、反映は数秒程度で即座に行われます(グローバル登録ではないため他サーバーには表示されません)。コマンドの内容(名前・説明)を変更した場合は再実行してください。

## 15. 起動方法

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

## 16. 動作確認方法

1. `npm run dev` でBotを起動し、ログに `Discordログイン成功` が出ることを確認
2. Discordの対象サーバーのボイスチャンネルに参加した状態で `/join` を実行し、Botが同じVCに参加することを確認
3. `/status` で `VC接続状態: 接続中` を確認
4. Chromeで ChatGPT を開き、ChatGPT Live を開始。マイクを CABLE-A Output、出力を CABLE-B Input に設定(手順10・11)
5. `/start` を実行
6. Discordで話しかけ、ChatGPT Liveがそれを聞き取って応答することを確認
7. ChatGPT Liveの応答がDiscordのVC内で(Botの発話として)聞こえることを確認
8. `/status` で `GPT発話状態` や `Discord入力ゲート` がChatGPT Liveの発話に連動して変化することを確認
9. GPTが話している途中でDiscordから話し、GPT音量が下がって `/status` が `賢い割り込み: 割り込み中` になることを確認
10. `/clip seconds:30` でDiscordとGPTの直前音声が添付されることを確認
11. `/airprompt` で空気読み用プロンプトが表示されることを確認
12. `/stop` → `/leave` で終了

## 17. ハウリングした場合の対処方法

- まず `DISCORD_TO_GPT_DEVICE` と `GPT_TO_DISCORD_DEVICE` が**別々のデバイス**になっているか確認してください(同じデバイスを指定すると確実にループします)
- `VOICE_ACTIVITY_THRESHOLD` を上げる(例: 0.02→0.05)と、ChatGPT Liveの発話検知の感度が下がりすぎて途切れることがあります。逆に低すぎるとノイズを発話と誤検知します。環境に応じて調整してください
- `DISCORD_INPUT_DUCKING_LEVEL` を下げる(0.1→0.05や0)と、ChatGPT Live発話中のDiscord音声をより強く減衰・ミュートできます
- `GPT_SPEAKING_HOLD_MS` を長くすると、ChatGPT Liveの発話終了直後の"尾"を拾いにくくなります
- それでも改善しない場合、Chrome側のスピーカー音量やマイク感度が高すぎないか確認してください
- 本アプリは発話検知によるゲート制御であり、完全なエコーキャンセル(AEC)ではありません。賢い割り込み中は一時的に全二重になるため、仮想ケーブルの経路設定が誤っているとエコーが起きます(20章の制限事項も参照)

## 18. 音が聞こえない場合の確認項目

- `/status` で `中継状態: 実行中`、`出力`/`入力`がともに `起動中` になっているか
- `.env` のデバイス名が `/devices` の出力(括弧内含むフルネーム)と完全一致しているか
- Windowsの「サウンドの詳細設定」でVB-CABLEのデバイスがミュートになっていないか
- Chromeのマイク/出力デバイスが正しいCABLEに向いているか(10・11章)
- ChatGPT Live側が実際にマイク音声を拾えているか(ChatGPT側のマイクインジケーターを確認)
- ログにエラーが出ていないか(`FFmpeg`ではなく`RtAudio`関連のエラーが出力されます)
- 仮想デバイスが他のアプリで排他利用されていないか(排他モードで別アプリが掴んでいると `AudioStreamOpenError` になります)

## 19. FFmpegのデバイス一覧確認方法

本アプリの `/devices` コマンド(内部的には `audify` の `RtAudio.getDevices()`)が正式なデバイス一覧取得方法です。FFmpegは録音デバイスのみ以下のコマンドで手動確認できます(再生デバイスは一覧できません)。

```powershell
ffmpeg -hide_banner -f dshow -list_devices true -i dummy
```

## 20. 現在の制限事項

- **Windowsのみ対応**です(Mac/Linuxは非対応)
- ハウリング対策は半二重のゲート制御のみで、**完全なエコーキャンセル(AEC)は未実装**です
- ChatGPT Live側の発話検知(VAD)は音量ベースの簡易判定であり、環境ノイズによって誤検知する場合があります
- 複数ギルドでの同時運用は想定していません(1プロセスにつき実運用は1サーバー・1VCを想定。内部的にはギルドID単位で状態を保持していますが、動作確認は単一ギルドのみです)
- FFmpegはこのアプリの音声パイプラインでは使用していません(3章参照)。`FFmpegプロセスの状態`という表現は現在の実装では「RtAudioストリームの状態」を指します
- `Ctrl+C`(SIGINT)による終了処理は自動テストできておらず、動作確認は開発者による手動実施のみです(下記テスト手順参照)
- `npm audit` で報告される脆弱性のうち、discord.js が依存する `undici` およびaudifyのビルドフォールバック(`cmake-js`/`tar`、実行時には未使用)由来のものは、上流の対応待ちのため未修正です

---

## 手動テスト手順

自動化できない項目(実際のDiscord接続・音声デバイスが必要なもの)は、以下の手順で手動確認してください。

| # | 項目 | 手順 | 期待結果 |
|---|---|---|---|
| 1 | npm install成功 | `npm install` | エラーなく完了 |
| 2 | TypeScriptビルド成功 | `npm run build` | エラーなく `dist/` が生成される |
| 3 | 型エラーなし | `npm run typecheck` | エラーなし |
| 4 | Lintエラーなし | `npm run lint` | エラーなし |
| 5 | Discord Token未設定エラー | `.env` の `DISCORD_TOKEN` を空にして `npm start` | 「環境変数 DISCORD_TOKEN が設定されていません」と表示し終了コード1で終了 |
| 6 | Botログイン成功 | 正しい`.env`で `npm run dev` | ログに `Discordログイン成功` |
| 7 | コマンド登録成功 | `npm run register` | ログに `スラッシュコマンド登録完了` |
| 8 | VC参加成功 | VC参加中に `/join` | Botが同じVCに参加、`/status`で接続中 |
| 9 | VC退出成功 | `/leave` | Botが退出、`/status`で未接続 |
| 10 | コマンド実行者がVC未参加 | VCに入らず `/join` | 「先にボイスチャンネルへ参加してから」エラー |
| 11 | 不正なデバイス名エラー | `.env`のデバイス名を存在しない文字列にして`/start` | 「音声デバイスが見つかりません」エラー、中継はロールバックされ`/status`で停止のまま |
| 12 | デバイス未設定時のエラー | デバイス名を空にして`/start` | 「DISCORD_TO_GPT_DEVICE と GPT_TO_DISCORD_DEVICE を.envに設定してください」エラー |
| 13 | 音声受信開始 | `/start`後に発話 | ログに `音声受信開始: user=...` |
| 14 | 音声受信終了 | 発話をやめる | ログに `音声受信終了: user=...` |
| 15 | 中継の双方向動作 | `/start`後、Discordで発話→ChatGPT Liveが応答 | 双方向で聞こえる(16章参照) |
| 16 | VAD/ゲート動作 | ChatGPT Live発話中に確認 | `/status`の`GPT発話状態`が`発話中`、`Discord入力ゲート`が`閉鎖/減衰中`になる。ログに`GPT発話開始`/`Discord入力ゲート閉鎖`が出力 |
| 17 | /start重複防止 | 中継中にもう一度`/start` | 「中継は既に開始されています」エラー |
| 18 | /stopの安全な終了 | 中継停止後にもう一度`/stop` | エラーにならず「中継は開始されていません」と表示 |
| 19 | Bot切断時のプロセス終了 | Discord側からBotをVCキック、またはネットワーク切断 | ログに再接続試行、失敗時は中継停止・接続破棄 |
| 20 | Ctrl+C時の正常終了 | `npm run dev`実行中のターミナルで`Ctrl+C` | ログに終了処理開始→VC退出→終了完了が出て、プロセスが終了する |
| 21 | 賢い割り込み | GPT発話中にDiscordで発話 | GPT音量が下がり、Discord入力ゲートが開く。発話終了後に復帰 |
| 22 | 直前クリップ | 中継開始後に`/clip seconds:30` | DiscordとGPTの直前ミックス音声WAVが添付される |
| 23 | 空気読みプロンプト | `/airprompt` | ChatGPT Liveへ設定するプロンプトが本人だけに表示される |
