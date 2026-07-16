import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

/** Model and thread budget for this worker are fixed at construction time via workerData (see
 *  stt.ts) - each worker instance only ever serves one purpose (scanning or capture). */
const data = workerData as { model?: string; intraOpNumThreads?: number } | undefined;
const MODEL_NAME: string = data?.model ?? 'Xenova/whisper-small';
const INTRA_OP_NUM_THREADS: number = data?.intraOpNumThreads ?? 1;

interface SttWorkerRequest {
  id: number;
  pcm?: Float32Array;
  preload?: boolean;
}

interface SttWorkerResponse {
  id: number;
  text?: string;
  error?: string;
}

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | undefined;

function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    // Cap ONNX Runtime's own thread pool: by default it can spin up one intra-op thread per CPU
    // core, which was starving the main thread (and its Discord interaction handling) of CPU
    // time even though inference itself runs on this separate worker thread.
    transcriberPromise = pipeline('automatic-speech-recognition', MODEL_NAME, {
      session_options: { intraOpNumThreads: INTRA_OP_NUM_THREADS, interOpNumThreads: 1, executionMode: 'sequential' },
    });
  }
  return transcriberPromise;
}

function post(message: SttWorkerResponse): void {
  parentPort?.postMessage(message);
}

parentPort?.on('message', (msg: SttWorkerRequest) => {
  void (async () => {
    try {
      const transcriber = await getTranscriber();
      if (msg.preload || !msg.pcm) {
        post({ id: msg.id, text: '' });
        return;
      }
      const result = await transcriber(msg.pcm, { language: 'japanese', task: 'transcribe' });
      const text = Array.isArray(result) ? result.map((r) => r.text).join('') : result.text;
      post({ id: msg.id, text: text.trim() });
    } catch (err) {
      post({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
});
