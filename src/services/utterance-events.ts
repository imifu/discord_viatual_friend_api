/** A single durable utterance shared by transcripts, summaries, and future consumers. */
export interface UtteranceEvent {
  id: string;
  sessionId: string;
  speakerId: string;
  startedAt: Date;
  endedAt: Date;
  pcmFilePath: string;
  sampleRate: number;
  channels: number;
  /** Filled by the first STT consumer so later consumers can reuse the result. */
  transcript?: string;
}

export type UtteranceListener = (utterance: UtteranceEvent) => void;
