import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { FfmpegProcessError } from '../utils/errors.js';

const logger = createLogger('ffmpeg');

const STDERR_TAIL_MAX = 2000;

/**
 * Spawns an ffmpeg process with an argv array (never a shell string), so device names
 * containing spaces or non-ASCII characters are passed through safely without injection risk.
 */
export function spawnFfmpeg(
  args: string[],
  context: string,
  onUnexpectedExit?: (code: number | null) => void,
): ChildProcessWithoutNullStreams {
  logger.info(`FFmpeg起動: context=${context}`);
  const proc = spawn('ffmpeg', args, { windowsHide: true });

  let stderrTail = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_MAX);
    if (/error|failed|cannot|invalid|unable/i.test(text)) {
      logger.warn(`FFmpeg[${context}] stderr: ${text.trim()}`);
    }
  });

  proc.on('error', (err) => {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      logger.error(`FFmpegが見つかりません(context=${context})。PATHを確認してください。`);
    } else {
      logger.error(`FFmpeg起動エラー(context=${context})`, err);
    }
  });

  proc.on('exit', (code, signal) => {
    logger.info(`FFmpeg終了: context=${context} code=${code} signal=${signal ?? 'none'}`);
    const killedByUs = signal === 'SIGTERM' || signal === 'SIGKILL';
    if (!killedByUs && code !== 0 && code !== null) {
      const error = new FfmpegProcessError(context, code, stderrTail);
      logger.error(`FFmpegが異常終了しました(context=${context})`, error);
      onUnexpectedExit?.(code);
    }
  });

  return proc;
}
