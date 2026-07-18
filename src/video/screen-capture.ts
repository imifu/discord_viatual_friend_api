import { spawn } from 'node:child_process';
import { ScreenCaptureBusyError, ScreenCaptureError } from '../utils/errors.js';

// Capture design (fixed for now; see Issue #6 Step 1/2 discussion, tuned after real-device
// testing): OBS's Base Canvas is 1920x1080, downscaled here to 640x360 before JPEG-encoding at
// ~quality 65. Since SCREEN_CAPTURE_DETAIL defaults to 'low' (a fixed token cost regardless of
// resolution), this downscale mainly reduces the base64 payload size, network transfer, and
// send latency rather than Realtime API image-token cost. A future periodic-capture mode
// (Issue #20 / Step 3) is intended to send at 1fps - not relevant to this single-shot capture,
// but noted here since it uses the same encoding settings.
const DEFAULT_OUTPUT_WIDTH = 640;
const DEFAULT_OUTPUT_HEIGHT = 360;
// Standard 0-100 JPEG quality convention (higher = better), converted below to ffmpeg's mjpeg
// -q:v scale (2-31, lower = better) - ffmpeg has no direct 0-100 quality flag for this encoder.
const DEFAULT_QUALITY = 65;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CaptureFrameOptions {
  /** Windows DirectShow device name, e.g. "OBS Virtual Camera". */
  deviceName: string;
  /** Standard 0-100 JPEG quality (higher = better). */
  quality?: number;
  /** Output frame size in pixels; the captured frame is scaled down/up to this. */
  outputWidth?: number;
  outputHeight?: number;
  timeoutMs?: number;
}

/** Approximates a 0-100 JPEG quality (higher = better) as ffmpeg's mjpeg -q:v scale (2-31, lower
 *  = better). ffmpeg has no exact standard-JPEG-quality equivalent for this encoder, so this is a
 *  linear approximation, not a precise conversion. */
function qualityToFfmpegQscale(quality: number): number {
  const clamped = Math.max(0, Math.min(100, quality));
  return Math.round(2 + (100 - clamped) * ((31 - 2) / 100));
}

// A DirectShow capture device typically only accepts one open handle at a time, so a second
// ffmpeg process launched while one is already running would just fail with a device-busy error
// from ffmpeg itself. Reject fast with a clear message instead of spawning a second process that
// is very likely to fail anyway. Single flag is enough: this app runs as one process, and Step 1
// only ever has one caller (the /cap command handler).
let captureInFlight = false;

/**
 * Grabs a single still frame from a Windows DirectShow video device (e.g. OBS Virtual Camera)
 * via a one-shot ffmpeg subprocess and returns it as JPEG bytes. Pure I/O wrapper with no
 * dependency on Discord or the Realtime session, so it can be reused as-is once frames start
 * being sent to the Realtime API (see Issue #6 Step 2/3).
 */
export function captureFrame(options: CaptureFrameOptions): Promise<Buffer> {
  if (captureInFlight) {
    return Promise.reject(new ScreenCaptureBusyError());
  }
  captureInFlight = true;

  const qscale = qualityToFfmpegQscale(options.quality ?? DEFAULT_QUALITY);
  const outputWidth = options.outputWidth ?? DEFAULT_OUTPUT_WIDTH;
  const outputHeight = options.outputHeight ?? DEFAULT_OUTPUT_HEIGHT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f',
      'dshow',
      '-i',
      `video=${options.deviceName}`,
      '-frames:v',
      '1',
      '-vf',
      `scale=${outputWidth}:${outputHeight}`,
      '-q:v',
      String(qscale),
      '-f',
      'mjpeg',
      'pipe:1',
    ]);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    // All exit paths (timeout, spawn error, process close) must go through this so
    // captureInFlight is always released exactly once - see the timeout callback below, which
    // used to bypass this and leave captureInFlight stuck at true forever after any timeout.
    // `timeout` is referenced here but only initialized on the next line - safe because this
    // body only runs later, once the `const timeout` assignment below has already completed.
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      captureInFlight = false;
      fn();
    };

    const timeout = setTimeout(() => {
      ffmpeg.kill();
      finish(() => reject(new ScreenCaptureError(new Error(`ffmpegが${timeoutMs}ms以内に応答しませんでした`))));
    }, timeoutMs);

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
