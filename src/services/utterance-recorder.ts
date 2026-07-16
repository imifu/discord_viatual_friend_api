import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, mkdtempSync, type WriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createLogger } from '../utils/logger.js';
import type { VoiceActivityGate } from '../audio/voice-activity.js';
import type { UtteranceEvent, UtteranceListener } from './utterance-events.js';

const logger = createLogger('utterance-recorder');

export const GPT_SPEAKER_ID = 'gpt';

interface UtteranceRecorderEvents {
  utterance: [utterance: UtteranceEvent];
}

export interface UtteranceRecorderOptions {
  vadGate: VoiceActivityGate;
  gptAudioStream: Readable;
  gptSampleRate: number;
  gptChannels: number;
  discordSampleRate: number;
  discordChannels: number;
}

export interface UtteranceRecorderHandle {
  readonly sessionId: string;
  readonly startedAt: Date;
  /** Feed a Discord user's completed utterance. The PCM is persisted before the event is emitted. */
  observeUserUtterance(userId: string, pcm: Buffer, timestamp?: Date): void;
  /** Moves GPT recording to a newly reopened virtual-input stream. */
  replaceGptAudioStream(stream: Readable): void;
  onUtterance(listener: UtteranceListener): void;
  offUtterance(listener: UtteranceListener): void;
  /** Stops recording, flushes pending file writes, and returns every durable utterance. */
  detach(): Promise<UtteranceEvent[]>;
}

/**
 * Persists both sides of a relay session as per-utterance PCM files and publishes each utterance
 * only after its file is durable. Downstream features share the same mutable event object, so a
 * completed utterances can be reused by the post-session transcript service.
 */
export function attachUtteranceRecorder(options: UtteranceRecorderOptions): UtteranceRecorderHandle {
  const {
    vadGate,
    gptAudioStream: initialGptAudioStream,
    gptSampleRate,
    gptChannels,
    discordSampleRate,
    discordChannels,
  } = options;

  const sessionId = randomUUID();
  const startedAt = new Date();
  const tempDir = mkdtempSync(join(tmpdir(), `discord-gptlive-${sessionId}-`));
  const emitter = new EventEmitter<UtteranceRecorderEvents>();
  const utterances: UtteranceEvent[] = [];
  const pendingWrites: Promise<void>[] = [];
  const failedFiles = new Set<string>();
  let publicationChain = Promise.resolve();
  let nextFileId = 1;

  let capturing = false;
  let capturedAt: Date | undefined;
  let capturedFilePath: string | undefined;
  let capturedStream: WriteStream | undefined;
  let capturedWriteCompletion: Promise<void> | undefined;
  let capturedBytes = 0;
  let gptAudioStream = initialGptAudioStream;

  const nextFilePath = (speaker: string): string =>
    join(tempDir, `${String(nextFileId++).padStart(6, '0')}-${speaker}.pcm`);

  const trackWriteStream = (stream: WriteStream, filePath: string): Promise<void> => {
    const completion = finished(stream).catch((err) => {
      failedFiles.add(filePath);
      logger.error(`発話一時ファイルへの書き込みに失敗しました: ${filePath}`, err);
    });
    pendingWrites.push(completion);
    return completion;
  };

  const publishWhenDurable = (utterance: UtteranceEvent, completion: Promise<void>): void => {
    publicationChain = publicationChain
      .then(() => completion)
      .then(() => {
        if (!failedFiles.has(utterance.pcmFilePath)) emitter.emit('utterance', utterance);
      });
    pendingWrites.push(publicationChain);
  };

  const finishGptCapture = (): void => {
    if (!capturing) return;
    capturing = false;
    const stream = capturedStream;
    const filePath = capturedFilePath;
    const completion = capturedWriteCompletion;
    const utteranceStartedAt = capturedAt ?? new Date();
    const endedAt = new Date();
    const bytes = capturedBytes;
    capturedStream = undefined;
    capturedFilePath = undefined;
    capturedWriteCompletion = undefined;
    capturedAt = undefined;
    capturedBytes = 0;
    stream?.end();

    if (filePath && completion && bytes > 0) {
      const utterance: UtteranceEvent = {
        id: randomUUID(),
        sessionId,
        speakerId: GPT_SPEAKER_ID,
        startedAt: utteranceStartedAt,
        endedAt,
        pcmFilePath: filePath,
        sampleRate: gptSampleRate,
        channels: gptChannels,
      };
      utterances.push(utterance);
      publishWhenDurable(utterance, completion);
    }
  };

  const onGptData = (chunk: Buffer): void => {
    if (!capturing || !capturedStream || capturedStream.destroyed) return;
    capturedBytes += chunk.length;
    capturedStream.write(chunk);
  };
  gptAudioStream.on('data', onGptData);

  const onSpeakingChange = (speaking: boolean): void => {
    if (speaking) {
      capturing = true;
      capturedAt = new Date();
      capturedBytes = 0;
      capturedFilePath = nextFilePath(GPT_SPEAKER_ID);
      capturedStream = createWriteStream(capturedFilePath, { flags: 'wx', highWaterMark: 1024 * 1024 });
      capturedWriteCompletion = trackWriteStream(capturedStream, capturedFilePath);
    } else if (capturing) {
      finishGptCapture();
    }
  };
  vadGate.on('speaking', onSpeakingChange);

  function observeUserUtterance(userId: string, pcm: Buffer, timestamp = new Date()): void {
    if (pcm.length === 0) return;
    const filePath = nextFilePath(userId);
    const durationMs = (pcm.length / (discordSampleRate * discordChannels * 2)) * 1000;
    const utterance: UtteranceEvent = {
      id: randomUUID(),
      sessionId,
      speakerId: userId,
      startedAt: timestamp,
      endedAt: new Date(timestamp.getTime() + durationMs),
      pcmFilePath: filePath,
      sampleRate: discordSampleRate,
      channels: discordChannels,
    };
    utterances.push(utterance);
    const completion = writeFile(filePath, pcm).catch((err) => {
      failedFiles.add(filePath);
      logger.error(`発話一時ファイルへの書き込みに失敗しました: ${filePath}`, err);
    });
    pendingWrites.push(completion);
    publishWhenDurable(utterance, completion);
  }

  return {
    sessionId,
    startedAt,
    observeUserUtterance,
    replaceGptAudioStream(stream: Readable): void {
      if (stream === gptAudioStream) return;
      gptAudioStream.off('data', onGptData);
      gptAudioStream = stream;
      gptAudioStream.on('data', onGptData);
    },
    onUtterance(listener: UtteranceListener): void {
      emitter.on('utterance', listener);
    },
    offUtterance(listener: UtteranceListener): void {
      emitter.off('utterance', listener);
    },
    async detach(): Promise<UtteranceEvent[]> {
      gptAudioStream.off('data', onGptData);
      vadGate.off('speaking', onSpeakingChange);
      finishGptCapture();
      await Promise.all(pendingWrites);
      emitter.removeAllListeners();
      const completed = utterances.filter((utterance) => !failedFiles.has(utterance.pcmFilePath));
      if (completed.length === 0) await rm(tempDir, { recursive: true, force: true });
      logger.info(`発話イベント記録を終了します: session=${sessionId} count=${completed.length}`);
      return completed;
    },
  };
}
