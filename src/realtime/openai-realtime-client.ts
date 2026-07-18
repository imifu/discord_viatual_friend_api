import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
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
// How long appendImage()/requestResponse() wait for a correlated `error` event (matched by
// event_id) before assuming the client event was accepted. The API returns errors for rejected
// client events promptly (validation/session-state failures), so this only needs to cover that
// round-trip, not a full response cycle - it does not wait for e.g. response.created.
const EVENT_CONFIRM_TIMEOUT_MS = 3000;
// Upper bound on how long requestResponse() treats the session as "a response is being
// requested" before giving up on ever seeing speakingChanged(true) confirm it started. Bounds the
// local response-in-flight guard below so a response.create that's accepted but never actually
// starts (rather than erroring) can't permanently block requestResponseWhenIdle() from ever
// sending again.
const RESPONSE_START_TIMEOUT_MS = 15_000;

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
  /** True from the moment requestResponse() sends response.create until we know (via
   *  speakingChanged(true), a correlated error, or RESPONSE_START_TIMEOUT_MS) whether it actually
   *  started - covers the brief gap right after sending where `speaking` doesn't reflect it yet,
   *  so two requestResponseWhenIdle() calls made back-to-back before the first gets confirmed
   *  can't both see "not busy" and both send response.create (the API only allows one active
   *  response at a time). */
  private responsePending = false;
  /** Callbacks awaiting a possible `error` event correlated (by event_id) to a client event we sent. */
  private readonly pendingEventErrors = new Map<string, (err: OpenAISessionError) => void>();
  /** At most one pending "call requestResponse() once the model stops speaking" listener - see requestResponseWhenIdle(). */
  private idleResponseListener?: (speaking: boolean) => void;
  /** Rejects the shared outcome promise for a pending deferred requestResponseWhenIdle() call, e.g. on close(). */
  private idleResponseCancel?: (err: OpenAISessionError) => void;
  /** The shared outcome promise every caller coalesced into the current pending deferred request receives. */
  private idleResponseOutcome?: Promise<void>;

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
      const sessionError = new OpenAISessionError(err.message, err);
      // err.event_id is the server-side error event's OWN id, not the id of the client event
      // that caused it - that correlating id is nested at err.error.event_id (OpenAIRealtimeError
      // wraps the raw RealtimeError from the API, which documents event_id as "the event_id of
      // the client event that caused the error"). Using err.event_id here would never match
      // anything we track, silently defeating appendImage()/requestResponse()'s rejection
      // detection (Codexレビューで発覚: 確認機構が常にtimeout経由でresolveしていた).
      const eventId = err.error?.event_id;
      if (eventId) {
        const pending = this.pendingEventErrors.get(eventId);
        if (pending) {
          this.pendingEventErrors.delete(eventId);
          pending(sessionError);
        }
      }
      this.emit('error', sessionError);
    });

    this.ws.socket.on('close', () => {
      logger.warn('Realtime APIとの接続が切断されました');
      // A remote/unexpected disconnect must clean up pending confirmations exactly like an
      // explicit close() does - otherwise appendImage()/requestResponse() callers waiting on
      // awaitAccepted() would just sit until their own timeout and resolve as if nothing had
      // gone wrong, even though the connection is gone (Codexレビューで発覚: 明示的close()以外の
      // 切断経路がpending Promiseを解決しないまま残っていた).
      this.rejectAllPending(new OpenAISessionError('Realtime APIとの接続が切断されたため確認できませんでした'));
      this.emit('close');
    });
  }

  /** Shared cleanup for both close() and an unexpected socket disconnect: rejects every pending
   *  appendImage()/requestResponse() confirmation and any pending deferred idle-response request. */
  private rejectAllPending(reason: OpenAISessionError): void {
    if (this.idleResponseListener) {
      this.off('speakingChanged', this.idleResponseListener);
      this.idleResponseListener = undefined;
    }
    if (this.idleResponseCancel) {
      this.idleResponseCancel(reason);
      this.idleResponseCancel = undefined;
      this.idleResponseOutcome = undefined;
    }
    for (const reject of this.pendingEventErrors.values()) {
      reject(reason);
    }
    this.pendingEventErrors.clear();
    this.responsePending = false;
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

  /** Tracks eventId, resolving once EVENT_CONFIRM_TIMEOUT_MS passes without a correlated error
   *  (see bindEvents()'s `error` handler) and rejecting immediately if one arrives. A resolve here
   *  is not positive proof of success, only the absence of a prompt rejection - the API does not
   *  otherwise ack client events we don't need a stronger guarantee than that for. */
  private awaitAccepted(eventId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEventErrors.delete(eventId);
        resolve();
      }, timeoutMs);
      this.pendingEventErrors.set(eventId, (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Adds a JPEG image as a user message item in the conversation. Does not by itself trigger a
   * response - pair with requestResponse()/requestResponseWhenIdle() if a reaction is wanted.
   * Returns a promise that rejects if the API reports the item was rejected (see awaitAccepted()).
   */
  appendImage(jpeg: Buffer, detail: RealtimeImageDetail): Promise<void> {
    const eventId = randomUUID();
    const confirmed = this.awaitAccepted(eventId, EVENT_CONFIRM_TIMEOUT_MS);
    this.ws.send({
      type: 'conversation.item.create',
      event_id: eventId,
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail }],
      },
    });
    return confirmed;
  }

  /**
   * Sends response.create now, independent of server-side VAD-triggered turns. `overrides` lets
   * callers replace this one response's instructions/max_output_tokens without touching the
   * session's persistent config (e.g. to keep an image reaction short). Returns a promise that
   * rejects if the API reports this specific request was rejected (see awaitAccepted()).
   */
  requestResponse(overrides?: { instructions?: string; maxOutputTokens?: number }): Promise<void> {
    const eventId = randomUUID();

    this.responsePending = true;
    let clearedBusy = false;
    const clearBusy = (): void => {
      if (clearedBusy) return;
      clearedBusy = true;
      clearTimeout(busyTimer);
      this.off('speakingChanged', onSpeakingStarted);
      this.responsePending = false;
    };
    const onSpeakingStarted = (speaking: boolean): void => {
      // Once actually speaking, `speaking` itself is the authority - the flag has done its job
      // of covering the gap between sending and this confirmation.
      if (speaking) clearBusy();
    };
    this.on('speakingChanged', onSpeakingStarted);
    // Bounds the gap for a response.create that's accepted (no error) but never actually starts -
    // without this, responsePending could get stuck true forever and block all future requests.
    const busyTimer = setTimeout(clearBusy, RESPONSE_START_TIMEOUT_MS);

    const confirmed = this.awaitAccepted(eventId, EVENT_CONFIRM_TIMEOUT_MS);
    void confirmed.catch(clearBusy); // definite rejection - no response is active because of this request

    this.ws.send({
      type: 'response.create',
      event_id: eventId,
      ...(overrides && {
        response: {
          ...(overrides.instructions !== undefined && { instructions: overrides.instructions }),
          ...(overrides.maxOutputTokens !== undefined && { max_output_tokens: overrides.maxOutputTokens }),
        },
      }),
    });
    return confirmed;
  }

  /** Whether a response.create is either confirmed active (speaking) or was just sent and hasn't
   *  been confirmed one way or the other yet (responsePending) - see requestResponse(). */
  private get responseBusy(): boolean {
    return this.speaking || this.responsePending;
  }

  /**
   * Like requestResponse(), but avoids the API rejecting the request because a response is
   * already in flight (the Realtime API only allows one active response per conversation at a
   * time): if the model is currently speaking, waits for the in-flight response to finish
   * (speakingChanged(false)) before sending response.create. `respondedImmediately` tells callers
   * whether the request was sent right away or deferred, for accurate user-facing feedback;
   * `outcome` resolves/rejects per requestResponse()'s contract once the (possibly deferred)
   * request is actually sent - callers that can't block on it (the deferred case usually can't,
   * since they've likely already replied to the user) should attach a rejection handler to correct
   * any earlier "it worked" message instead of awaiting it inline.
   */
  requestResponseWhenIdle(overrides?: {
    instructions?: string;
    maxOutputTokens?: number;
  }): { respondedImmediately: boolean; outcome: Promise<void> } {
    if (!this.responseBusy) {
      return { respondedImmediately: true, outcome: this.requestResponse(overrides) };
    }
    // Coalesce: if a deferred request is already pending (e.g. /cap was run more than once while
    // the model was mid-response), don't register a second listener. The Realtime API only
    // accepts one active response at a time, so firing requestResponse() once per call the moment
    // speakingChanged(false) arrives would send several response.create events back-to-back and
    // all but the first would be rejected - one eventual response covering every image added in
    // the meantime is both correct and cheaper. The overrides passed on this first (coalescing)
    // call win; later calls while still waiting just join the same pending request and share its
    // outcome promise.
    if (!this.idleResponseListener || !this.idleResponseOutcome) {
      this.idleResponseOutcome = new Promise<void>((resolve, reject) => {
        this.idleResponseCancel = reject;
        // Use on()+manual removal rather than once(): once() would consume itself on the first
        // speakingChanged event regardless of its value, so if that first event happened to fire
        // with `true` (not expected from setSpeaking()'s own transition-only guard today, but
        // this shouldn't depend on that), the deferred request would be silently dropped forever
        // instead of still waiting for the eventual `false`.
        this.idleResponseListener = (speaking: boolean): void => {
          if (speaking) return;
          this.off('speakingChanged', this.idleResponseListener!);
          this.idleResponseListener = undefined;
          this.idleResponseOutcome = undefined;
          this.idleResponseCancel = undefined;
          this.requestResponse(overrides).then(resolve, reject);
        };
        this.on('speakingChanged', this.idleResponseListener);
      });
    }
    return { respondedImmediately: false, outcome: this.idleResponseOutcome };
  }

  close(): void {
    this.rejectAllPending(new OpenAISessionError('セッションが切断されたため確認できませんでした'));
    this.ws.close();
  }
}
