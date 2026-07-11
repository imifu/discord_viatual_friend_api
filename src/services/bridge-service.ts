import type { Client } from 'discord.js';
import { createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { createLogger } from '../utils/logger.js';
import { getRuntime, getStatus, updateStatus } from '../state/bridge-state.js';
import { loadConfig, requireDeviceConfig } from '../config/env.js';
import { ConfigError, NotConnectedError, RelayAlreadyRunningError } from '../utils/errors.js';
import { PcmMixer } from '../audio/pcm-mixer.js';
import { startVirtualOutput } from '../audio/virtual-output.js';
import { startVirtualInput } from '../audio/virtual-input.js';
import { attachReceiver } from '../discord/receiver.js';
import { VoiceActivityGate } from '../audio/voice-activity.js';
import { applyDiscordInputGate } from '../audio/audio-gate.js';

const logger = createLogger('bridge-service');

const FRAME_MS = 20;

/**
 * Starts the audio relay for a guild in both directions: Discord speakers -> mixed -> gated ->
 * virtual device A (playback), and virtual device B (recording) -> Discord voice connection.
 * The gate implements half-duplex anti-howling: while ChatGPT Live is detected as speaking
 * (plus a release hold), Discord's audio is attenuated/muted before being written to device A.
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
  const { discordToGpt: discordToGptDevice, gptToDiscord: gptToDiscordDevice } = requireDeviceConfig(config);

  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new ConfigError('Discordクライアントが未初期化です。');
  }

  try {
    const vadGate = new VoiceActivityGate(config.vad.threshold, config.vad.gptSpeakingHoldMs, (speaking) => {
      updateStatus(guildId, { gptSpeaking: speaking, discordInputGateOpen: !speaking });
      logger.info(`GPT発話${speaking ? '開始' : '終了'}: guild=${guildId}`);
      logger.info(`Discord入力ゲート${speaking ? '閉鎖' : '開放'}: guild=${guildId} (ducking=${config.vad.ducking})`);
    });
    runtime.vadGate = vadGate;

    // --- Discord -> ChatGPT Live (mixed, gated, write to virtual device A) ---
    const outboundFrameSizeSamples = Math.round((config.input.sampleRate * FRAME_MS) / 1000);

    const mixer = new PcmMixer(
      { sampleRate: config.input.sampleRate, channels: config.input.channels, frameMs: FRAME_MS },
      (frame) => {
        const gated = applyDiscordInputGate(frame, vadGate.isSpeaking(), {
          ducking: config.vad.ducking,
          duckingLevel: config.vad.duckingLevel,
        });
        runtime.outboundAudio?.write(gated);
      },
    );

    const outboundAudio = startVirtualOutput(
      discordToGptDevice,
      config.input.sampleRate,
      config.input.channels,
      outboundFrameSizeSamples,
      () => updateStatus(guildId, { outboundAudioRunning: false }),
    );

    runtime.outboundAudio = outboundAudio;
    runtime.mixer = mixer;
    runtime.receiverHandle = attachReceiver(connection, botUserId, mixer, config.input.sampleRate, config.input.channels);
    mixer.start();

    // --- ChatGPT Live -> Discord (read from virtual device B, also feeds VAD) ---
    const inboundFrameSizeSamples = Math.round((config.output.sampleRate * FRAME_MS) / 1000);

    const inboundAudio = startVirtualInput(
      gptToDiscordDevice,
      config.output.sampleRate,
      config.output.channels,
      inboundFrameSizeSamples,
      () => updateStatus(guildId, { inboundAudioRunning: false }),
    );
    inboundAudio.stream.on('data', (chunk: Buffer) => vadGate.observeGptFrame(chunk));

    const audioPlayer = createAudioPlayer();
    const resource = createAudioResource(inboundAudio.stream, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
    connection.subscribe(audioPlayer);

    runtime.inboundAudio = inboundAudio;
    runtime.audioPlayer = audioPlayer;

    updateStatus(guildId, {
      relayRunning: true,
      outboundAudioRunning: true,
      inboundAudioRunning: true,
      outputDeviceName: discordToGptDevice,
      inputDeviceName: gptToDiscordDevice,
      gptSpeaking: false,
      discordInputGateOpen: true,
    });

    logger.info(
      `中継開始: guild=${guildId} discordToGpt="${discordToGptDevice}" gptToDiscord="${gptToDiscordDevice}" ` +
        `vadThreshold=${config.vad.threshold} holdMs=${config.vad.gptSpeakingHoldMs} ducking=${config.vad.ducking}`,
    );
  } catch (err) {
    await stopRelay(guildId);
    throw err;
  }
}

/** Stops the audio relay for a guild, if running, and tears down any active audio streams. Safe to call when not running. */
export async function stopRelay(guildId: string): Promise<void> {
  const runtime = getRuntime(guildId);

  runtime.receiverHandle?.detach();
  runtime.receiverHandle = undefined;

  runtime.mixer?.stop();
  runtime.mixer = undefined;

  runtime.outboundAudio?.close();
  runtime.outboundAudio = undefined;

  runtime.audioPlayer?.stop();
  runtime.audioPlayer = undefined;

  runtime.inboundAudio?.close();
  runtime.inboundAudio = undefined;

  runtime.vadGate?.destroy();
  runtime.vadGate = undefined;

  updateStatus(guildId, {
    relayRunning: false,
    outboundAudioRunning: false,
    inboundAudioRunning: false,
    gptSpeaking: false,
    discordInputGateOpen: true,
  });

  logger.info(`中継停止: guild=${guildId}`);
}
