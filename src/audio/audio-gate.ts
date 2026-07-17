/** Applies a linear gain to signed 16-bit PCM, clamping at the format limits. */
export function applyPcmGain(frame: Buffer, level: number): Buffer {
  if (level === 1) return frame;
  if (level <= 0) return Buffer.alloc(frame.length);

  const out = Buffer.alloc(frame.length);
  const sampleCount = Math.floor(frame.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * 2);
    const adjusted = Math.max(-32768, Math.min(32767, Math.round(sample * level)));
    out.writeInt16LE(adjusted, i * 2);
  }
  return out;
}
