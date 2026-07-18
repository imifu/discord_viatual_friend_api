import { spawn } from 'node:child_process';
import { ScreenCaptureError } from '../utils/errors.js';

const DEFAULT_QUALITY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CaptureFrameOptions {
  /** Windows DirectShow device name, e.g. "OBS Virtual Camera". */
  deviceName: string;
  /** ffmpeg -q:v value (2-31, lower = higher quality). */
  quality?: number;
  timeoutMs?: number;
}

/**
 * Grabs a single still frame from a Windows DirectShow video device (e.g. OBS Virtual Camera)
 * via a one-shot ffmpeg subprocess and returns it as JPEG bytes. Pure I/O wrapper with no
 * dependency on Discord or the Realtime session, so it can be reused as-is once frames start
 * being sent to the Realtime API (see Issue #6 Step 2/3).
 */
export function captureFrame(options: CaptureFrameOptions): Promise<Buffer> {
  const quality = options.quality ?? DEFAULT_QUALITY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f',
      'dshow',
      '-i',
      `video=${options.deviceName}`,
      '-frames:v',
      '1',
      '-q:v',
      String(quality),
      '-f',
      'mjpeg',
      'pipe:1',
    ]);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ffmpeg.kill();
      reject(new ScreenCaptureError(new Error(`ffmpegが${timeoutMs}ms以内に応答しませんでした`)));
    }, timeoutMs);

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    ffmpeg.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    ffmpeg.on('error', (err) => {
      finish(() => reject(new ScreenCaptureError(err)));
    });

    ffmpeg.on('close', (code) => {
      finish(() => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          reject(new ScreenCaptureError(new Error(`ffmpegが終了コード${code}で終了しました: ${stderr}`)));
          return;
        }
        const jpeg = Buffer.concat(stdoutChunks);
        if (jpeg.length === 0) {
          reject(new ScreenCaptureError(new Error('ffmpegの出力が空でした')));
          return;
        }
        resolve(jpeg);
      });
    });
  });
}
