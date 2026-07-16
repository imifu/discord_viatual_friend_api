import { Worker } from 'node:worker_threads';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('stt');

const TARGET_SAMPLE_RATE = 16000;
const MIN_TRANSCRIBABLE_SAMPLES = TARGET_SAMPLE_RATE * 0.3; // skip clips shorter than ~300ms
/** Bound on queued (not yet started) scan jobs. Under normal conversational pacing this queue
 *  stays near-empty; it only grows during unusually long non-stop speech, in which case we drop
 *  the OLDEST queued jobs (staler, less likely to still be relevant) rather than refusing new
 *  ones - detection lags behind but nothing recent is silently skipped. */
const MAX_QUEUED_SCANS = 6;

export type WorkerPurpose = 'scan' | 'capture';

/** Scanning runs once per Discord utterance (frequent, often overlapping live conversation), so
 *  it must stay CPU-light even in a separate thread - CPU is a shared, finite resource, and a
 *  heavy model here was starving the real-time audio pipeline's own threads (RtAudio, mixer
 *  ticks), making the live conversation itself feel laggy. Capture runs once per trigger (rare),
 *  so it can afford a larger, more accurate model. */
const WORKER_MODELS: Record<WorkerPurpose, string> = {
  scan: 'Xenova/whisper-small',
  capture: 'Xenova/whisper-medium',
};
/** Scan stays to a single ONNX thread to leave the most CPU headroom for the live audio pipeline;
 *  capture (rare) can use a couple more for a bit more speed. */
const WORKER_INTRA_OP_THREADS: Record<WorkerPurpose, number> = {
  scan: 1,
  capture: 2,
};

interface WorkerResponse {
  id: number;
  text?: string;
  error?: string;
}

const workers = new Map<WorkerPurpose, Worker>();
let nextId = 1;
type PendingRequest = { resolve: (text: string) => void; reject: (err: Error) => void };
const pendingByPurpose: Record<WorkerPurpose, Map<number, PendingRequest>> = {
  scan: new Map(),
  capture: new Map(),
};

function rejectPending(purpose: WorkerPurpose, err: Error): void {
  const pending = pendingByPurpose[purpose];
  for (const entry of pending.values()) entry.reject(err);
  pending.clear();
}

/**
 * Speech-to-text runs on dedicated worker threads. Whisper inference (and its JS-side audio
 * preprocessing) is CPU-heavy enough to block Node's event loop for seconds at a time; running it
 * on the main thread was starving Discord's gateway/interaction handling, causing command
 * timeouts ("Unknown interaction") whenever someone spoke. Moving it off-thread guarantees the
 * live audio relay and Discord commands are never delayed by transcription.
 *
 * Trigger scanning and high-accuracy capture each get their own worker so a burst
 * in one feature cannot delay another. Each worker's model is fixed at construction time.
 */
function getWorker(purpose: WorkerPurpose): Worker {
  let w = workers.get(purpose);
  if (!w) {
    const workerUrl = new URL('./stt-worker.js', import.meta.url);
    logger.info(`STT worker(${purpose}, ${WORKER_MODELS[purpose]})を起動します`);
    w = new Worker(workerUrl, {
      workerData: { model: WORKER_MODELS[purpose], intraOpNumThreads: WORKER_INTRA_OP_THREADS[purpose] },
    });
    workers.set(purpose, w);

    w.on('message', (msg: WorkerResponse) => {
      const pending = pendingByPurpose[purpose];
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.text ?? '');
    });
    w.on('error', (err) => {
      logger.error(`STT worker(${purpose})でエラーが発生しました`, err);
      if (workers.get(purpose) === w) {
        workers.delete(purpose);
        rejectPending(purpose, err);
      }
    });
    w.on('exit', (code) => {
      if (code !== 0) logger.warn(`STT worker(${purpose})が異常終了しました: code=${code}`);
      if (workers.get(purpose) === w) {
        workers.delete(purpose);
        rejectPending(purpose, new Error(`STT worker(${purpose}) exited with code ${code}`));
      }
    });
  }
  return w;
}

/** Kicks off selected model loading early so the first real transcription isn't slowed down by it. */
export function preloadSttModel(purposes: WorkerPurpose[] = ['scan', 'capture']): void {
  for (const purpose of new Set(purposes)) {
    getWorker(purpose).postMessage({ id: 0, preload: true });
  }
}

/** Downmixes s16le PCM of arbitrary sample rate/channel count to 16kHz mono Float32 (linear-interpolation resample). */
function pcmToFloat32Mono16k(pcm: Buffer, sourceSampleRate: number, sourceChannels: number): Float32Array {
  const bytesPerFrame = 2 * sourceChannels;
  const sourceFrameCount = Math.floor(pcm.length / bytesPerFrame);

  const mono = new Float32Array(sourceFrameCount);
  for (let i = 0; i < sourceFrameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < sourceChannels; ch++) {
      sum += pcm.readInt16LE(i * bytesPerFrame + ch * 2);
    }
    mono[i] = sum / sourceChannels / 32768;
  }

  if (sourceSampleRate === TARGET_SAMPLE_RATE || sourceFrameCount === 0) {
    return mono;
  }

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const targetLength = Math.max(1, Math.floor(sourceFrameCount / ratio));
  const out = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, sourceFrameCount - 1);
    const frac = srcPos - idx0;
    out[i] = mono[idx0]! * (1 - frac) + mono[idx1]! * frac;
  }
  return out;
}

function transcribe(pcm: Buffer, sampleRate: number, channels: number, purpose: WorkerPurpose): Promise<string> {
  const audio = pcmToFloat32Mono16k(pcm, sampleRate, channels);
  if (audio.length < MIN_TRANSCRIBABLE_SAMPLES) return Promise.resolve('');

  const id = nextId++;
  return new Promise((resolve, reject) => {
    const pending = pendingByPurpose[purpose];
    pending.set(id, { resolve, reject });
    try {
      getWorker(purpose).postMessage({ id, pcm: audio }, [audio.buffer as ArrayBuffer]);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Transcribes s16le PCM audio to Japanese text using a local Whisper model (no external API),
 * off the main thread. Intended for one-shot, low-frequency calls such as transcribing ChatGPT
 * Live's captured reply after a trigger fires.
 */
export function transcribeJapanese(pcm: Buffer, sampleRate: number, channels: number): Promise<string> {
  return transcribe(pcm, sampleRate, channels, 'capture');
}

interface ScanJob {
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  resolve: (text: string | null) => void;
}

let scanInFlight = false;
const scanQueue: ScanJob[] = [];

/**
 * Transcribes s16le PCM audio for trigger-keyword scanning. Jobs are queued and processed in
 * order (nothing recent is silently skipped); if the queue backs up beyond MAX_QUEUED_SCANS, the
 * oldest queued (not yet started) jobs are dropped to bound worst-case detection lag.
 */
export function scanForTriggerJapanese(pcm: Buffer, sampleRate: number, channels: number): Promise<string | null> {
  return new Promise((resolve) => {
    scanQueue.push({ pcm, sampleRate, channels, resolve });
    while (scanQueue.length > MAX_QUEUED_SCANS) {
      const dropped = scanQueue.shift();
      dropped?.resolve(null);
    }
    pumpScanQueue();
  });
}

function pumpScanQueue(): void {
  if (scanInFlight) return;
  const job = scanQueue.shift();
  if (!job) return;
  scanInFlight = true;

  transcribe(job.pcm, job.sampleRate, job.channels, 'scan')
    .then((text) => job.resolve(text))
    .catch((err) => {
      logger.warn('スキャン用STTでエラーが発生しました', err);
      job.resolve(null);
    })
    .finally(() => {
      scanInFlight = false;
      pumpScanQueue();
    });
}
