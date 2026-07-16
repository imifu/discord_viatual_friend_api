import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downmixPcm16ToMono, encodePcm16Wav } from '../audio/pcm-ring-buffer.js';
import { getRuntime } from '../state/bridge-state.js';
import { getStatus } from '../state/bridge-state.js';
import { ClipUnavailableError } from '../utils/errors.js';

export const MAX_CLIP_SECONDS = 60;

export interface SavedClip {
  filePath: string;
  durationSeconds: number;
}

export async function saveRecentClip(guildId: string, requestedSeconds: number): Promise<SavedClip> {
  const ring = getRuntime(guildId).clipRingBuffer;
  if (!ring) {
    const reason = getStatus(guildId).relayRunning
      ? 'INPUTとOUTPUTのサンプルレート・チャンネル数が一致していません。'
      : '音声中継が開始されていません。';
    throw new ClipUnavailableError(reason);
  }

  const seconds = Math.max(1, Math.min(MAX_CLIP_SECONDS, requestedSeconds));
  const snapshot = ring.snapshot(seconds);
  if (snapshot.pcm.length === 0) throw new ClipUnavailableError('保存できる音声がまだありません。');

  const dir = join(process.cwd(), 'clips');
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(dir, `clip-${guildId}-${timestamp}.wav`);
  const pcm = downmixPcm16ToMono(snapshot.pcm, ring.channels);
  await writeFile(filePath, encodePcm16Wav(pcm, ring.sampleRate, 1));

  return { filePath, durationSeconds: snapshot.durationSeconds };
}
