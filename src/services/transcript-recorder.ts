// Compatibility exports for code that used the pre-event name.
export {
  GPT_SPEAKER_ID,
  attachUtteranceRecorder as attachTranscriptRecorder,
  type UtteranceRecorderHandle as TranscriptRecorderHandle,
  type UtteranceRecorderOptions as TranscriptRecorderOptions,
} from './utterance-recorder.js';
export type { UtteranceEvent as RecordedUtterance } from './utterance-events.js';
