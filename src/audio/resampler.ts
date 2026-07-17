const BYTES_PER_SAMPLE = 2; // s16le

/** Downmixes s16le PCM of arbitrary sample rate/channel count to mono at `targetSampleRate` (linear-interpolation resample). */
export function resampleToMono(pcm: Buffer, sourceSampleRate: number, sourceChannels: number, targetSampleRate: number): Buffer {
  const bytesPerFrame = BYTES_PER_SAMPLE * sourceChannels;
  const sourceFrameCount = Math.floor(pcm.length / bytesPerFrame);

  const mono = new Int16Array(sourceFrameCount);
  for (let i = 0; i < sourceFrameCount; i++) {
    let sum = 0;
    for (let ch = 0; ch < sourceChannels; ch++) {
      sum += pcm.readInt16LE(i * bytesPerFrame + ch * 2);
    }
    mono[i] = Math.round(sum / sourceChannels);
  }

  if (sourceSampleRate === targetSampleRate || sourceFrameCount === 0) {
    const out = Buffer.alloc(mono.length * BYTES_PER_SAMPLE);
    for (let i = 0; i < mono.length; i++) out.writeInt16LE(mono[i]!, i * 2);
    return out;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.max(1, Math.floor(sourceFrameCount / ratio));
  const out = Buffer.alloc(targetLength * BYTES_PER_SAMPLE);
  for (let i = 0; i < targetLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, sourceFrameCount - 1);
    const frac = srcPos - idx0;
    const sample = mono[idx0]! * (1 - frac) + mono[idx1]! * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample))), i * 2);
  }
  return out;
}

/** Resamples mono s16le PCM to `targetSampleRate` and duplicates it across `targetChannels` (linear-interpolation resample). */
export function resampleFromMono(pcm: Buffer, sourceSampleRate: number, targetSampleRate: number, targetChannels: number): Buffer {
  const sourceFrameCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);

  let resampled: Int16Array;
  if (sourceSampleRate === targetSampleRate || sourceFrameCount === 0) {
    resampled = new Int16Array(sourceFrameCount);
    for (let i = 0; i < sourceFrameCount; i++) resampled[i] = pcm.readInt16LE(i * 2);
  } else {
    const ratio = sourceSampleRate / targetSampleRate;
    const targetLength = Math.max(1, Math.floor(sourceFrameCount / ratio));
    resampled = new Int16Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(idx0 + 1, sourceFrameCount - 1);
      const frac = srcPos - idx0;
      const s0 = pcm.readInt16LE(idx0 * 2);
      const s1 = pcm.readInt16LE(idx1 * 2);
      resampled[i] = Math.max(-32768, Math.min(32767, Math.round(s0 * (1 - frac) + s1 * frac)));
    }
  }

  const out = Buffer.alloc(resampled.length * targetChannels * BYTES_PER_SAMPLE);
  for (let i = 0; i < resampled.length; i++) {
    for (let ch = 0; ch < targetChannels; ch++) {
      out.writeInt16LE(resampled[i]!, (i * targetChannels + ch) * 2);
    }
  }
  return out;
}
