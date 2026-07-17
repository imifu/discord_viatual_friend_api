import type { Client } from 'discord.js';
import { PassThrough } from 'node:stream';
import type { AudioPlayer } from '@discordjs/voice';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import { createLogger } from '../utils/logger.js';
import { getRuntime, getStatus, updateStatus } from '../state/bridge-state.js';
import { loadConfig } from '../config/env.js';
import { ConfigError, NotConnectedError, RelayAlreadyRunningError } from '../utils/errors.js';
import { PcmMixer } from '../audio/pcm-mixer.js';
import { resampleFromMono, resampleToMono } from '../audio/resampler.js';
import { attachReceiver } from '../discord/receiver.js';
import { applyPcmGain } from '../audio/audio-gate.js';
import { PcmRingBuffer } from '../audio/pcm-ring-buffer.js';
import { MAX_CLIP_SECONDS } from './clip-service.js';
import { RealtimeSession, REALTIME_SAMPLE_RATE } from '../realtime/openai-realtime-client.js';

const logger = createLogger('bridge-service');

const FRAME_MS = 20;

const REALTIME_RESTART_INITIAL_DELAY_MS = 1000;
const REALTIME_RESTART_MAX_DELAY_MS = 30_000;
// A session that fails immediately after connecting (e.g. insufficient_quota, an invalid model
// name) still resolves openRealtimeSession() successfully - the WebSocket itself opened fine,
// even though the very next server message tears it back down. Only treat a reconnect as
// genuinely healthy (and reset the backoff) once the session has stayed up this long, otherwise
// a permanent, immediately-recurring error resets the delay every cycle and the retry loop never
// backs off - it just hammers the API and the Node event loop every ~1s indefinitely.
const REALTIME_RESTART_SUCCESS_GRACE_MS = 10_000;

// @discordjs/voice's AudioPlayer can stop draining inboundPlaybackStream on its own side
// (e.g. AutoPaused after a brief voice-connection hiccup that never fully recovers) - the
// mixed audio has nowhere to go and is silently dropped by the backpressure guard below.
// Watch for backpressure that never clears.
const INBOUND_PLAYBACK_STALL_TIMEOUT_MS = 4000;
const INBOUND_WATCHDOG_INTERVAL_MS = 1000;

const IDLE_CHECK_INTERVAL_MS = 30_000;

/**
 * Starts the audio relay for a guild in both directions: Discord speakers -> mixed -> resampled
 * -> OpenAI Realtime API (always at full volume, never locally gated, so the API's own
 * server-side VAD can always detect a real interruption), and the Realtime API's spoken response
 * -> resampled -> mixed -> Discord voice connection (ducked while a barge-in is detected).
 * Also auto-stops the relay after `idleTimeoutMinutes` of silence from both sides, since input
 * audio cost accrues for the whole time the relay is running regardless of who's talking.
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

  const botUserId = client.user?.id;
  if (!botUserId) {
    throw new ConfigError('Discordクライアントが未初期化です。');
  }

  let userSpeaking = false;
  let bargeInActive = false;

  // Discord audio streams to the Realtime API continuously for the whole relay session, so
  // input-audio cost accrues even while nobody is talking (see README/CLAUDE.md). Track the
  // last time either side actually spoke and auto-stop after too long, so a forgotten /start
  // doesn't rack up cost indefinitely.
  let lastActivityAt = Date.now();
  const touchActivity = (): void => {
    lastActivityAt = Date.now();
  };

  const refreshBargeInState = (): void => {
    const gptSpeaking = runtime.realtimeSession?.isSpeaking() ?? false;
    const next = config.bargeIn.enabled && gptSpeaking && userSpeaking;
    if (next !== bargeInActive) {
      bargeInActive = next;
      logger.info(`賢い割り込み${next ? '開始' : '終了'}: guild=${guildId} gptPlaybackLevel=${config.bargeIn.gptPlaybackLevel}`);
    }
    updateStatus(guildId, { bargeInActive });
  };

  try {
    // --- OpenAI Realtime API <-> Discord (audio both directions over one WebSocket session) ---
    const inboundFrameSizeSamples = Math.round((config.output.sampleRate * FRAME_MS) / 1000);
    const gptAudioStream = new PassThrough({ highWaterMark: 1 << 20 });

    let realtimeGeneration = 0;
    let realtimeRestartDelayMs = REALTIME_RESTART_INITIAL_DELAY_MS;

    // Temporary diagnostic for a reported ~4x playback speedup: tally how many raw (24kHz mono)
    // and resampled (config.output rate/channels) bytes flow through one response, and compare
    // the duration those byte counts imply against the wall-clock time between speakingChanged
    // true/false. This tells us whether the byte count itself is already short (OpenAI-side or
    // our resample producing too little data) versus the byte count being correct but consumed
    // too fast downstream (mixer/AudioPlayer pacing).
    let responseStartedAt = 0;
    let rawBytesThisResponse = 0;
    let resampledBytesThisResponse = 0;
    let deltaCountThisResponse = 0;
    let minDeltaBytes = Number.POSITIVE_INFINITY;
    let maxDeltaBytes = 0;
    let firstDeltaAt = 0;
    let lastDeltaAt = 0;

    function bindRealtimeSession(session: RealtimeSession, generation: number): void {
      session.on('audioDelta', (pcm24kMono) => {
        const now = Date.now();
        if (firstDeltaAt === 0) firstDeltaAt = now;
        lastDeltaAt = now;
        deltaCountThisResponse += 1;
        minDeltaBytes = Math.min(minDeltaBytes, pcm24kMono.length);
        maxDeltaBytes = Math.max(maxDeltaBytes, pcm24kMono.length);
        rawBytesThisResponse += pcm24kMono.length;
        if (gptAudioStream.destroyed) return;
        const resampled = resampleFromMono(pcm24kMono, REALTIME_SAMPLE_RATE, config.output.sampleRate, config.output.channels);
        resampledBytesThisResponse += resampled.length;
        gptAudioStream.write(resampled);
      });
      session.on('speakingChanged', (speaking) => {
        touchActivity();
        updateStatus(guildId, { gptSpeaking: speaking });
        refreshBargeInState();
        logger.info(`GPT発話${speaking ? '開始' : '終了'}: guild=${guildId}`);
        if (speaking) {
          responseStartedAt = Date.now();
          rawBytesThisResponse = 0;
          resampledBytesThisResponse = 0;
          deltaCountThisResponse = 0;
          minDeltaBytes = Number.POSITIVE_INFINITY;
          maxDeltaBytes = 0;
          firstDeltaAt = 0;
          lastDeltaAt = 0;
        } else if (responseStartedAt > 0) {
          const wallClockSec = (Date.now() - responseStartedAt) / 1000;
          const rawImpliedSec = rawBytesThisResponse / (REALTIME_SAMPLE_RATE * 2);
          const resampledImpliedSec =
            resampledBytesThisResponse / (config.output.sampleRate * config.output.channels * 2);
          const deltaSpanSec = firstDeltaAt > 0 ? (lastDeltaAt - firstDeltaAt) / 1000 : 0;
          const avgDeltaBytes = deltaCountThisResponse > 0 ? Math.round(rawBytesThisResponse / deltaCountThisResponse) : 0;
          logger.info(
            `[診断] 音声バイト数と時間の比較: guild=${guildId} wallClock=${wallClockSec.toFixed(2)}s ` +
              `raw=${rawBytesThisResponse}bytes(${rawImpliedSec.toFixed(2)}s) ` +
              `resampled=${resampledBytesThisResponse}bytes(${resampledImpliedSec.toFixed(2)}s) ` +
              `deltaCount=${deltaCountThisResponse} deltaSpan=${deltaSpanSec.toFixed(2)}s ` +
              `deltaBytes[min=${minDeltaBytes === Number.POSITIVE_INFINITY ? 0 : minDeltaBytes},avg=${avgDeltaBytes},max=${maxDeltaBytes}]`,
          );
        }
      });
      session.on('userSpeechStarted', () => {
        touchActivity();
        userSpeaking = true;
        refreshBargeInState();
      });
      session.on('userSpeechStopped', () => {
        userSpeaking = false;
        refreshBargeInState();
      });
      session.on('error', (err) => {
        logger.error(`Realtimeセッションでエラーが発生しました: guild=${guildId}`, err);
      });
      session.on('close', () => {
        queueMicrotask(() => {
          if (generation === realtimeGeneration) scheduleRealtimeRestart('接続が切断された');
        });
      });
    }

    async function openRealtimeSession(): Promise<RealtimeSession> {
      const generation = ++realtimeGeneration;
      const session = await RealtimeSession.connect({
        apiKey: config.openai.apiKey,
        model: config.openai.model,
        voice: config.openai.voice,
        instructions: config.airReading.enabled ? config.airReading.prompt : '',
      });
      bindRealtimeSession(session, generation);
      return session;
    }

    function scheduleRealtimeRestart(reason: string): void {
      if (!runtime.realtimeRecoveryActive || runtime.realtimeRestartTimer) return;

      runtime.realtimeSession = undefined;
      realtimeGeneration += 1;
      userSpeaking = false;
      updateStatus(guildId, { realtimeConnected: false, gptSpeaking: false });
      refreshBargeInState();

      const delayMs = realtimeRestartDelayMs;
      realtimeRestartDelayMs = Math.min(realtimeRestartDelayMs * 2, REALTIME_RESTART_MAX_DELAY_MS);
      logger.warn(`Realtimeセッションを${delayMs}ms後に再接続します: guild=${guildId} reason=${reason}`);

      const timer = setTimeout(() => {
        if (runtime.realtimeRestartTimer !== timer) return;
        runtime.realtimeRestartTimer = undefined;
        if (!runtime.realtimeRecoveryActive) return;

        openRealtimeSession()
          .then((session) => {
            runtime.realtimeSession = session;
            updateStatus(guildId, { realtimeConnected: true });
            logger.info(`Realtimeセッションを再接続しました: guild=${guildId}`);
            const graceTimer = setTimeout(() => {
              if (runtime.realtimeSession === session) {
                realtimeRestartDelayMs = REALTIME_RESTART_INITIAL_DELAY_MS;
              }
            }, REALTIME_RESTART_SUCCESS_GRACE_MS);
            session.once('close', () => clearTimeout(graceTimer));
          })
          .catch((err) => {
            logger.error(`Realtimeセッションの再接続に失敗しました: guild=${guildId}`, err);
            scheduleRealtimeRestart('再接続に失敗');
          });
      }, delayMs);
      runtime.realtimeRestartTimer = timer;
    }

    runtime.realtimeRecoveryActive = true;
    const realtimeSession = await openRealtimeSession();
    runtime.realtimeSession = realtimeSession;

    // Keep the last 60 seconds of the unattenuated Discord + GPT mix. This is deliberately
    // independent of any transcription and never grows beyond its fixed PCM allocation.
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
      clipMixer.addSource('gpt', gptAudioStream);
      clipMixer.start();
      runtime.clipMixer = clipMixer;
      runtime.clipDiscordStream = clipDiscordStream;
      runtime.clipRingBuffer = clipRingBuffer;
    } else {
      logger.warn(
        `クリップを無効化します。INPUTとOUTPUTのsampleRate/channelsを同じ値にしてください: guild=${guildId}`,
      );
    }

    // Jitter-buffer the Realtime API's audio on the same fixed 20ms tick used for the outbound
    // side, instead of handing bursty WebSocket delta chunks straight to Discord.
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
    inboundMixer.addSource('gpt', gptAudioStream);
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

    runtime.inboundMixer = inboundMixer;
    runtime.inboundPlaybackStream = inboundPlaybackStream;
    runtime.audioPlayer = audioPlayer;

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

    // --- Discord -> OpenAI Realtime API (mixed, gated, resampled, sent over the WebSocket) ---
    const mixer = new PcmMixer(
      { sampleRate: config.input.sampleRate, channels: config.input.channels, frameMs: FRAME_MS },
      (frame) => {
        clipDiscordStream?.write(frame);
        // Always forward Discord's actual audio to the Realtime API, even while the model is
        // speaking: the API's own server-side VAD (input_audio_buffer.speech_started) is what
        // drives bargeInActive below, so attenuating/muting this stream first would prevent the
        // API from ever seeing a real interruption to detect in the first place. Ducking the
        // model's own Discord-side playback volume once a barge-in is detected (see
        // inboundMixer above) is the anti-feedback measure instead.
        runtime.realtimeSession?.appendAudio(
          resampleToMono(frame, config.input.sampleRate, config.input.channels, REALTIME_SAMPLE_RATE),
        );
      },
    );

    runtime.mixer = mixer;
    runtime.receiverHandle = attachReceiver(
      connection,
      botUserId,
      mixer,
      config.input.sampleRate,
      config.input.channels,
      touchActivity,
    );
    mixer.start();

    const resource = createAudioResource(inboundPlaybackStream, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
    hasStartedPlaying = true;

    if (config.idleTimeoutMinutes > 0) {
      const idleTimeoutMs = config.idleTimeoutMinutes * 60_000;
      runtime.idleCheckTimer = setInterval(() => {
        if (Date.now() - lastActivityAt < idleTimeoutMs) return;
        logger.info(
          `${config.idleTimeoutMinutes}分間発話がなかったため中継を自動停止します(コスト抑制): guild=${guildId}`,
        );
        void stopRelay(guildId);
      }, IDLE_CHECK_INTERVAL_MS);
    }

    updateStatus(guildId, {
      relayRunning: true,
      realtimeConnected: true,
      gptSpeaking: realtimeSession.isSpeaking(),
      bargeInActive,
      clipBufferRunning: !!clipRingBuffer,
    });

    logger.info(
      `中継開始: guild=${guildId} model=${config.openai.model} voice=${config.openai.voice} ` +
        `bargeIn=${config.bargeIn.enabled} idleTimeoutMinutes=${config.idleTimeoutMinutes}`,
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

  if (runtime.idleCheckTimer) {
    clearInterval(runtime.idleCheckTimer);
    runtime.idleCheckTimer = undefined;
  }

  runtime.realtimeRecoveryActive = false;
  if (runtime.realtimeRestartTimer) {
    clearTimeout(runtime.realtimeRestartTimer);
    runtime.realtimeRestartTimer = undefined;
  }

  runtime.receiverHandle?.detach();
  runtime.receiverHandle = undefined;

  runtime.mixer?.stop();
  runtime.mixer = undefined;

  runtime.clipMixer?.stop();
  runtime.clipMixer = undefined;
  runtime.clipDiscordStream?.destroy();
  runtime.clipDiscordStream = undefined;
  runtime.clipRingBuffer?.clear();
  runtime.clipRingBuffer = undefined;

  runtime.realtimeSession?.close();
  runtime.realtimeSession = undefined;

  runtime.audioPlayer?.stop();
  runtime.audioPlayer = undefined;

  runtime.inboundMixer?.stop();
  runtime.inboundMixer = undefined;

  runtime.inboundPlaybackStream?.destroy();
  runtime.inboundPlaybackStream = undefined;

  updateStatus(guildId, {
    relayRunning: false,
    realtimeConnected: false,
    gptSpeaking: false,
    bargeInActive: false,
    clipBufferRunning: false,
  });

  logger.info(`中継停止: guild=${guildId}`);
}
