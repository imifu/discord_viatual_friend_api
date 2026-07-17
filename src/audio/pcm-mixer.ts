import type { Readable } from 'node:stream';

const BYTES_PER_SAMPLE = 2; // s16le
const DEFAULT_FRAME_MS = 20;
// ~500ms of jitter buffer per source before we start dropping. This default suits sources that
// arrive at roughly real-time pace (e.g. Discord users' Opus packets). It is far too small for a
// source that delivers audio in bursts faster than real-time (e.g. the Realtime API, which sends
// a whole reply's audio across a handful of large chunks within a second or two rather than
// pacing it out over the reply's actual spoken duration) - such a source needs a much larger cap
// via `maxBufferedFrames`, or every burst gets truncated down to its last ~500ms as older frames
// are continuously evicted to make room for newer ones.
const DEFAULT_MAX_BUFFERED_FRAMES = 25;

export interface PcmMixerOptions {
  sampleRate: number;
  channels: number;
  frameMs?: number;
  /** Overrides the default ~500ms jitter-buffer cap (in frames) before older data is dropped. */
  maxBufferedFrames?: number;
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
  private readonly maxBufferedFrames: number;
  private readonly queues = new Map<string, Buffer[]>();
  private readonly queuedBytes = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    options: PcmMixerOptions,
    private readonly sink: (frame: Buffer) => void,
  ) {
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.frameBytes = Math.round(options.sampleRate * (this.frameMs / 1000)) * options.channels * BYTES_PER_SAMPLE;
    this.maxBufferedFrames = options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES;
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

      const maxBytes = this.frameBytes * this.maxBufferedFrames;
      let overflow = total - maxBytes;
      while (overflow > 0 && queue.length > 1) {
        const dropped = queue.shift();
        if (!dropped) break;
        overflow -= dropped.length;
        this.queuedBytes.set(id, (this.queuedBytes.get(id) ?? 0) - dropped.length);
      }
    });
  }

  /** Discards whatever is currently queued for a source without removing it (it keeps receiving
   *  new data). Used to drop a cancelled/interrupted response's still-buffered audio instead of
   *  letting it play out once ducking or muting is lifted. */
  clearSource(id: string): void {
    const queue = this.queues.get(id);
    if (!queue) return;
    queue.length = 0;
    this.queuedBytes.set(id, 0);
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
