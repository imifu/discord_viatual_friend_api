import type { Client } from 'discord.js';
import { PassThrough } from 'node:stream';
import type { AudioPlayer } from '@discordjs/voice';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { createLogger } from '../utils/logger.js';
import { getRuntime, getStatus, updateStatus } from '../state/bridge-state.js';
import { loadConfig, requireDeviceConfig } from '../config/env.js';
import { ConfigError, NotConnectedError, RelayAlreadyRunningError } from '../utils/errors.js';
import { PcmMixer } from '../audio/pcm-mixer.js';
import { startVirtualOutput } from '../audio/virtual-output.js';
import { startVirtualInput } from '../audio/virtual-input.js';
import { attachReceiver } from '../discord/receiver.js';
import { VoiceActivityGate } from '../audio/voice-activity.js';
import { applyDiscordInputGate, applyPcmGain } from '../audio/audio-gate.js';
import { PcmRingBuffer } from '../audio/pcm-ring-buffer.js';
import { attachMessagePosting } from './message-posting-service.js';
import { attachUtteranceRecorder } from './utterance-recorder.js';
import { finalizeAndPostTranscript } from './transcript-service.js';
import { MAX_CLIP_SECONDS } from './clip-service.js';

const logger = createLogger('bridge-service');

const FRAME_MS = 20;

// WASAPI capture streams (via audify/RtAudio) have been observed to silently stop delivering
// frames - no error callback, no exception - after certain system audio events, leaving GPT's
// audio invisible to Discord while everything else keeps working. There's no upstream fix for
// this, so we watch for a gap in incoming frames and reopen the device ourselves.
const INBOUND_STALL_TIMEOUT_MS = 3000;
const INBOUND_WATCHDOG_INTERVAL_MS = 1000;

// The @discordjs/voice AudioPlayer can also stop draining inboundPlaybackStream on its own side
// (e.g. AutoPaused after a brief voice-connection hiccup that never fully recovers) - capture
// stays healthy, VAD keeps firing off the raw stream, but the mixed audio has nowhere to go and
// is silently dropped by the backpressure guard below. Watch for backpressure that never clears.
const INBOUND_PLAYBACK_STALL_TIMEOUT_MS = 4000;
const OUTBOUND_RESTART_INITIAL_DELAY_MS = 1000;
const OUTBOUND_RESTART_MAX_DELAY_MS = 30_000;

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
  const voiceConnection = runtime.voiceConnection;
  if (!voiceConnection) {
    throw new NotConnectedError();
  }
  const connection = voiceConnection;

  const config = loadConfig();
  const { discordToGpt: discordToGptDevice, gptToDiscord: gptToDiscordDevice } = requireDeviceConfig(config);

  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new ConfigError('Discordクライアントが未初期化です。');
  }

  runtime.client = client;

  try {
    const vadGate = new VoiceActivityGate(config.vad.threshold, config.vad.gptSpeakingHoldMs);
    const speakingDiscordUsers = new Set<string>();
    let bargeInActive = false;

    const refreshBargeInState = (): void => {
      const next = config.bargeIn.enabled && vadGate.isSpeaking() && speakingDiscordUsers.size > 0;
      if (next !== bargeInActive) {
        bargeInActive = next;
        logger.info(
          `賢い割り込み${next ? '開始' : '終了'}: guild=${guildId} ` +
            `gptPlaybackLevel=${config.bargeIn.gptPlaybackLevel}`,
        );
      }
      updateStatus(guildId, {
        bargeInActive,
        discordInputGateOpen: !vadGate.isSpeaking() || bargeInActive,
      });
    };

    vadGate.on('speaking', (speaking) => {
      updateStatus(guildId, { gptSpeaking: speaking });
      refreshBargeInState();
      logger.info(`GPT発話${speaking ? '開始' : '終了'}: guild=${guildId}`);
      logger.info(
        `Discord入力ゲート${!speaking || bargeInActive ? '開放' : '閉鎖'}: guild=${guildId} ` +
          `(ducking=${config.vad.ducking})`,
      );
    });
    runtime.vadGate = vadGate;

    // --- ChatGPT Live -> Discord (read from virtual device B, also feeds VAD) ---
    const inboundFrameSizeSamples = Math.round((config.output.sampleRate * FRAME_MS) / 1000);

    let inboundAudio = startVirtualInput(
      gptToDiscordDevice,
      config.output.sampleRate,
      config.output.channels,
      inboundFrameSizeSamples,
      () => updateStatus(guildId, { inboundAudioRunning: false }),
    );
    let lastGptDataAt = Date.now();
    inboundAudio.stream.on('data', (chunk: Buffer) => {
      lastGptDataAt = Date.now();
      vadGate.observeGptFrame(chunk);
    });

    // Keep the last 60 seconds of the unattenuated Discord + GPT mix. This is deliberately
    // independent of Whisper and never grows beyond its fixed PCM allocation.
    let clipMixer: PcmMixer | undefined;
    let clipDiscordStream: PassThrough | undefined;
    let clipRingBuffer: PcmRingBuffer | undefined;
    const clipFormatsMatch =
      config.input.sampleRate === config.output.sampleRate && config.input.channels === config.output.channels;
    if (clipFormatsMatch) {
      clipRingBuffer = new PcmRingBuffer(config.input.sampleRate, config.input.channels, MAX_CLIP_SECONDS);
      clipDiscordStream = new PassThrough();
      clipMixer = new PcmMixer(
        { sampleRate: config.input.sampleRate, channels: config.input.channels, frameMs: FRAME_MS },
        (frame) => clipRingBuffer?.push(frame),
      );
      clipMixer.addSource('discord', clipDiscordStream);
      clipMixer.addSource('gpt', inboundAudio.stream);
      clipMixer.start();
      runtime.clipMixer = clipMixer;
      runtime.clipDiscordStream = clipDiscordStream;
      runtime.clipRingBuffer = clipRingBuffer;
    } else {
      logger.warn(
        `クリップを無効化します。INPUTとOUTPUTのsampleRate/channelsを同じ値にしてください: guild=${guildId}`,
      );
    }

    // Jitter-buffer the captured audio on the same fixed 20ms tick used for the outbound side,
    // instead of handing the raw native-callback stream straight to Discord. audify's capture
    // callback timing can wobble under Node event-loop load (GC, decoding, etc.); without this
    // buffer, that wobble was audible as intermittent cutouts in ChatGPT Live's voice in the VC.
    //
    // The highWaterMark here is deliberately small (a handful of frames, not Node's default of
    // many KB/MB): this stream sits between our own 20ms producer tick and whatever pace
    // @discordjs/voice's AudioPlayer actually drains it at. A large buffer let any tiny,
    // persistent mismatch between those two independent clocks silently accumulate - production
    // was very slightly faster than consumption, and because writes were never gated on
    // backpressure, unread audio piled up over the course of a session until multiple seconds of
    // GPT's speech were sitting in the buffer before ever reaching Discord. Capping the buffer and
    // dropping frames while backpressured keeps that lag bounded to tens of milliseconds instead.
    const inboundFrameBytes = inboundFrameSizeSamples * config.output.channels * 2;
    function createPlaybackStream(): PassThrough {
      const stream = new PassThrough({ highWaterMark: inboundFrameBytes * 4 });
      stream.on('drain', () => {
        inboundBackpressured = false;
        backpressureSince = null;
      });
      return stream;
    }
    let inboundPlaybackStream = createPlaybackStream();
    let inboundBackpressured = false;
    let backpressureSince: number | null = null;
    const inboundMixer = new PcmMixer(
      { sampleRate: config.output.sampleRate, channels: config.output.channels, frameMs: FRAME_MS },
      (frame) => {
        if (inboundPlaybackStream.destroyed || inboundBackpressured) return;
        const playbackFrame = bargeInActive ? applyPcmGain(frame, config.bargeIn.gptPlaybackLevel) : frame;
        if (!inboundPlaybackStream.write(playbackFrame)) {
          inboundBackpressured = true;
          backpressureSince = Date.now();
        }
      },
    );
    inboundMixer.addSource('gpt', inboundAudio.stream);
    inboundMixer.start();

    function bindAudioPlayer(player: AudioPlayer): void {
      connection.subscribe(player);
      // Without a listener, an 'error' event (e.g. ERR_STREAM_PREMATURE_CLOSE when we destroy the
      // underlying stream ourselves during stopRelay) is an unhandled EventEmitter error and
      // crashes out to the process-level uncaughtException handler instead of just being noise.
      player.on('error', (err) => {
        logger.warn(`AudioPlayerでエラーが発生しました: guild=${guildId}`, err);
      });
      // Confirmed by observation: @discordjs/voice's AudioPlayer occasionally drops from Playing
      // to Idle on its own mid-session - no error, no resource end, no VoiceConnection state
      // change - and never recovers on its own. This just logs every transition; the watchdog
      // interval below is what actually reacts to an unexpected Idle and rebuilds playback.
      player.on('stateChange', (oldState, newState) => {
        logger.info(`AudioPlayer状態変化: guild=${guildId} ${oldState.status} -> ${newState.status}`);
      });
    }
    let audioPlayer = createAudioPlayer();
    bindAudioPlayer(audioPlayer);
    let hasStartedPlaying = false;

    runtime.inboundAudio = inboundAudio;
    runtime.inboundMixer = inboundMixer;
    runtime.inboundPlaybackStream = inboundPlaybackStream;
    runtime.audioPlayer = audioPlayer;

    // --- Optional: "投稿して" voice-triggered Discord text posting (STT-based, off the live path) ---
    let messagePosting: ReturnType<typeof attachMessagePosting> | undefined;
    if (config.messagePosting.enabled && config.messagePosting.channelId) {
      // Separate, longer-hold gate used only for message-posting capture: GPT_SPEAKING_HOLD_MS is
      // tuned to reopen Discord's mic quickly, which is far too short to survive natural pauses
      // within a single spoken reply (using it there truncated captures to just the first phrase).
      const postingSpeakingGate = new VoiceActivityGate(config.vad.threshold, config.messagePosting.replyHoldMs);
      runtime.postingSpeakingGate = postingSpeakingGate;
      inboundAudio.stream.on('data', (chunk: Buffer) => postingSpeakingGate.observeGptFrame(chunk));

      messagePosting = attachMessagePosting({
        client,
        channelId: config.messagePosting.channelId,
        triggerKeywords: config.messagePosting.triggerKeywords,
        vadGate: postingSpeakingGate,
        gptAudioStream: inboundAudio.stream,
        gptSampleRate: config.output.sampleRate,
        gptChannels: config.output.channels,
        discordSampleRate: config.input.sampleRate,
        discordChannels: config.input.channels,
      });
    } else if (config.messagePosting.enabled) {
      logger.warn(`MESSAGE_POST_ENABLED=trueですが MESSAGE_POST_CHANNEL_ID が未設定のため投稿機能を無効化します: guild=${guildId}`);
    }
    runtime.messagePostingHandle = messagePosting;

    // --- Durable utterance event foundation for optional post-session logs ---
    let utteranceRecorder: ReturnType<typeof attachUtteranceRecorder> | undefined;
    if (config.transcriptLog.enabled) {
      const utteranceSpeakingGate = new VoiceActivityGate(
        config.vad.threshold,
        config.transcriptLog.gptUtteranceHoldMs,
      );
      runtime.utteranceSpeakingGate = utteranceSpeakingGate;
      inboundAudio.stream.on('data', (chunk: Buffer) => utteranceSpeakingGate.observeGptFrame(chunk));

      utteranceRecorder = attachUtteranceRecorder({
        vadGate: utteranceSpeakingGate,
        gptAudioStream: inboundAudio.stream,
        gptSampleRate: config.output.sampleRate,
        gptChannels: config.output.channels,
        discordSampleRate: config.input.sampleRate,
        discordChannels: config.input.channels,
      });
    }
    runtime.utteranceRecorder = utteranceRecorder;

    // --- Watchdog: reopen inboundAudio if its capture stream goes quiet without erroring ---
    function restartInboundAudio(): void {
      logger.warn(
        `GPT音声入力が${INBOUND_STALL_TIMEOUT_MS}ms間途絶えたため再接続します: guild=${guildId}`,
      );
      try {
        inboundAudio.close();
      } catch (err) {
        logger.warn(`旧GPT音声入力の停止中にエラー: guild=${guildId}`, err);
      }

      try {
        inboundAudio = startVirtualInput(
          gptToDiscordDevice,
          config.output.sampleRate,
          config.output.channels,
          inboundFrameSizeSamples,
          () => updateStatus(guildId, { inboundAudioRunning: false }),
        );
      } catch (err) {
        logger.error(`GPT音声入力の再接続に失敗しました: guild=${guildId}`, err);
        updateStatus(guildId, { inboundAudioRunning: false });
        return;
      }

      runtime.inboundAudio = inboundAudio;
      lastGptDataAt = Date.now();
      inboundAudio.stream.on('data', (chunk: Buffer) => {
        lastGptDataAt = Date.now();
        vadGate.observeGptFrame(chunk);
      });
      if (runtime.postingSpeakingGate) {
        const gate = runtime.postingSpeakingGate;
        inboundAudio.stream.on('data', (chunk: Buffer) => gate.observeGptFrame(chunk));
      }
      if (runtime.utteranceSpeakingGate) {
        const gate = runtime.utteranceSpeakingGate;
        inboundAudio.stream.on('data', (chunk: Buffer) => gate.observeGptFrame(chunk));
      }
      runtime.messagePostingHandle?.replaceGptAudioStream(inboundAudio.stream);
      runtime.utteranceRecorder?.replaceGptAudioStream(inboundAudio.stream);

      inboundMixer.removeSource('gpt');
      inboundMixer.addSource('gpt', inboundAudio.stream);
      clipMixer?.removeSource('gpt');
      clipMixer?.addSource('gpt', inboundAudio.stream);

      updateStatus(guildId, { inboundAudioRunning: true });
      logger.info(`GPT音声入力を再接続しました: guild=${guildId}`);
    }

    // --- Watchdog: rebuild the playback pipeline if Discord-side consumption stalls ---
    function restartInboundPlayback(reason: string): void {
      logger.warn(`Discordへの音声再生を再構築します(${reason}): guild=${guildId}`);
      try {
        audioPlayer.stop(true);
      } catch (err) {
        logger.warn(`旧AudioPlayerの停止中にエラー: guild=${guildId}`, err);
      }
      try {
        inboundPlaybackStream.destroy();
      } catch (err) {
        logger.warn(`旧再生ストリームの破棄中にエラー: guild=${guildId}`, err);
      }

      inboundPlaybackStream = createPlaybackStream();
      inboundBackpressured = false;
      backpressureSince = null;
      runtime.inboundPlaybackStream = inboundPlaybackStream;

      audioPlayer = createAudioPlayer();
      bindAudioPlayer(audioPlayer);
      runtime.audioPlayer = audioPlayer;

      const resource = createAudioResource(inboundPlaybackStream, { inputType: StreamType.Raw });
      audioPlayer.play(resource);
      hasStartedPlaying = true;

      logger.info(`Discordへの音声再生を再構築しました: guild=${guildId}`);
    }

    runtime.inboundWatchdog = setInterval(() => {
      const now = Date.now();
      if (now - lastGptDataAt > INBOUND_STALL_TIMEOUT_MS) {
        restartInboundAudio();
      }
      // Confirmed by observation (see stateChange log above): the AudioPlayer can drop to Idle
      // entirely on its own mid-session, with no error and no backpressure on our side - this is
      // the primary recovery path. The backpressure check below is a fallback for the other
      // failure shape (player alive but not draining what we write).
      if (hasStartedPlaying && audioPlayer.state.status === AudioPlayerStatus.Idle) {
        restartInboundPlayback('AudioPlayerが予期せずidleへ遷移');
      } else if (backpressureSince !== null && now - backpressureSince > INBOUND_PLAYBACK_STALL_TIMEOUT_MS) {
        restartInboundPlayback(`再生バッファが${INBOUND_PLAYBACK_STALL_TIMEOUT_MS}ms間詰まった`);
      }
    }, INBOUND_WATCHDOG_INTERVAL_MS);

    const onUserUtterance =
      messagePosting || utteranceRecorder
        ? (userId: string, pcm: Buffer, timestamp: Date): void => {
            messagePosting?.observeUserUtterance(userId, pcm);
            utteranceRecorder?.observeUserUtterance(userId, pcm, timestamp);
          }
        : undefined;

    // --- Discord -> ChatGPT Live (mixed, gated, write to virtual device A) ---
    const outboundFrameSizeSamples = Math.round((config.input.sampleRate * FRAME_MS) / 1000);
    let outboundAudio: ReturnType<typeof startVirtualOutput> | undefined;
    let outboundRestartDelayMs = OUTBOUND_RESTART_INITIAL_DELAY_MS;
    let outboundGeneration = 0;

    function scheduleOutboundRestart(reason: string): void {
      if (!runtime.outboundRecoveryActive || runtime.outboundRestartTimer) return;

      const failedHandle = runtime.outboundAudio;
      outboundAudio = undefined;
      outboundGeneration += 1;
      updateStatus(guildId, { outboundAudioRunning: false });

      const delayMs = outboundRestartDelayMs;
      outboundRestartDelayMs = Math.min(outboundRestartDelayMs * 2, OUTBOUND_RESTART_MAX_DELAY_MS);
      logger.warn(`Discord音声出力を${delayMs}ms後に再接続します: guild=${guildId} reason=${reason}`);

      const timer = setTimeout(() => {
        if (runtime.outboundRestartTimer !== timer) return;
        runtime.outboundRestartTimer = undefined;
        if (!runtime.outboundRecoveryActive) return;

        if (failedHandle && runtime.outboundAudio === failedHandle) {
          failedHandle.close();
          runtime.outboundAudio = undefined;
        }

        try {
          outboundAudio = openOutboundAudio();
          runtime.outboundAudio = outboundAudio;
          updateStatus(guildId, { outboundAudioRunning: true });
          logger.info(`Discord音声出力を再接続しました: guild=${guildId}`);
        } catch (err) {
          logger.error(`Discord音声出力の再接続に失敗しました: guild=${guildId}`, err);
          scheduleOutboundRestart('デバイスの再オープンに失敗');
        }
      }, delayMs);
      runtime.outboundRestartTimer = timer;
    }

    function openOutboundAudio(): ReturnType<typeof startVirtualOutput> {
      const generation = ++outboundGeneration;
      return startVirtualOutput(
        discordToGptDevice,
        config.input.sampleRate,
        config.input.channels,
        outboundFrameSizeSamples,
        (message) => {
          queueMicrotask(() => {
            if (generation === outboundGeneration) scheduleOutboundRestart(message);
          });
        },
      );
    }

    const mixer = new PcmMixer(
      { sampleRate: config.input.sampleRate, channels: config.input.channels, frameMs: FRAME_MS },
      (frame) => {
        clipDiscordStream?.write(frame);
        const gated = applyDiscordInputGate(frame, vadGate.isSpeaking() && !bargeInActive, {
          ducking: config.vad.ducking,
          duckingLevel: config.vad.duckingLevel,
        });
        if (!outboundAudio) return;
        try {
          outboundAudio.write(gated);
          outboundRestartDelayMs = OUTBOUND_RESTART_INITIAL_DELAY_MS;
        } catch (err) {
          logger.error(`Discord音声出力の書き込みに失敗しました: guild=${guildId}`, err);
          scheduleOutboundRestart('音声フレームの書き込みに失敗');
        }
      },
    );

    runtime.outboundRecoveryActive = true;
    outboundAudio = openOutboundAudio();

    runtime.outboundAudio = outboundAudio;
    runtime.mixer = mixer;
    runtime.receiverHandle = attachReceiver(
      connection,
      botUserId,
      mixer,
      config.input.sampleRate,
      config.input.channels,
      onUserUtterance,
      (userId, speaking) => {
        if (speaking) speakingDiscordUsers.add(userId);
        else speakingDiscordUsers.delete(userId);
        refreshBargeInState();
      },
      {
        threshold: config.bargeIn.voiceThreshold,
        attackMs: config.bargeIn.attackMs,
        releaseMs: config.bargeIn.releaseMs,
      },
    );
    mixer.start();

    const resource = createAudioResource(inboundPlaybackStream, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
    hasStartedPlaying = true;

    updateStatus(guildId, {
      relayRunning: true,
      outboundAudioRunning: true,
      inboundAudioRunning: true,
      outputDeviceName: discordToGptDevice,
      inputDeviceName: gptToDiscordDevice,
      gptSpeaking: vadGate.isSpeaking(),
      discordInputGateOpen: !vadGate.isSpeaking() || bargeInActive,
      bargeInActive,
      clipBufferRunning: !!clipRingBuffer,
    });

    logger.info(
      `中継開始: guild=${guildId} discordToGpt="${discordToGptDevice}" gptToDiscord="${gptToDiscordDevice}" ` +
        `vadThreshold=${config.vad.threshold} holdMs=${config.vad.gptSpeakingHoldMs} ducking=${config.vad.ducking} ` +
        `bargeInThreshold=${config.bargeIn.voiceThreshold} attackMs=${config.bargeIn.attackMs} ` +
        `releaseMs=${config.bargeIn.releaseMs}`,
    );
  } catch (err) {
    await stopRelay(guildId);
    throw err;
  }
}

/** Stops the audio relay for a guild, if running, and tears down any active audio streams. Safe to call when not running. */
export async function stopRelay(guildId: string): Promise<void> {
  const runtime = getRuntime(guildId);

  if (runtime.inboundWatchdog) {
    clearInterval(runtime.inboundWatchdog);
    runtime.inboundWatchdog = undefined;
  }

  runtime.outboundRecoveryActive = false;
  if (runtime.outboundRestartTimer) {
    clearTimeout(runtime.outboundRestartTimer);
    runtime.outboundRestartTimer = undefined;
  }

  runtime.messagePostingHandle?.detach();
  runtime.messagePostingHandle = undefined;

  runtime.postingSpeakingGate?.destroy();
  runtime.postingSpeakingGate = undefined;

  runtime.receiverHandle?.detach();
  runtime.receiverHandle = undefined;

  if (runtime.utteranceRecorder && runtime.client) {
    const utterances = await runtime.utteranceRecorder.detach();
    const client = runtime.client;
    finalizeAndPostTranscript(guildId, client, utterances).catch((err) =>
      logger.error(`会話ログの文字起こし処理に失敗しました: guild=${guildId}`, err),
    );
  }
  runtime.utteranceRecorder = undefined;

  runtime.utteranceSpeakingGate?.destroy();
  runtime.utteranceSpeakingGate = undefined;

  runtime.mixer?.stop();
  runtime.mixer = undefined;

  runtime.clipMixer?.stop();
  runtime.clipMixer = undefined;
  runtime.clipDiscordStream?.destroy();
  runtime.clipDiscordStream = undefined;
  runtime.clipRingBuffer?.clear();
  runtime.clipRingBuffer = undefined;

  runtime.outboundAudio?.close();
  runtime.outboundAudio = undefined;

  runtime.audioPlayer?.stop();
  runtime.audioPlayer = undefined;

  runtime.inboundMixer?.stop();
  runtime.inboundMixer = undefined;

  runtime.inboundPlaybackStream?.destroy();
  runtime.inboundPlaybackStream = undefined;

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
    bargeInActive: false,
    clipBufferRunning: false,
  });

  logger.info(`中継停止: guild=${guildId}`);
}
