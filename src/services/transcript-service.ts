import type { Client } from 'discord.js';
import { ChannelType } from 'discord.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '../utils/logger.js';
import { loadConfig } from '../config/env.js';
import { transcribeJapanese } from '../audio/stt.js';
import { GPT_SPEAKER_ID } from './utterance-recorder.js';
import type { UtteranceEvent } from './utterance-events.js';

const logger = createLogger('transcript-service');

const DISCORD_MESSAGE_LIMIT = 1900;

async function resolveSpeakerName(client: Client, speakerId: string, cache: Map<string, string>): Promise<string> {
  if (speakerId === GPT_SPEAKER_ID) return 'ChatGPT Live';
  const cached = cache.get(speakerId);
  if (cached) return cached;
  try {
    const user = await client.users.fetch(speakerId);
    const name = user.displayName || user.username;
    cache.set(speakerId, name);
    return name;
  } catch {
    return speakerId;
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('ja-JP', { hour12: false });
}

function chunkForDiscord(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > DISCORD_MESSAGE_LIMIT) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < line.length; offset += DISCORD_MESSAGE_LIMIT) {
        chunks.push(line.slice(offset, offset + DISCORD_MESSAGE_LIMIT));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > DISCORD_MESSAGE_LIMIT) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Transcribes everything recorded during a just-finished relay session (in chronological order)
 * and writes the result to a local file and/or a Discord thread, per config. Runs entirely after
 * the live conversation has ended, so it's free to use the more accurate (slower) Whisper model
 * without affecting anything real-time.
 */
export async function finalizeAndPostTranscript(
  guildId: string,
  client: Client,
  utterances: UtteranceEvent[],
): Promise<void> {
  const tempDirs = [...new Set(utterances.map((utterance) => dirname(utterance.pcmFilePath)))];
  try {
    if (utterances.length === 0) return;

    const config = loadConfig();
    if (!config.transcriptLog.enabled) return;

    const sorted = [...utterances].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    const nameCache = new Map<string, string>();

    logger.info(`会話ログの文字起こしを開始します: ${sorted.length}件, guild=${guildId}`);
    const lines: string[] = [];
    for (const utterance of sorted) {
      try {
        const text = utterance.transcript ?? await transcribeUtterance(utterance);
        if (!text) continue;
        const speaker = await resolveSpeakerName(client, utterance.speakerId, nameCache);
        lines.push(`[${formatTime(utterance.startedAt)}] ${speaker}: ${text}`);
      } catch (err) {
        logger.warn(`発話の文字起こしに失敗しました(スキップ): guild=${guildId}`, err);
      }
    }

    if (lines.length === 0) {
      logger.info(`文字起こし結果が空だったため保存をスキップします: guild=${guildId}`);
      return;
    }

    const transcript = lines.join('\n');
    const sessionDate = sorted[0]!.startedAt;
    logger.info(`会話ログの文字起こしが完了しました: ${lines.length}行, guild=${guildId}`);

    if (config.transcriptLog.toFile) {
      await saveToFile(config.transcriptLog.fileDir, guildId, sessionDate, transcript);
    }
    if (config.transcriptLog.toThread && config.transcriptLog.threadChannelId) {
      await postToThread(client, config.transcriptLog.threadChannelId, sessionDate, transcript);
    }
  } finally {
    await Promise.all(
      tempDirs.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch((err) =>
          logger.warn(`会話ログ一時ディレクトリの削除に失敗しました: ${dir}`, err),
        ),
      ),
    );
  }
}

async function transcribeUtterance(utterance: UtteranceEvent): Promise<string> {
  const pcm = await readFile(utterance.pcmFilePath);
  const text = await transcribeJapanese(pcm, utterance.sampleRate, utterance.channels);
  utterance.transcript = text;
  return text;
}

async function saveToFile(dir: string, guildId: string, sessionDate: Date, transcript: string): Promise<void> {
  try {
    const targetDir = join(process.cwd(), dir);
    await mkdir(targetDir, { recursive: true });
    const safeStamp = sessionDate.toISOString().replace(/[:.]/g, '-');
    const filePath = join(targetDir, `transcript-${guildId}-${safeStamp}.txt`);
    await writeFile(filePath, transcript, 'utf8');
    logger.info(`会話ログをファイルに保存しました: ${filePath}`);
  } catch (err) {
    logger.error('会話ログのファイル保存に失敗しました', err);
  }
}

async function postToThread(client: Client, channelId: string, sessionDate: Date, transcript: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      logger.error(`会話ログ投稿先チャンネルが見つからないか、スレッド作成できないタイプです: channelId=${channelId}`);
      return;
    }
    const threadName = `会話ログ ${sessionDate.toLocaleString('ja-JP')}`.slice(0, 100);
    const thread = await channel.threads.create({ name: threadName, autoArchiveDuration: 1440 });
    for (const chunk of chunkForDiscord(transcript)) {
      await thread.send(chunk);
    }
    logger.info(`会話ログをスレッドに投稿しました: thread=${thread.id}`);
  } catch (err) {
    logger.error('会話ログのスレッド投稿に失敗しました', err);
  }
}
