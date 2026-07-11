import {
  entersState,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { VoiceChannelJoinError } from '../utils/errors.js';
import { getRuntime, updateStatus, resetGuildState } from '../state/bridge-state.js';
import { stopRelay } from '../services/bridge-service.js';

const logger = createLogger('voice-connection');

const READY_TIMEOUT_MS = 15_000;
const RECONNECT_GRACE_MS = 5_000;

export async function joinChannel(channel: VoiceBasedChannel): Promise<VoiceConnection> {
  const guildId = channel.guild.id;

  const existing = getRuntime(guildId).voiceConnection;
  if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
    existing.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
  } catch (err) {
    connection.destroy();
    throw new VoiceChannelJoinError(err);
  }

  const runtime = getRuntime(guildId);
  runtime.voiceConnection = connection;
  runtime.voiceChannelId = channel.id;
  updateStatus(guildId, { connected: true, voiceChannelId: channel.id });
  logger.info(`VC参加: guild=${guildId} channel=${channel.id} (${channel.name})`);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn(`VC切断検知、再接続を試みます: guild=${guildId}`);
    updateStatus(guildId, { connected: false });
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
      ]);
      logger.info(`再接続中: guild=${guildId}`);
    } catch {
      logger.warn(`再接続に失敗したため接続を破棄します: guild=${guildId}`);
      await stopRelay(guildId).catch((err) => logger.error('中継停止中にエラー', err));
      connection.destroy();
    }
  });

  connection.on(VoiceConnectionStatus.Ready, () => {
    updateStatus(guildId, { connected: true });
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    logger.info(`VC接続破棄: guild=${guildId}`);
    updateStatus(guildId, { connected: false, voiceChannelId: undefined });
  });

  connection.on('error', (err) => {
    logger.error(`VC接続エラー: guild=${guildId}`, err);
  });

  return connection;
}

export async function leaveChannel(guildId: string): Promise<boolean> {
  const runtime = getRuntime(guildId);
  const connection = runtime.voiceConnection;
  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    return false;
  }

  await stopRelay(guildId).catch((err) => logger.error('退出前の中継停止でエラー', err));
  connection.destroy();
  logger.info(`VC退出: guild=${guildId}`);
  resetGuildState(guildId);
  return true;
}

export function isConnected(guildId: string): boolean {
  const connection = getRuntime(guildId).voiceConnection;
  return !!connection && connection.state.status !== VoiceConnectionStatus.Destroyed;
}
