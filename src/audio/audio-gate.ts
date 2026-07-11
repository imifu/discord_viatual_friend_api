export interface DiscordInputGateOptions {
  ducking: boolean;
  duckingLevel: number;
}

/**
 * Applies half-duplex gating to a Discord -> ChatGPT Live PCM frame: when `gated` is true
 * (ChatGPT Live is speaking, or within its release hold), the frame is either attenuated
 * (ducking) or fully silenced, to prevent ChatGPT Live's own voice from being fed back to it.
 */
export function applyDiscordInputGate(frame: Buffer, gated: boolean, options: DiscordInputGateOptions): Buffer {
  if (!gated) return frame;
  if (!options.ducking) return Buffer.alloc(frame.length);

  const out = Buffer.alloc(frame.length);
  const sampleCount = Math.floor(frame.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * 2);
    const attenuated = Math.max(-32768, Math.min(32767, Math.round(sample * options.duckingLevel)));
    out.writeInt16LE(attenuated, i * 2);
  }
  return out;
}
