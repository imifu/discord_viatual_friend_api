import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { AppError, NotInVoiceChannelError, toUserMessage } from '../utils/errors.js';
import { joinChannel, leaveChannel, isConnected } from './voice-connection.js';
import { getRuntime, getStatus } from '../state/bridge-state.js';
import { loadConfig } from '../config/env.js';
import { startRelay, stopRelay } from '../services/bridge-service.js';
import { MAX_CLIP_SECONDS, saveRecentClip } from '../services/clip-service.js';
import { captureFrame } from '../video/screen-capture.js';

const logger = createLogger('commands');

// Issue #19 (実機フィードバック): /capが起動する応答は、通常の会話用instructionsを変更せず
// (session.updateの設定はそのまま)、response.createへその応答だけの上書きとして渡す。実機で
// 無制限応答が約30秒に達し音声出力コストが大きかったため、1文・短時間に制限する。
const SCREEN_CAP_REACTION_INSTRUCTIONS =
  '画面を見た自然な実況または感想を、日本語で1文だけ返してください。30〜50文字程度とし、画面要素を列挙した長い説明はしないでください。';

export const commandDefinitions = [
  new SlashCommandBuilder().setName('join').setDescription('あなたが参加しているボイスチャンネルにBotを参加させます'),
  new SlashCommandBuilder().setName('leave').setDescription('Botをボイスチャンネルから退出させます'),
  new SlashCommandBuilder().setName('start').setDescription('Discord <-> OpenAI Realtime API の音声中継を開始します'),
  new SlashCommandBuilder().setName('stop').setDescription('音声中継を停止します'),
  new SlashCommandBuilder()
    .setName('gpt')
    .setDescription('あなたのボイスチャンネルに参加し、そのまま音声中継を開始します(/join + /start)'),
  new SlashCommandBuilder().setName('status').setDescription('現在の中継・接続状態を表示します'),
  new SlashCommandBuilder()
    .setName('clip')
    .setDescription('DiscordとGPTの直前のミックス音声をWAVで保存します')
    .addIntegerOption((option) =>
      option
        .setName('seconds')
        .setDescription(`保存する秒数 (既定: ${MAX_CLIP_SECONDS}秒)`)
        .setMinValue(5)
        .setMaxValue(MAX_CLIP_SECONDS),
    ),
  new SlashCommandBuilder()
    .setName('airprompt')
    .setDescription('現在Realtimeセッションに設定されている性格プロンプト(instructions)を表示します'),
  new SlashCommandBuilder()
    .setName('cap')
    .setDescription('今見えてる光景はこんなかんじ！')
    // 実行者は引き続きサーバー管理権限を持つメンバーに限定する(Bot動作PCの画面を誰でも
    // キャプチャできてしまわないようにするため)。結果はチャンネルへ公開投稿されるため、
    // 実行できる人を絞ることが唯一の安全弁になる(サーバーの「統合」設定から上書き可能)。
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((builder) => builder.toJSON());

type Handler = (interaction: ChatInputCommandInteraction) => Promise<void>;

async function handleJoin(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  if (!channel) {
    throw new NotInVoiceChannelError();
  }
  await interaction.deferReply();
  await joinChannel(channel);
  await interaction.editReply(`AIが「${channel.name}」に参加しました！`);
}

async function handleLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await interaction.deferReply();

  const left = await leaveChannel(guildId);
  await interaction.editReply(left ? 'ボイスチャンネルから退出しました。' : 'Botはボイスチャンネルに参加していません。');
}

async function handleChatgpt(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  if (!channel) {
    throw new NotInVoiceChannelError();
  }
  const guildId = interaction.guildId!;
  await interaction.deferReply();
  await joinChannel(channel);
  await startRelay(guildId, interaction.client);
  await interaction.editReply(`「${channel.name}」に参加し、音声中継を開始しました。`);
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await interaction.deferReply();
  await startRelay(guildId, interaction.client);
  await interaction.editReply('OpenAI Realtime APIに接続しました。音声中継を開始します。');
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const status = getStatus(guildId);
  await interaction.deferReply();
  if (!status.relayRunning) {
    await interaction.editReply('中継は開始されていません。');
    return;
  }
  await stopRelay(guildId);
  await interaction.editReply('音声中継を停止しました。');
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const status = getStatus(guildId);
  const config = loadConfig();

  const lines = [
    `VC接続状態: ${isConnected(guildId) ? '接続中' : '未接続'}${status.voiceChannelId ? ` (channel: ${status.voiceChannelId})` : ''}`,
    `中継状態: ${status.relayRunning ? '実行中' : '停止中'}`,
    `OpenAI Realtime API: ${status.realtimeConnected ? '接続中' : '未接続'} (model=${config.openai.model}, voice=${config.openai.voice})`,
    `GPT発話状態: ${status.gptSpeaking ? '発話中' : '待機中'}`,
    `賢い割り込み: ${!config.bargeIn.enabled ? '無効' : status.bargeInActive ? '割り込み中' : '待機中'}`,
    `クリップ用60秒バッファ: ${status.clipBufferRunning ? '記録中' : '停止'}`,
    `空気読みプロンプト: ${config.airReading.enabled ? '有効' : '無効'}`,
    `エラー状態: ${status.lastError ? `${status.lastError} (${status.lastErrorAt?.toISOString()})` : 'なし'}`,
  ];

  await interaction.reply(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
}

async function handleClip(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const seconds = interaction.options.getInteger('seconds') ?? MAX_CLIP_SECONDS;
  await interaction.deferReply();
  const clip = await saveRecentClip(guildId, seconds);
  await interaction.editReply({
    content: `直前${clip.durationSeconds.toFixed(1)}秒のDiscord + GPT音声です。`,
    files: [clip.filePath],
  });
}

async function handleCap(interaction: ChatInputCommandInteraction): Promise<void> {
  // Issue #17: ユーザー要望により、実行チャンネルへ見える通常メッセージとして投稿する
  // (ephemeralにはしない)。実行者をManageGuild権限保持者に限定していることが、
  // Bot動作PCの画面(ゲーム画面以外の通知・別ウィンドウ等を含みうる)を守る唯一の制御になる。
  await interaction.deferReply();
  const guildId = interaction.guildId!;
  const { video } = loadConfig();
  const jpeg = await captureFrame({ deviceName: video.captureDevice });

  // Issue #19 (Issue #6 Step 2、実機レビュー対応): 画像はキャプチャでき次第すぐ投稿する。
  // appendImage()/requestResponseWhenIdle()のAPI確認(最大数秒)を待ってから投稿すると、その分
  // 画像の表示自体が遅れてしまう(Codexレビューで指摘)ため、Discordへの返信とRealtime APIへの
  // 送信確認を切り離した。
  const session = getRuntime(guildId).realtimeSession;
  const content = session
    ? '今見えてる光景を送るよ！こんなかんじです！(AIにも送ったよ)'
    : '今見えてる光景を送るよ！こんなかんじです！(/startしてないから、AIにはまだ送ってないよ)';
  await interaction.editReply({
    content,
    files: [{ attachment: jpeg, name: 'cap.jpg' }],
  });
  if (!session) return;

  // 画像追加とresponse.create(発話終了まで自動的に遅延・複数回のcoalesceも行う)は、
  // 互いのAPI確認を待たずに直後に呼ぶ。WebSocketは1本の接続で送信順が保たれるため、
  // conversation.item.create → response.createの順序はappendImage()の確認を待たなくても
  // 保証される。await appendImage()してからrequestResponseWhenIdle()を呼ぶ形だと、その間に
  // 発話終了のタイミングを逃してcoalesceが効かず、応答が2回に分かれる不具合があった
  // (Codexレビューで発覚)。
  const appendOutcome = session.appendImage(jpeg, video.captureDetail);
  // accepted: response.createが受理され開始したことの確認。completed: その応答が実際に
  // 完了(または途中終了)したことの確認。response.createdの受理確認だけでは、その後failed/
  // incompleteになった場合を見落とすため、response.doneのstatusまで見て区別する
  // (Codexレビューで指摘)。
  const { accepted, completed } = session.requestResponseWhenIdle({
    instructions: SCREEN_CAP_REACTION_INSTRUCTIONS,
    maxOutputTokens: video.reactionMaxOutputTokens,
  });

  // いずれかの失敗を検知した場合のみフォローアップで訂正する(成功時は音声応答そのものが
  // 確認になるため、追加のメッセージは送らない)。
  void appendOutcome.catch((err: unknown) => {
    logger.warn(`/cap: 画像追加がAPI側で拒否されました: guild=${guildId}`, err);
    void interaction.followUp('さっき送った画像、AIには届かなかったみたい…ごめんね').catch(() => undefined);
  });
  void accepted.catch((err: unknown) => {
    logger.warn(`/cap: 応答要求がAPI側で拒否されました: guild=${guildId}`, err);
    void interaction.followUp('さっき送った画像、反応できなかったみたい…ごめんね').catch(() => undefined);
  });
  void completed.catch((err: unknown) => {
    logger.warn(`/cap: 応答の生成が失敗しました: guild=${guildId}`, err);
    void interaction.followUp('さっき送った画像への反応が途中で失敗しちゃったみたい…ごめんね').catch(() => undefined);
  });
}

async function handleAirPrompt(interaction: ChatInputCommandInteraction): Promise<void> {
  const { airReading } = loadConfig();
  const content = airReading.enabled
    ? `現在OpenAI Realtime APIのセッションに自動設定されている性格プロンプトです(手動での貼り付けは不要です)。\n\n\`\`\`text\n${airReading.prompt}\n\`\`\``
    : '空気読みモードは AIR_READING_ENABLED=false で無効になっています。';
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

const handlers: Record<string, Handler> = {
  join: handleJoin,
  leave: handleLeave,
  start: handleStart,
  stop: handleStop,
  gpt: handleChatgpt,
  status: handleStatus,
  clip: handleClip,
  airprompt: handleAirPrompt,
  cap: handleCap,
};

export async function dispatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // Temporary diagnostic for DiscordAPIError 10062 (Unknown interaction, i.e. we missed
  // Discord's ~3s ack deadline). Logged unconditionally (not just past a threshold) while this
  // is under investigation, to get exact numbers instead of a yes/no signal:
  //   - dispatchLatencyMs: time from Discord creating the interaction to us first seeing it
  //     (gateway/network delay upstream of us).
  //   - elapsed (logged in the catch block below): time from us first seeing it to the handler
  //     throwing, which includes the deferReply() REST round-trip itself (network delay
  //     downstream, to Discord). A large dispatchLatencyMs with a small elapsed points upstream;
  //     the reverse points at our own outbound request/network.
  const dispatchedAt = Date.now();
  const dispatchLatencyMs = dispatchedAt - interaction.createdTimestamp;
  logger.info(`インタラクション受信: command=${interaction.commandName} dispatchLatency=${dispatchLatencyMs}ms`);

  const handler = handlers[interaction.commandName];
  if (!handler) {
    await interaction.reply({ content: '未実装のコマンドです。', ephemeral: true });
    return;
  }

  try {
    await handler(interaction);
  } catch (err) {
    const elapsedMs = Date.now() - dispatchedAt;
    const message = toUserMessage(err);
    if (err instanceof AppError) {
      logger.warn(`コマンドエラー [${interaction.commandName}]: ${err.message} (elapsed=${elapsedMs}ms)`);
    } else {
      logger.error(`予期しないコマンドエラー [${interaction.commandName}] (elapsed=${elapsedMs}ms)`, err);
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => undefined);
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
  }
}
