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
// How long appendImage()/requestResponse() wait for a positive confirmation (conversation.item.
// created / response.created, matched by an id we generate and attach ourselves) before treating
// the request as failed. A rejection here can mean either a confirmed API error or simply no
// confirmation within this window - both are treated as "don't tell the user it worked" (Codex
// レビューで指摘: 消極的なタイムアウト成功扱いはユーザーの明示的な受容が必要な既知の制約だったが、
// ユーザーの判断により肯定確認を待つ方式へ変更した).
const POSITIVE_CONFIRM_TIMEOUT_MS = 5000;

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

interface Settlers {
  resolve: () => void;
  reject: (err: OpenAISessionError) => void;
}

interface PendingIdleResponse {
  overrides?: { instructions?: string; maxOutputTokens?: number };
  listener: (speaking: boolean) => void;
  accepted: Settlers & { promise: Promise<void> };
  completed: Settlers & { promise: Promise<void> };
}

function deferred(): Settlers & { promise: Promise<void> } {
  let resolve!: () => void;
  let reject!: (err: OpenAISessionError) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  /** True from the moment requestResponse() sends response.create until its accepted-confirmation
   *  settles - covers the brief gap right after sending where `speaking` doesn't reflect it yet,
   *  so two requestResponseWhenIdle() calls made back-to-back before the first is confirmed can't
   *  both see "not busy" and both send response.create (the API only allows one active response
   *  at a time). */
  private responsePending = false;
  /** Resolve/reject pairs awaiting a positive "accepted" confirmation (conversation.item.created /
   *  response.created) or a correlated `error`, keyed by an id we generate ourselves and attach as
   *  both the client event's event_id (for error correlation) and either the item's id or the
   *  response's metadata.requestId (for positive confirmation - see appendImage()/requestResponse()). */
  private readonly pendingConfirmations = new Map<string, Settlers>();
  /** Resolve/reject pairs awaiting a response's *final* outcome (response.done's status), keyed by
   *  the same request id used for the "accepted" confirmation above - see requestResponse(). */
  private readonly pendingCompletions = new Map<string, Settlers>();
  /** At most one pending "call requestResponse() once no response is busy" request - see requestResponseWhenIdle()/tryDispatchIdleResponse(). */
  private idlePending?: PendingIdleResponse;

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

    this.ws.on('conversation.item.created', (event) => {
      // Positive confirmation for appendImage(): resolves the pending confirmation whose id we
      // set as this item's own id when we sent conversation.item.create.
      this.resolvePendingConfirmation(event.item.id);
    });

    this.ws.on('response.created', (event) => {
      this.setSpeaking(true);
      // Positive confirmation for requestResponse(): resolves the "accepted" confirmation whose
      // id we attached as response.metadata.requestId when we sent response.create. Responses
      // auto-created by server-side VAD (not through requestResponse()) won't carry this
      // metadata, so this is a no-op for those.
      this.resolvePendingConfirmation(event.response.metadata?.requestId);
    });

    this.ws.on('response.done', (event) => {
      this.setSpeaking(false);
      const requestId = event.response.metadata?.requestId;
      if (!requestId) return;
      const pending = this.pendingCompletions.get(requestId);
      if (!pending) return;
      this.pendingCompletions.delete(requestId);
      // `completed`/`incomplete` (e.g. hit our own max_output_tokens cap)/`cancelled` (e.g. the
      // user's own barge-in interrupted it) all mean *some* real spoken output was very likely
      // already produced - only `failed` represents a genuine silent failure worth telling the
      // user about (Codexレビューで指摘: response.createdの受理確認だけでは、その後failed/
      // incompleteになった場合を見落としていた).
      if (event.response.status === 'failed') {
        const detail = event.response.status_details?.error;
        pending.reject(new OpenAISessionError(detail ? `応答が失敗しました: ${JSON.stringify(detail)}` : '応答が失敗しました'));
      } else {
        pending.resolve();
      }
    });

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
      this.rejectPendingConfirmation(eventId, sessionError);
      this.rejectPendingCompletion(eventId, sessionError);
      this.emit('error', sessionError);
    });

    this.ws.socket.on('close', () => {
      logger.warn('Realtime APIとの接続が切断されました');
      // A remote/unexpected disconnect must clean up pending confirmations exactly like an
      // explicit close() does - otherwise appendImage()/requestResponse() callers waiting on a
      // confirmation would just sit until their own timeout, even though the connection is gone
      // (Codexレビューで発覚: 明示的close()以外の切断経路がpending Promiseを解決しないまま残っていた).
      this.rejectAllPending(new OpenAISessionError('Realtime APIとの接続が切断されたため確認できませんでした'));
      this.emit('close');
    });
  }

  private resolvePendingConfirmation(id: string | undefined | null): void {
    if (!id) return;
    const pending = this.pendingConfirmations.get(id);
    if (!pending) return;
    this.pendingConfirmations.delete(id);
    pending.resolve();
  }

  private rejectPendingConfirmation(id: string | undefined | null, err: OpenAISessionError): void {
    if (!id) return;
    const pending = this.pendingConfirmations.get(id);
    if (!pending) return;
    this.pendingConfirmations.delete(id);
    pending.reject(err);
  }

  private rejectPendingCompletion(id: string | undefined | null, err: OpenAISessionError): void {
    if (!id) return;
    const pending = this.pendingCompletions.get(id);
    if (!pending) return;
    this.pendingCompletions.delete(id);
    pending.reject(err);
  }

  /**
   * If a deferred requestResponseWhenIdle() call is waiting and no response is currently busy,
   * dispatch it now. Called from two places: a normal speakingChanged(false) (the response that
   * was blocking us finished normally), and requestResponse()'s own "accepted" confirmation
   * settling (the response that was blocking us instead failed or timed out before ever starting -
   * in that case speakingChanged(false) will never fire for it, so without this second call site a
   * waiting caller's outcome would never settle - Codexレビューで発覚).
   */
  private tryDispatchIdleResponse(): void {
    if (!this.idlePending || this.responseBusy) return;
    const pending = this.idlePending;
    this.off('speakingChanged', pending.listener);
    this.idlePending = undefined;
    const { accepted, completed } = this.requestResponse(pending.overrides);
    accepted.then(pending.accepted.resolve, pending.accepted.reject);
    completed.then(pending.completed.resolve, pending.completed.reject);
  }

  /** Shared cleanup for both close() and an unexpected socket disconnect: rejects every pending
   *  appendImage()/requestResponse() confirmation and any pending deferred idle-response request. */
  private rejectAllPending(reason: OpenAISessionError): void {
    if (this.idlePending) {
      const pending = this.idlePending;
      this.off('speakingChanged', pending.listener);
      this.idlePending = undefined;
      pending.accepted.reject(reason);
      pending.completed.reject(reason);
    }
    for (const pending of this.pendingConfirmations.values()) {
      pending.reject(reason);
    }
    this.pendingConfirmations.clear();
    for (const pending of this.pendingCompletions.values()) {
      pending.reject(reason);
    }
    this.pendingCompletions.clear();
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

  /** Generates an id for correlating our own client events with the API's confirmation events.
   *  Deliberately shorter than a raw UUID (36 chars): the Realtime API rejects `item.id` values
   *  over 32 characters (confirmed on real traffic - a raw randomUUID() broke every /cap while
   *  connected). Stripping the hyphens from a UUID gives exactly 32 hex characters. */
  private generateId(): string {
    return randomUUID().replace(/-/g, '');
  }

  /** Tracks id, resolving on a positive confirmation (conversation.item.created / response.created
   *  matched to this id) or a correlated error, and rejecting on timeout - not hearing back within
   *  the window is treated as failure, not success (see POSITIVE_CONFIRM_TIMEOUT_MS). */
  private awaitConfirmed(id: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingConfirmations.delete(id);
        reject(new OpenAISessionError(`${timeoutMs}ms以内に受理確認が得られませんでした`));
      }, timeoutMs);
      this.pendingConfirmations.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /**
   * Adds a JPEG image as a user message item in the conversation. Does not by itself trigger a
   * response - pair with requestResponse()/requestResponseWhenIdle() if a reaction is wanted.
   * Returns a promise that resolves once the API confirms the item was created
   * (conversation.item.created) and rejects on a correlated error or on timeout (see
   * awaitConfirmed()).
   */
  appendImage(jpeg: Buffer, detail: RealtimeImageDetail): Promise<void> {
    const itemId = this.generateId();
    const confirmed = this.awaitConfirmed(itemId, POSITIVE_CONFIRM_TIMEOUT_MS);
    this.ws.send({
      type: 'conversation.item.create',
      event_id: itemId,
      item: {
        id: itemId,
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
   * session's persistent config (e.g. to keep an image reaction short).
   *
   * Returns two promises tracking two different milestones:
   * - `accepted` resolves once the API confirms the response actually started (response.created)
   *   and rejects on a correlated error or on timeout (see awaitConfirmed()).
   * - `completed` resolves once that response finishes with a real (if possibly truncated or
   *   interrupted) result - `completed`/`incomplete`/`cancelled` - and rejects only on a genuine
   *   `failed` status or if `accepted` itself never resolved. This is the signal to use for
   *   "did the user actually get a reaction", since `accepted` alone only proves the response
   *   object was created, not that it produced anything (Codexレビューで指摘).
   */
  requestResponse(overrides?: { instructions?: string; maxOutputTokens?: number }): { accepted: Promise<void>; completed: Promise<void> } {
    const requestId = this.generateId();
    this.responsePending = true;

    const accepted = this.awaitConfirmed(requestId, POSITIVE_CONFIRM_TIMEOUT_MS);
    // .finally() returns a *new* promise that also rejects if `accepted` does - without the
    // trailing .catch(() => {}), that derived promise would be an unhandled rejection whenever a
    // response request fails, independent of whatever the caller does with `accepted` itself (a
    // real bug caught while testing this method: it crashed the process under Node's default
    // unhandled-rejection handling).
    void accepted
      .finally(() => {
        this.responsePending = false;
        // Whether this settled by success (now speaking, so responseBusy stays true via
        // `speaking` and this is a no-op) or by failure (never started, so we may now genuinely
        // be idle), give any deferred waiter a chance to proceed instead of only relying on
        // speakingChanged.
        this.tryDispatchIdleResponse();
      })
      .catch(() => {});

    const completedSettlers = deferred();
    accepted.then(
      () => this.pendingCompletions.set(requestId, completedSettlers),
      (err: OpenAISessionError) => completedSettlers.reject(err),
    );

    this.ws.send({
      type: 'response.create',
      event_id: requestId,
      response: {
        metadata: { requestId },
        ...(overrides?.instructions !== undefined && { instructions: overrides.instructions }),
        ...(overrides?.maxOutputTokens !== undefined && { max_output_tokens: overrides.maxOutputTokens }),
      },
    });
    return { accepted, completed: completedSettlers.promise };
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
   * whether the request was sent right away or deferred, for accurate user-facing feedback.
   * `accepted`/`completed` behave as documented on requestResponse(), once the (possibly
   * deferred) request is actually sent - callers that can't block on them (the deferred case
   * usually can't, since they've likely already replied to the user) should attach rejection
   * handlers to correct any earlier "it worked" message instead of awaiting them inline.
   */
  requestResponseWhenIdle(overrides?: {
    instructions?: string;
    maxOutputTokens?: number;
  }): { respondedImmediately: boolean; accepted: Promise<void>; completed: Promise<void> } {
    if (!this.responseBusy) {
      const { accepted, completed } = this.requestResponse(overrides);
      return { respondedImmediately: true, accepted, completed };
    }
    // Coalesce: if a deferred request is already pending (e.g. /cap was run more than once while
    // the model was mid-response), don't register a second listener. The Realtime API only
    // accepts one active response at a time, so firing requestResponse() once per call the moment
    // speakingChanged(false) arrives would send several response.create events back-to-back and
    // all but the first would be rejected - one eventual response covering every image added in
    // the meantime is both correct and cheaper. The overrides passed on this first (coalescing)
    // call win; later calls while still waiting just join the same pending request and share its
    // accepted/completed promises. Note: this only coalesces requests that arrive before this
    // deferred one is dispatched - once dispatched, a later /cap starts a new coalescing window
    // and gets its own separate response, since an already-started response can't retroactively
    // include a new image (see README "画面キャプチャ" for the user-facing explanation).
    if (!this.idlePending) {
      const accepted = deferred();
      const completed = deferred();
      const listener = (speaking: boolean): void => {
        if (speaking) return;
        this.tryDispatchIdleResponse();
      };
      // Use on()+manual removal rather than once(): once() would consume itself on the first
      // speakingChanged event regardless of its value, so if that first event happened to fire
      // with `true` (not expected from setSpeaking()'s own transition-only guard today, but this
      // shouldn't depend on that), the deferred request would be silently dropped forever instead
      // of still waiting for the eventual `false`. tryDispatchIdleResponse() is also called from
      // requestResponse()'s own "accepted" confirmation-settling path (see there) - not just this
      // listener - to cover the case where the response we're waiting behind fails/times out
      // before ever actually starting to speak, since speakingChanged(false) would never fire
      // for that.
      this.on('speakingChanged', listener);
      this.idlePending = { overrides, listener, accepted, completed };
    }
    return { respondedImmediately: false, accepted: this.idlePending.accepted.promise, completed: this.idlePending.completed.promise };
  }

  close(): void {
    this.rejectAllPending(new OpenAISessionError('セッションが切断されたため確認できませんでした'));
    this.ws.close();
  }
}
