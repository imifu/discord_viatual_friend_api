import type { Client } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { getRuntime, getStatus, updateStatus } from '../state/bridge-state.js';
import { loadConfig } from '../config/env.js';
import { ConfigError, NotConnectedError, RelayAlreadyRunningError } from '../utils/errors.js';
import { PcmMixer } from '../audio/pcm-mixer.js';
import { startVirtualOutput } from '../audio/virtual-output.js';
import { attachReceiver } from '../discord/receiver.js';

const logger = createLogger('bridge-service');

const FRAME_MS = 20;

/**
 * Starts the audio relay for a guild. Currently wires the Discord -> ChatGPT Live direction
 * (receive Discord speakers, mix, write to virtual device A via WASAPI). The ChatGPT Live ->
 * Discord direction is added in Phase 3.
 */
export async function startRelay(guildId: string, client: Client): Promise<void> {
  const status = getStatus(guildId);
  if (status.relayRunning) {
    throw new RelayAlreadyRunningError();
  }

  const runtime = getRuntime(guildId);
  const connection = runtime.voiceConnection;
  if (!connection) {
    throw new NotConnectedError();
  }

  const config = loadConfig();
  const discordToGptDevice = config.devices.discordToGpt;
  if (!discordToGptDevice) {
    throw new ConfigError(
      'DISCORD_TO_GPT_DEVICE が設定されていません。/devices で確認し .env に設定してください。',
    );
  }

  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new ConfigError('Discordクライアントが未初期化です。');
  }

  const frameSizeSamples = Math.round((config.input.sampleRate * FRAME_MS) / 1000);

  const mixer = new PcmMixer(
    { sampleRate: config.input.sampleRate, channels: config.input.channels, frameMs: FRAME_MS },
    (frame) => {
      runtime.outboundAudio?.write(frame);
    },
  );

  const outboundAudio = startVirtualOutput(
    discordToGptDevice,
    config.input.sampleRate,
    config.input.channels,
    frameSizeSamples,
    () => {
      updateStatus(guildId, { outboundAudioRunning: false });
    },
  );

  runtime.outboundAudio = outboundAudio;
  runtime.mixer = mixer;
  runtime.receiverHandle = attachReceiver(connection, botUserId, mixer, config.input.sampleRate, config.input.channels);

  mixer.start();

  updateStatus(guildId, {
    relayRunning: true,
    outboundAudioRunning: true,
    outputDeviceName: discordToGptDevice,
  });

  logger.info(`中継開始(Discord→GPT方向): guild=${guildId} device="${discordToGptDevice}"`);
}

/** Stops the audio relay for a guild, if running, and tears down any active audio streams/processes. Safe to call when not running. */
export async function stopRelay(guildId: string): Promise<void> {
  const runtime = getRuntime(guildId);

  runtime.receiverHandle?.detach();
  runtime.receiverHandle = undefined;

  runtime.mixer?.stop();
  runtime.mixer = undefined;

  runtime.outboundAudio?.close();
  runtime.outboundAudio = undefined;

  if (runtime.inboundFfmpeg && !runtime.inboundFfmpeg.killed) {
    runtime.inboundFfmpeg.kill();
  }
  runtime.inboundFfmpeg = undefined;

  updateStatus(guildId, {
    relayRunning: false,
    outboundAudioRunning: false,
    inboundFfmpegRunning: false,
    gptSpeaking: false,
  });

  logger.info(`中継停止: guild=${guildId}`);
}
