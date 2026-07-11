/** Computes the RMS (root-mean-square) amplitude of an s16le PCM frame, normalized to 0-1. */
export function computeRmsRatio(frame: Buffer): number {
  const sampleCount = Math.floor(frame.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = frame.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export function isFrameActive(frame: Buffer, thresholdRatio: number): boolean {
  return computeRmsRatio(frame) > thresholdRatio;
}

/**
 * Tracks whether ChatGPT Live is currently speaking, based on RMS voice activity detection
 * with a release hold: speaking is considered ongoing until `holdMs` pass without any frame
 * exceeding the threshold, to avoid rapid on/off flapping between words.
 */
export class VoiceActivityGate {
  private speaking = false;
  private releaseTimer?: NodeJS.Timeout;

  constructor(
    private readonly thresholdRatio: number,
    private readonly holdMs: number,
    private readonly onSpeakingChange: (speaking: boolean) => void,
  ) {}

  /** Feed a PCM (s16le) frame captured from ChatGPT Live's audio to update speaking state. */
  observeGptFrame(frame: Buffer): void {
    if (!isFrameActive(frame, this.thresholdRatio)) return;

    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
    }
    if (!this.speaking) {
      this.speaking = true;
      this.onSpeakingChange(true);
    }
    this.releaseTimer = setTimeout(() => {
      this.speaking = false;
      this.releaseTimer = undefined;
      this.onSpeakingChange(false);
    }, this.holdMs);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  destroy(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
  }
}
