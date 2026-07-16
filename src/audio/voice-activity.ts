import { EventEmitter } from 'node:events';

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

interface VoiceActivityGateEvents {
  speaking: [speaking: boolean];
}

interface SustainedVoiceActivityGateEvents {
  speaking: [speaking: boolean];
}

const START_ACTIVE_FRAMES = 2;
const SPEAKING_THRESHOLD_FACTOR = 0.7;

/**
 * Tracks whether ChatGPT Live is currently speaking, based on RMS voice activity detection
 * with a release hold: speaking is considered ongoing until `holdMs` pass without any frame
 * exceeding the threshold, to avoid rapid on/off flapping between words. Emits a `speaking`
 * event on every transition so other parts of the app (status display, farewell sequencing)
 * can react without the gate needing to know about them.
 */
export class VoiceActivityGate extends EventEmitter<VoiceActivityGateEvents> {
  private speaking = false;
  private consecutiveActiveFrames = 0;
  private releaseTimer?: NodeJS.Timeout;

  constructor(
    private readonly thresholdRatio: number,
    private readonly holdMs: number,
  ) {
    super();
  }

  /** Feed a PCM (s16le) frame captured from ChatGPT Live's audio to update speaking state. */
  observeGptFrame(frame: Buffer): void {
    const threshold = this.speaking
      ? this.thresholdRatio * SPEAKING_THRESHOLD_FACTOR
      : this.thresholdRatio;
    if (!isFrameActive(frame, threshold)) {
      if (!this.speaking) this.consecutiveActiveFrames = 0;
      return;
    }

    if (!this.speaking) {
      this.consecutiveActiveFrames += 1;
      if (this.consecutiveActiveFrames < START_ACTIVE_FRAMES) return;
      this.consecutiveActiveFrames = 0;
      this.speaking = true;
      this.emit('speaking', true);
    }

    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
    }
    this.releaseTimer = setTimeout(() => {
      this.speaking = false;
      this.releaseTimer = undefined;
      this.emit('speaking', false);
    }, this.holdMs);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Resolves once speaking starts, or `false` if `timeoutMs` passes without it starting. */
  waitForSpeakingStart(timeoutMs: number): Promise<boolean> {
    if (this.speaking) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onSpeaking = (speaking: boolean): void => {
        if (!speaking) return;
        clearTimeout(timer);
        this.off('speaking', onSpeaking);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('speaking', onSpeaking);
        resolve(false);
      }, timeoutMs);
      this.on('speaking', onSpeaking);
    });
  }

  /** Resolves once speaking ends, or immediately after `timeoutMs` if it hasn't ended by then. */
  waitForSpeakingEnd(timeoutMs: number): Promise<void> {
    if (!this.speaking) return Promise.resolve();
    return new Promise((resolve) => {
      const onSpeaking = (speaking: boolean): void => {
        if (speaking) return;
        clearTimeout(timer);
        this.off('speaking', onSpeaking);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off('speaking', onSpeaking);
        resolve();
      }, timeoutMs);
      this.on('speaking', onSpeaking);
    });
  }

  destroy(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    this.consecutiveActiveFrames = 0;
    this.speaking = false;
    this.removeAllListeners();
  }
}

/**
 * PCM VAD with a configurable attack and release. It is intended for user-side barge-in:
 * short noises must remain above the threshold for `attackMs` before speaking starts, while a
 * release timer prevents normal gaps between words from rapidly toggling the state.
 */
export class SustainedVoiceActivityGate extends EventEmitter<SustainedVoiceActivityGateEvents> {
  private speaking = false;
  private consecutiveActiveMs = 0;
  private releaseTimer?: NodeJS.Timeout;

  constructor(
    private readonly thresholdRatio: number,
    private readonly attackMs: number,
    private readonly releaseMs: number,
    private readonly sampleRate: number,
    private readonly channels: number,
  ) {
    super();
  }

  observePcmFrame(frame: Buffer): void {
    if (!isFrameActive(frame, this.thresholdRatio)) {
      if (!this.speaking) this.consecutiveActiveMs = 0;
      return;
    }

    if (!this.speaking) {
      const frameDurationMs = (frame.length / (this.sampleRate * this.channels * 2)) * 1000;
      this.consecutiveActiveMs += frameDurationMs;
      if (this.consecutiveActiveMs < this.attackMs) return;
      this.consecutiveActiveMs = 0;
      this.speaking = true;
      this.emit('speaking', true);
    }

    this.scheduleRelease();
  }

  /** Prevents separate Discord speaking bursts from sharing an incomplete attack window. */
  resetPendingAttack(): void {
    if (!this.speaking) this.consecutiveActiveMs = 0;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  destroy(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
    this.consecutiveActiveMs = 0;
    if (this.speaking) {
      this.speaking = false;
      this.emit('speaking', false);
    }
    this.removeAllListeners();
  }

  private scheduleRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      this.speaking = false;
      this.emit('speaking', false);
    }, this.releaseMs);
  }
}
