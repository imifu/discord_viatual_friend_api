import { EventEmitter } from 'node:events';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import { createLogger } from '../utils/logger.js';
import { OpenAIConnectionError, OpenAISessionError } from '../utils/errors.js';

const logger = createLogger('openai-realtime');

/** OpenAI Realtime API currently only supports 24kHz mono PCM for both input and output audio. */
export const REALTIME_SAMPLE_RATE = 24000;
export const REALTIME_CHANNELS = 1;

/** Realtime API image input detail level - 'low' is a fixed low token cost regardless of resolution; 'high'/'auto' scale with resolution. */
export type RealtimeImageDetail = 'low' | 'high' | 'auto';

const CONNECT_TIMEOUT_MS = 10_000;

interface RealtimeSessionEvents {
  /** 24kHz mono s16le PCM chunk decoded from a response.output_audio.delta event. */
  audioDelta: [pcm: Buffer];
  /** Fires when the model starts/stops an audio response (derived from response.created/response.done). */
  speakingChanged: [speaking: boolean];
  /** Fires when the API's server-side VAD detects the user has started/stopped talking. */
  userSpeechStarted: [];
  userSpeechStopped: [];
  error: [Error];
  close: [];
}

export interface RealtimeSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  /** Post-processing playback speed multiplier applied by the API itself (0.25-1.5). */
  speed: number;
}

function waitForSocketOpen(ws: OpenAIRealtimeWS): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = ws.socket;
    if (socket.readyState === socket.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`接続が${CONNECT_TIMEOUT_MS}ms以内に確立しませんでした`));
    }, CONNECT_TIMEOUT_MS);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off('open', onOpen);
      socket.off('error', onError);
    };
    socket.on('open', onOpen);
    socket.on('error', onError);
  });
}

/**
 * Wraps a single OpenAI Realtime API WebSocket session: sends Discord's mixed/gated audio to
 * `input_audio_buffer.append` and re-emits the model's audio response as plain PCM chunks.
 * "Is the model speaking" and "did the user start/stop talking" are both derived directly from
 * the API's own turn-detection events rather than local RMS-based VAD.
 */
export class RealtimeSession extends EventEmitter<RealtimeSessionEvents> {
  private speaking = false;

  private constructor(private readonly ws: OpenAIRealtimeWS) {
    super();
  }

  static async connect(options: RealtimeSessionOptions): Promise<RealtimeSession> {
    const client = new OpenAI({ apiKey: options.apiKey });
    let ws: OpenAIRealtimeWS;
    try {
      // Disable permessage-deflate: this connection carries frequent audio-bearing messages,
      // and the synchronous zlib inflate/deflate work per message adds real main-thread load
      // for a stream that's already binary/base64 audio and gains little from compression.
      ws = await OpenAIRealtimeWS.create(client, { model: options.model, options: { perMessageDeflate: false } });
      await waitForSocketOpen(ws);
    } catch (err) {
      throw new OpenAIConnectionError(err);
    }

    const session = new RealtimeSession(ws);
    session.bindEvents();
    session.configureSession(options);
    logger.info(`Realtimeセッションに接続しました: model=${options.model} voice=${options.voice}`);
    return session;
  }

  private configureSession(options: RealtimeSessionOptions): void {
    this.ws.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: options.instructions,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
            turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
          },
          output: {
            format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
            voice: options.voice,
            speed: options.speed,
          },
        },
      },
    });
  }

  private bindEvents(): void {
    this.ws.on('session.created', () => logger.debug('session.created'));
    this.ws.on('session.updated', () => logger.debug('session.updated'));

    this.ws.on('response.output_audio.delta', (event) => {
      this.emit('audioDelta', Buffer.from(event.delta, 'base64'));
    });

    this.ws.on('response.created', () => this.setSpeaking(true));
    this.ws.on('response.done', () => this.setSpeaking(false));

    this.ws.on('input_audio_buffer.speech_started', () => this.emit('userSpeechStarted'));
    this.ws.on('input_audio_buffer.speech_stopped', () => this.emit('userSpeechStopped'));

    this.ws.on('error', (err) => {
      logger.error('Realtime APIでエラーが発生しました', err);
      this.emit('error', new OpenAISessionError(err.message, err));
    });

    this.ws.socket.on('close', () => {
      logger.warn('Realtime APIとの接続が切断されました');
      this.emit('close');
    });
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.emit('speakingChanged', speaking);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Sends a 24kHz mono s16le PCM chunk to the Realtime API's input audio buffer. */
  appendAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.ws.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  /** Adds a JPEG image as a user message item in the conversation. Does not by itself trigger a
   *  response - pair with requestResponse() if an immediate reaction is wanted. */
  appendImage(jpeg: Buffer, detail: RealtimeImageDetail): void {
    this.ws.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail }],
      },
    });
  }

  /** Asks the model to generate a response now, independent of server-side VAD-triggered turns. */
  requestResponse(): void {
    this.ws.send({ type: 'response.create' });
  }

  /**
   * Like requestResponse(), but avoids the API rejecting the request because a response is
   * already in flight (the Realtime API only allows one active response per conversation at a
   * time): if the model is currently speaking, waits for the in-flight response to finish
   * (speakingChanged(false)) before sending response.create. Returns whether the request was
   * sent immediately (true) or deferred (false), so callers can give the user accurate feedback.
   */
  requestResponseWhenIdle(): boolean {
    if (!this.speaking) {
      this.requestResponse();
      return true;
    }
    // Use on()+manual removal rather than once(): once() would consume itself on the first
    // speakingChanged event regardless of its value, so if that first event happened to fire
    // with `true` (not expected from setSpeaking()'s own transition-only guard today, but this
    // shouldn't depend on that), the deferred request would be silently dropped forever instead
    // of still waiting for the eventual `false`.
    const onSpeakingChanged = (speaking: boolean): void => {
      if (speaking) return;
      this.off('speakingChanged', onSpeakingChanged);
      this.requestResponse();
    };
    this.on('speakingChanged', onSpeakingChanged);
    return false;
  }

  close(): void {
    this.ws.close();
  }
}
