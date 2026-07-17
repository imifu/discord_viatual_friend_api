import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { PassThrough } from 'node:stream';
import type { PcmMixer } from '../audio/pcm-mixer.js';
import type { PcmRingBuffer } from '../audio/pcm-ring-buffer.js';
import type { RealtimeSession } from '../realtime/openai-realtime-client.js';
import type { ReceiverHandle } from '../discord/receiver.js';

/** Live, non-serializable handles for a guild's bridge session. */
export interface GuildRuntime {
  voiceConnection?: VoiceConnection;
  voiceChannelId?: string;
  /** Mixes multiple Discord speakers' PCM into one stream fed to the Realtime session. */
  mixer?: PcmMixer;
  /** Subscribes to Discord speakers and feeds decoded PCM into the mixer. */
  receiverHandle?: ReceiverHandle;
  /** WebSocket session to the OpenAI Realtime API; carries audio both directions. */
  realtimeSession?: RealtimeSession;
  /** Delayed retry that reconnects realtimeSession after a disconnect/error. */
  realtimeRestartTimer?: NodeJS.Timeout;
  /** Prevents a delayed retry from reconnecting realtimeSession after relay shutdown. */
  realtimeRecoveryActive?: boolean;
  /** Jitter-buffers the Realtime session's audio on a fixed tick before it reaches Discord. */
  inboundMixer?: PcmMixer;
  /** Output of inboundMixer; the actual source handed to Discord's AudioResource. */
  inboundPlaybackStream?: PassThrough;
  /** Plays inboundPlaybackStream into the Discord voice connection. */
  audioPlayer?: AudioPlayer;
  /** Periodic check that restarts Discord-side playback if the AudioPlayer stalls. */
  inboundWatchdog?: NodeJS.Timeout;
  /** Mixes raw Discord and GPT audio for the rolling clip buffer. */
  clipMixer?: PcmMixer;
  /** Feeds the raw Discord mix into clipMixer. */
  clipDiscordStream?: PassThrough;
  /** Keeps only the most recent 60 seconds of mixed PCM. */
  clipRingBuffer?: PcmRingBuffer;
}

/** Displayable status for a guild's bridge session (used by /status). */
export interface GuildStatus {
  connected: boolean;
  voiceChannelId?: string;
  relayRunning: boolean;
  realtimeConnected: boolean;
  gptSpeaking: boolean;
  bargeInActive: boolean;
  clipBufferRunning: boolean;
  lastError?: string;
  lastErrorAt?: Date;
}

interface GuildState {
  runtime: GuildRuntime;
  status: GuildStatus;
}

const guildStates = new Map<string, GuildState>();

function defaultStatus(): GuildStatus {
  return {
    connected: false,
    relayRunning: false,
    realtimeConnected: false,
    gptSpeaking: false,
    bargeInActive: false,
    clipBufferRunning: false,
  };
}

function ensure(guildId: string): GuildState {
  let state = guildStates.get(guildId);
  if (!state) {
    state = { runtime: {}, status: defaultStatus() };
    guildStates.set(guildId, state);
  }
  return state;
}

export function getRuntime(guildId: string): GuildRuntime {
  return ensure(guildId).runtime;
}

export function getStatus(guildId: string): GuildStatus {
  return ensure(guildId).status;
}

export function updateStatus(guildId: string, patch: Partial<GuildStatus>): GuildStatus {
  const state = ensure(guildId);
  Object.assign(state.status, patch);
  return state.status;
}

export function setLastError(guildId: string, message: string): void {
  updateStatus(guildId, { lastError: message, lastErrorAt: new Date() });
}

export function clearLastError(guildId: string): void {
  updateStatus(guildId, { lastError: undefined, lastErrorAt: undefined });
}

export function resetGuildState(guildId: string): void {
  guildStates.set(guildId, { runtime: {}, status: defaultStatus() });
}
