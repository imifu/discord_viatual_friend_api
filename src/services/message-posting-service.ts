import type { Client } from 'discord.js';
import type { Readable } from 'node:stream';
import { createLogger } from '../utils/logger.js';
import { scanForTriggerJapanese, transcribeJapanese } from '../audio/stt.js';
import type { VoiceActivityGate } from '../audio/voice-activity.js';

const logger = createLogger('message-posting');

/** If ChatGPT Live doesn't start replying within this long after a trigger is detected, give up
 *  and clear the pending state - otherwise a stale flag could latch onto a much later, unrelated
 *  reply and post the wrong content. */
const AWAITING_REPLY_TIMEOUT_MS = 12_000;
const TRIGGER_SCAN_OVERLAP_MS = 750;
const MAX_REPLY_CAPTURE_MS = 60_000;

export interface MessagePostingOptions {
  client: Client;
  channelId: string;
  triggerKeywords: string[];
  vadGate: VoiceActivityGate;
  /** Raw PCM stream of ChatGPT Live's audio (same source tapped for VAD), used to capture the reply to post. */
  gptAudioStream: Readable;
  gptSampleRate: number;
  gptChannels: number;
  /** Format of the PCM utterances passed to `observeUserUtterance` (i.e. the Discord receive format). */
  discordSampleRate: number;
  discordChannels: number;
}

export interface MessagePostingHandle {
  /** Feed a Discord user's completed utterance (raw PCM, in discordSampleRate/discordChannels format) for trigger-keyword detection. */
  observeUserUtterance(userId: string, pcm: Buffer): void;
  /** Moves GPT reply capture to a newly reopened virtual-input stream. */
  replaceGptAudioStream(stream: Readable): void;
  detach(): void;
}

/**
 * Watches Discord users' speech for a trigger keyword (e.g. "投稿して"); when found, captures
 * ChatGPT Live's next spoken reply (via the existing VAD speaking events), transcribes it, and
 * posts the text to a fixed Discord text channel. Runs entirely off the live audio path - it
 * only taps/reads streams that already exist, so it cannot introduce delay into the voice relay.
 */
export function attachMessagePosting(options: MessagePostingOptions): MessagePostingHandle {
  const {
    client,
    channelId,
    triggerKeywords,
    vadGate,
    gptAudioStream: initialGptAudioStream,
    gptSampleRate,
    gptChannels,
    discordSampleRate,
    discordChannels,
  } = options;

  let awaitingReply = false;
  let awaitingReplyTimer: NodeJS.Timeout | undefined;
  let capturing = false;
  let capturedChunks: Buffer[] = [];
  let capturedBytes = 0;
  let captureTimer: NodeJS.Timeout | undefined;
  let active = true;
  let gptAudioStream = initialGptAudioStream;
  const scanTails = new Map<string, Buffer>();
  const scanOverlapBytes = Math.round((discordSampleRate * discordChannels * 2 * TRIGGER_SCAN_OVERLAP_MS) / 1000);
  const maxCaptureBytes = Math.round((gptSampleRate * gptChannels * 2 * MAX_REPLY_CAPTURE_MS) / 1000);

  const clearAwaitingReplyTimer = (): void => {
    if (awaitingReplyTimer) {
      clearTimeout(awaitingReplyTimer);
      awaitingReplyTimer = undefined;
    }
  };

  const setAwaitingReply = (): void => {
    awaitingReply = true;
    clearAwaitingReplyTimer();
    awaitingReplyTimer = setTimeout(() => {
      awaitingReplyTimer = undefined;
      if (awaitingReply && !capturing) {
        awaitingReply = false;
        logger.warn('投稿トリガー検知後、GPTの応答を一定時間内に捕捉できなかったため取り消します');
      }
    }, AWAITING_REPLY_TIMEOUT_MS);
  };

  const clearCaptureTimer = (): void => {
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = undefined;
    }
  };

  const resetCapture = (): void => {
    clearCaptureTimer();
    capturing = false;
    awaitingReply = false;
    capturedChunks = [];
    capturedBytes = 0;
  };

  const cancelCapture = (reason: string): void => {
    if (!capturing) return;
    resetCapture();
    logger.warn(`GPT発話のキャプチャを取り消しました: ${reason}`);
  };

  const onGptData = (chunk: Buffer): void => {
    if (!capturing) return;
    if (capturedBytes + chunk.length > maxCaptureBytes) {
      cancelCapture(`録音サイズが${MAX_REPLY_CAPTURE_MS / 1000}秒相当の上限を超過`);
      return;
    }
    capturedChunks.push(chunk);
    capturedBytes += chunk.length;
  };
  gptAudioStream.on('data', onGptData);

  async function postText(text: string): Promise<void> {
    if (!active) return;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!active) return;
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        logger.error(`投稿先チャンネルが見つからないか、テキスト投稿できません: channelId=${channelId}`);
        return;
      }
      await channel.send(text);
      logger.info(`メッセージを投稿しました: channel=${channelId}`);
    } catch (err) {
      logger.error('メッセージ投稿に失敗しました', err);
    }
  }

  async function handleCapturedReply(pcm: Buffer): Promise<void> {
    try {
      const text = await transcribeJapanese(pcm, gptSampleRate, gptChannels);
      if (!active) return;
      if (!text) {
        logger.warn('GPT発話の文字起こし結果が空だったため投稿をスキップします');
        return;
      }
      logger.info(`GPT発話を文字起こしして投稿します: "${text}"`);
      await postText(text);
    } catch (err) {
      logger.error('GPT発話の文字起こしに失敗しました', err);
    }
  }

  const startCapturing = (): void => {
    if (!active) return;
    clearAwaitingReplyTimer();
    clearCaptureTimer();
    capturing = true;
    capturedChunks = [];
    capturedBytes = 0;
    captureTimer = setTimeout(
      () => cancelCapture(`録音時間が${MAX_REPLY_CAPTURE_MS / 1000}秒の上限に到達`),
      MAX_REPLY_CAPTURE_MS,
    );
    logger.info('投稿トリガー検知済み: GPT発話のキャプチャを開始します');
  };

  const onSpeakingChange = (speaking: boolean): void => {
    if (speaking && awaitingReply) {
      startCapturing();
    } else if (!speaking && capturing) {
      const pcm = Buffer.concat(capturedChunks);
      resetCapture();
      void handleCapturedReply(pcm);
    }
  };
  vadGate.on('speaking', onSpeakingChange);

  function observeUserUtterance(userId: string, pcm: Buffer): void {
    if (!active) return;
    const previousTail = scanTails.get(userId);
    const scanPcm = previousTail && previousTail.length > 0 ? Buffer.concat([previousTail, pcm]) : pcm;
    scanTails.set(userId, Buffer.from(scanPcm.subarray(Math.max(0, scanPcm.length - scanOverlapBytes))));
    void (async () => {
      try {
        const text = await scanForTriggerJapanese(scanPcm, discordSampleRate, discordChannels);
        if (!active) return;
        if (!text) return;
        logger.debug(`ユーザー発話を認識: user=${userId} text="${text}"`);
        if (triggerKeywords.some((keyword) => text.includes(keyword))) {
          if (awaitingReply || capturing) return;
          logger.info(`投稿トリガーを検知しました: user=${userId} text="${text}"`);
          // If ChatGPT Live is already mid-reply by the time detection catches up (STT lags
          // behind live speech), start capturing immediately instead of waiting for the next
          // speaking transition, which may never come or may belong to an unrelated utterance.
          if (vadGate.isSpeaking() && !capturing) {
            startCapturing();
          } else {
            setAwaitingReply();
          }
        }
      } catch (err) {
        logger.error(`ユーザー発話の文字起こしに失敗しました: user=${userId}`, err);
      }
    })();
  }

  return {
    observeUserUtterance,
    replaceGptAudioStream(stream: Readable): void {
      if (stream === gptAudioStream) return;
      gptAudioStream.off('data', onGptData);
      gptAudioStream = stream;
      gptAudioStream.on('data', onGptData);
    },
    detach(): void {
      active = false;
      clearAwaitingReplyTimer();
      resetCapture();
      scanTails.clear();
      gptAudioStream.off('data', onGptData);
      vadGate.off('speaking', onSpeakingChange);
    },
  };
}
