import type { Readable } from 'node:stream';

const BYTES_PER_SAMPLE = 2; // s16le
const DEFAULT_FRAME_MS = 20;
const MAX_BUFFERED_FRAMES = 25; // ~500ms of jitter buffer per source before we start dropping

export interface PcmMixerOptions {
  sampleRate: number;
  channels: number;
  frameMs?: number;
}

/**
 * Mixes PCM (s16le) audio from multiple concurrently-speaking Discord users into a single
 * continuous stream, ticking on a fixed timer so the output device always receives audio
 * (silence when nobody is speaking) regardless of the bursty/jittery timing of incoming
 * per-user Opus packets.
 */
export class PcmMixer {
  private readonly frameBytes: number;
  private readonly frameMs: number;
  private readonly queues = new Map<string, Buffer[]>();
  private readonly queuedBytes = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    options: PcmMixerOptions,
    private readonly sink: (frame: Buffer) => void,
  ) {
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.frameBytes = Math.round(options.sampleRate * (this.frameMs / 1000)) * options.channels * BYTES_PER_SAMPLE;
  }

  addSource(id: string, stream: Readable): void {
    this.queues.set(id, []);
    this.queuedBytes.set(id, 0);

    stream.on('data', (chunk: Buffer) => {
      const queue = this.queues.get(id);
      if (!queue) return;
      queue.push(chunk);
      const total = (this.queuedBytes.get(id) ?? 0) + chunk.length;
      this.queuedBytes.set(id, total);

      const maxBytes = this.frameBytes * MAX_BUFFERED_FRAMES;
      let overflow = total - maxBytes;
      while (overflow > 0 && queue.length > 1) {
        const dropped = queue.shift();
        if (!dropped) break;
        overflow -= dropped.length;
        this.queuedBytes.set(id, (this.queuedBytes.get(id) ?? 0) - dropped.length);
      }
    });
  }

  removeSource(id: string): void {
    this.queues.delete(id);
    this.queuedBytes.delete(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.frameMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.queues.clear();
    this.queuedBytes.clear();
  }

  private popFrame(id: string): Buffer | undefined {
    const queue = this.queues.get(id);
    if (!queue || queue.length === 0) return undefined;

    const available = queue.length === 1 ? queue[0]! : Buffer.concat(queue);
    if (available.length < this.frameBytes) {
      queue.length = 0;
      this.queuedBytes.set(id, 0);
      return Buffer.concat([available, Buffer.alloc(this.frameBytes - available.length)]);
    }

    const frame = available.subarray(0, this.frameBytes);
    const rest = available.subarray(this.frameBytes);
    queue.length = 0;
    if (rest.length > 0) {
      queue.push(Buffer.from(rest));
    }
    this.queuedBytes.set(id, rest.length);
    return Buffer.from(frame);
  }

  private tick(): void {
    if (this.queues.size === 0) {
      this.sink(Buffer.alloc(this.frameBytes));
      return;
    }

    const sampleCount = this.frameBytes / BYTES_PER_SAMPLE;
    const mixed = new Int32Array(sampleCount);
    let anyContributed = false;

    for (const id of this.queues.keys()) {
      const frame = this.popFrame(id);
      if (!frame) continue;
      anyContributed = true;
      for (let i = 0; i < sampleCount; i++) {
        mixed[i]! += frame.readInt16LE(i * 2);
      }
    }

    if (!anyContributed) {
      this.sink(Buffer.alloc(this.frameBytes));
      return;
    }

    const out = Buffer.alloc(this.frameBytes);
    for (let i = 0; i < sampleCount; i++) {
      const clamped = Math.max(-32768, Math.min(32767, mixed[i]!));
      out.writeInt16LE(clamped, i * 2);
    }
    this.sink(out);
  }
}
