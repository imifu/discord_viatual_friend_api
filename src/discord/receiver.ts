import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import { opus } from 'prism-media';
import { createLogger } from '../utils/logger.js';
import type { PcmMixer } from '../audio/pcm-mixer.js';
import { SustainedVoiceActivityGate } from '../audio/voice-activity.js';

const logger = createLogger('receiver');

const OPUS_FRAME_SAMPLES = 960; // 20ms @ 48kHz
/** Max seconds of PCM buffered per user before flushing to onUtterance early, without waiting for
 *  Discord's own speaking-end signal. During continuous speech with few pauses, Discord may not
 *  consider the speaker "done" for a long time, which was delaying trigger-keyword scanning by
 *  tens of seconds (and feeding Whisper an unreasonably long, slow-to-transcribe clip). */
const MAX_UTTERANCE_BUFFER_SECONDS = 4;

export interface ReceiverHandle {
  detach(): void;
}

/** Invoked with a user's PCM and the time that buffered segment began. */
export type UtteranceCallback = (userId: string, pcm: Buffer, timestamp: Date) => void;
/** Invoked only after decoded PCM passes the configured sustained-voice test. */
export type SpeakingStateCallback = (userId: string, speaking: boolean) => void;

export interface UserVoiceActivityOptions {
  threshold: number;
  attackMs: number;
  releaseMs: number;
}

/**
 * Subscribes to every non-bot speaker in the voice connection, decodes their Opus audio to
 * PCM, and feeds it into the mixer. Streams stay open (EndBehaviorType.Manual) for the whole
 * relay session rather than being recreated on every speaking start/stop, to avoid churn.
 *
 * Optionally also accumulates each user's PCM between Discord's own speaking start/end signals
 * and hands off the complete utterance via `onUtterance` - used for utterance-level processing
 * (e.g. speech-to-text) that must not sit in the live mixing path.
 */
export function attachReceiver(
  connection: VoiceConnection,
  botUserId: string,
  mixer: PcmMixer,
  sampleRate: number,
  channels: number,
  onUtterance?: UtteranceCallback,
  onVoiceActivityChange?: SpeakingStateCallback,
  voiceActivityOptions?: UserVoiceActivityOptions,
): ReceiverHandle {
  const receiver = connection.receiver;
  const active = new Map<
    string,
    {
      opusStream: ReturnType<typeof receiver.subscribe>;
      decoder: opus.Decoder;
      voiceActivityGate?: SustainedVoiceActivityGate;
    }
  >();
  const utteranceChunks = new Map<string, Buffer[]>();
  const utteranceBytes = new Map<string, number>();
  const utteranceStartedAt = new Map<string, Date>();
  const maxUtteranceBytes = Math.round(MAX_UTTERANCE_BUFFER_SECONDS * sampleRate * channels * 2);

  const flushUtterance = (userId: string): void => {
    if (!onUtterance) return;
    const chunks = utteranceChunks.get(userId);
    if (!chunks || chunks.length === 0) return;
    const timestamp = utteranceStartedAt.get(userId) ?? new Date();
    utteranceChunks.set(userId, []);
    utteranceBytes.set(userId, 0);
    utteranceStartedAt.set(userId, new Date());
    onUtterance(userId, Buffer.concat(chunks), timestamp);
  };

  const cleanupUser = (userId: string): void => {
    const entry = active.get(userId);
    if (!entry) return;
    flushUtterance(userId);
    entry.voiceActivityGate?.destroy();
    active.delete(userId);
    utteranceChunks.delete(userId);
    utteranceBytes.delete(userId);
    utteranceStartedAt.delete(userId);
    mixer.removeSource(userId);
    entry.opusStream.destroy();
    entry.decoder.destroy();
    logger.info(`音声受信終了: user=${userId}`);
  };

  const onSpeakingStart = (userId: string): void => {
    if (userId === botUserId) return;
    if (active.has(userId)) return;

    logger.info(`音声受信開始: user=${userId}`);
    const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new opus.Decoder({ rate: sampleRate, channels, frameSize: OPUS_FRAME_SAMPLES });
    const pcmStream = opusStream.pipe(decoder);
    const voiceActivityGate =
      onVoiceActivityChange && voiceActivityOptions
        ? new SustainedVoiceActivityGate(
            voiceActivityOptions.threshold,
            voiceActivityOptions.attackMs,
            voiceActivityOptions.releaseMs,
            sampleRate,
            channels,
          )
        : undefined;
    voiceActivityGate?.on('speaking', (speaking) => onVoiceActivityChange?.(userId, speaking));

    active.set(userId, { opusStream, decoder, voiceActivityGate });
    mixer.addSource(userId, pcmStream);

    if (onUtterance) {
      utteranceChunks.set(userId, []);
      utteranceBytes.set(userId, 0);
      utteranceStartedAt.set(userId, new Date());
    }

    if (onUtterance || voiceActivityGate) {
      pcmStream.on('data', (chunk: Buffer) => {
        voiceActivityGate?.observePcmFrame(chunk);
        const chunks = utteranceChunks.get(userId);
        if (!chunks) return;
        chunks.push(chunk);
        const total = (utteranceBytes.get(userId) ?? 0) + chunk.length;
        if (total >= maxUtteranceBytes) {
          flushUtterance(userId);
        } else {
          utteranceBytes.set(userId, total);
        }
      });
    }

    opusStream.once('end', () => cleanupUser(userId));
    opusStream.once('close', () => cleanupUser(userId));
    opusStream.once('error', (err) => {
      logger.error(`音声受信エラー: user=${userId}`, err);
      cleanupUser(userId);
    });
    decoder.once('error', (err) => {
      logger.error(`Opusデコードエラー: user=${userId}`, err);
      cleanupUser(userId);
    });
  };

  const onSpeakingEnd = (userId: string): void => {
    flushUtterance(userId);
    active.get(userId)?.voiceActivityGate?.resetPendingAttack();
  };

  receiver.speaking.on('start', onSpeakingStart);
  if (onUtterance || onVoiceActivityChange) {
    receiver.speaking.on('end', onSpeakingEnd);
  }

  return {
    detach(): void {
      receiver.speaking.off('start', onSpeakingStart);
      if (onUtterance || onVoiceActivityChange) {
        receiver.speaking.off('end', onSpeakingEnd);
      }
      for (const userId of [...active.keys()]) {
        cleanupUser(userId);
      }
    },
  };
}
