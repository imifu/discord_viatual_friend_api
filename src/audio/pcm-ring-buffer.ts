const BYTES_PER_SAMPLE = 2;

export interface PcmSnapshot {
  pcm: Buffer;
  durationSeconds: number;
}

/** Fixed-size circular buffer for interleaved signed 16-bit little-endian PCM. */
export class PcmRingBuffer {
  private readonly storage: Buffer;
  private readonly bytesPerFrame: number;
  private writeOffset = 0;
  private usedBytes = 0;

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    readonly maxSeconds: number,
  ) {
    this.bytesPerFrame = channels * BYTES_PER_SAMPLE;
    const capacity = Math.floor((sampleRate * channels * BYTES_PER_SAMPLE * maxSeconds) / this.bytesPerFrame) * this.bytesPerFrame;
    if (sampleRate <= 0 || channels <= 0 || maxSeconds <= 0 || capacity === 0) {
      throw new RangeError('PCMリングバッファの音声形式と保持秒数は正の値である必要があります。');
    }
    this.storage = Buffer.alloc(capacity);
  }

  get durationSeconds(): number {
    return this.usedBytes / (this.sampleRate * this.bytesPerFrame);
  }

  push(chunk: Buffer): void {
    const alignedLength = chunk.length - (chunk.length % this.bytesPerFrame);
    if (alignedLength <= 0) return;

    if (alignedLength >= this.storage.length) {
      chunk.copy(this.storage, 0, alignedLength - this.storage.length, alignedLength);
      this.writeOffset = 0;
      this.usedBytes = this.storage.length;
      return;
    }

    const firstLength = Math.min(alignedLength, this.storage.length - this.writeOffset);
    chunk.copy(this.storage, this.writeOffset, 0, firstLength);
    const remaining = alignedLength - firstLength;
    if (remaining > 0) chunk.copy(this.storage, 0, firstLength, firstLength + remaining);

    this.writeOffset = (this.writeOffset + alignedLength) % this.storage.length;
    this.usedBytes = Math.min(this.storage.length, this.usedBytes + alignedLength);
  }

  snapshot(seconds = this.maxSeconds): PcmSnapshot {
    const requested = Math.floor((seconds * this.sampleRate * this.bytesPerFrame) / this.bytesPerFrame) * this.bytesPerFrame;
    const byteLength = Math.min(this.usedBytes, Math.max(0, requested));
    if (byteLength === 0) return { pcm: Buffer.alloc(0), durationSeconds: 0 };

    const output = Buffer.alloc(byteLength);
    const start = (this.writeOffset - byteLength + this.storage.length) % this.storage.length;
    const firstLength = Math.min(byteLength, this.storage.length - start);
    this.storage.copy(output, 0, start, start + firstLength);
    if (firstLength < byteLength) this.storage.copy(output, firstLength, 0, byteLength - firstLength);

    return {
      pcm: output,
      durationSeconds: byteLength / (this.sampleRate * this.bytesPerFrame),
    };
  }

  clear(): void {
    this.writeOffset = 0;
    this.usedBytes = 0;
  }
}

export function encodePcm16Wav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const headerSize = 44;
  const wav = Buffer.alloc(headerSize + pcm.length);
  const blockAlign = channels * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, headerSize);
  return wav;
}

/** Downmixes interleaved signed 16-bit PCM to mono, primarily to keep 60-second clips uploadable. */
export function downmixPcm16ToMono(pcm: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm;
  const frameCount = Math.floor(pcm.length / (channels * BYTES_PER_SAMPLE));
  const mono = Buffer.alloc(frameCount * BYTES_PER_SAMPLE);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += pcm.readInt16LE((frame * channels + channel) * BYTES_PER_SAMPLE);
    }
    mono.writeInt16LE(Math.round(sum / channels), frame * BYTES_PER_SAMPLE);
  }
  return mono;
}
