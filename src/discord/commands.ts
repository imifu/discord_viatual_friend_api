import {
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { AppError, NotInVoiceChannelError, toUserMessage } from '../utils/errors.js';
import { joinChannel, leaveChannel, isConnected } from './voice-connection.js';
import { getStatus } from '../state/bridge-state.js';
import { loadConfig } from '../config/env.js';
import { listDevices, formatDeviceList } from '../audio/device-list.js';
import { startRelay, stopRelay } from '../services/bridge-service.js';
import { MAX_CLIP_SECONDS, saveRecentClip } from '../services/clip-service.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const logger = createLogger('commands');

const DISCORD_MESSAGE_LIMIT = 1900;

export const commandDefinitions = [
  new SlashCommandBuilder().setName('join').setDescription('あなたが参加しているボイスチャンネルにBotを参加させます'),
  new SlashCommandBuilder().setName('leave').setDescription('Botをボイスチャンネルから退出させます'),
  new SlashCommandBuilder().setName('start').setDescription('Discord <-> ChatGPT Live の音声中継を開始します'),
  new SlashCommandBuilder().setName('stop').setDescription('音声中継を停止します'),
  new SlashCommandBuilder()
    .setName('gpt')
    .setDescription('あなたのボイスチャンネルに参加し、そのまま音声中継を開始します(/join + /start)'),
  new SlashCommandBuilder().setName('devices').setDescription('利用可能な音声入出力デバイスの一覧を表示します'),
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
    .setDescription('ChatGPT Liveへ設定する空気読みモード用プロンプトを表示します'),
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

async function handleDevices(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const result = await listDevices();
  const text = formatDeviceList(result);
  console.log(text);

  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    await interaction.editReply(`\`\`\`\n${text}\n\`\`\``);
    return;
  }

  const dir = join(process.cwd(), 'tmp');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `devices-${Date.now()}.txt`);
  await writeFile(filePath, text, 'utf8');
  logger.info(`デバイス一覧が長いためファイルに保存しました: ${filePath}`);
  await interaction.editReply({
    content: '一覧が長いためファイルとして出力しました(コンソールにも出力済みです)。',
    files: [filePath],
  });
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await interaction.deferReply();
  await startRelay(guildId, interaction.client);
  await interaction.editReply('DiscordとGPTを接続しました。音声中継を開始します。');
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
    `入力デバイス (GPT_TO_DISCORD_DEVICE): ${status.inputDeviceName ?? config.devices.gptToDiscord ?? '(未設定)'}`,
    `出力デバイス (DISCORD_TO_GPT_DEVICE): ${status.outputDeviceName ?? config.devices.discordToGpt ?? '(未設定)'}`,
    `出力(Discord→GPT, RtAudio/WASAPI): ${status.outboundAudioRunning ? '起動中' : '停止'}`,
    `入力(GPT→Discord, RtAudio/WASAPI): ${status.inboundAudioRunning ? '起動中' : '停止'}`,
    `GPT発話状態: ${status.gptSpeaking ? '発話中' : '待機中'}`,
    `Discord入力ゲート: ${status.discordInputGateOpen ? '開放' : '閉鎖/減衰中'}`,
    `賢い割り込み: ${!config.bargeIn.enabled ? '無効' : status.bargeInActive ? '割り込み中' : '待機中'} ` +
      `(threshold=${config.bargeIn.voiceThreshold}, attack=${config.bargeIn.attackMs}ms, release=${config.bargeIn.releaseMs}ms)`,
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

async function handleAirPrompt(interaction: ChatInputCommandInteraction): Promise<void> {
  const { airReading } = loadConfig();
  const content = airReading.enabled
    ? `ChatGPT Liveの指示へ設定してください。\n\n\`\`\`text\n${airReading.prompt}\n\`\`\``
    : '空気読みモードは AIR_READING_ENABLED=false で無効になっています。';
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

const handlers: Record<string, Handler> = {
  join: handleJoin,
  leave: handleLeave,
  start: handleStart,
  stop: handleStop,
  gpt: handleChatgpt,
  devices: handleDevices,
  status: handleStatus,
  clip: handleClip,
  airprompt: handleAirPrompt,
};

export async function dispatchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const handler = handlers[interaction.commandName];
  if (!handler) {
    await interaction.reply({ content: '未実装のコマンドです。', ephemeral: true });
    return;
  }

  try {
    await handler(interaction);
  } catch (err) {
    const message = toUserMessage(err);
    if (err instanceof AppError) {
      logger.warn(`コマンドエラー [${interaction.commandName}]: ${err.message}`);
    } else {
      logger.error(`予期しないコマンドエラー [${interaction.commandName}]`, err);
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => undefined);
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
    }
  }
}
