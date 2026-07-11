import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import { opus } from 'prism-media';
import { createLogger } from '../utils/logger.js';
import type { PcmMixer } from '../audio/pcm-mixer.js';

const logger = createLogger('receiver');

const OPUS_FRAME_SAMPLES = 960; // 20ms @ 48kHz

export interface ReceiverHandle {
  detach(): void;
}

/**
 * Subscribes to every non-bot speaker in the voice connection, decodes their Opus audio to
 * PCM, and feeds it into the mixer. Streams stay open (EndBehaviorType.Manual) for the whole
 * relay session rather than being recreated on every speaking start/stop, to avoid churn.
 */
export function attachReceiver(connection: VoiceConnection, botUserId: string, mixer: PcmMixer, sampleRate: number, channels: number): ReceiverHandle {
  const receiver = connection.receiver;
  const active = new Map<string, { opusStream: ReturnType<typeof receiver.subscribe>; decoder: opus.Decoder }>();

  const cleanupUser = (userId: string): void => {
    const entry = active.get(userId);
    if (!entry) return;
    active.delete(userId);
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

    active.set(userId, { opusStream, decoder });
    mixer.addSource(userId, pcmStream);

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

  receiver.speaking.on('start', onSpeakingStart);

  return {
    detach(): void {
      receiver.speaking.off('start', onSpeakingStart);
      for (const userId of [...active.keys()]) {
        cleanupUser(userId);
      }
    },
  };
}
