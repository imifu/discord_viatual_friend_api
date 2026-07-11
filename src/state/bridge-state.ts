import type { VoiceConnection } from '@discordjs/voice';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PcmMixer } from '../audio/pcm-mixer.js';
import type { VirtualOutputHandle } from '../audio/virtual-output.js';
import type { ReceiverHandle } from '../discord/receiver.js';

/** Live, non-serializable handles for a guild's bridge session. */
export interface GuildRuntime {
  voiceConnection?: VoiceConnection;
  voiceChannelId?: string;
  /** RtAudio(WASAPI) stream writing Discord audio out to virtual device A. */
  outboundAudio?: VirtualOutputHandle;
  /** FFmpeg process reading ChatGPT Live audio in from virtual device B (dshow). */
  inboundFfmpeg?: ChildProcessWithoutNullStreams;
  /** Mixes multiple Discord speakers' PCM into one stream fed to outboundAudio. */
  mixer?: PcmMixer;
  /** Subscribes to Discord speakers and feeds decoded PCM into the mixer. */
  receiverHandle?: ReceiverHandle;
}

/** Displayable status for a guild's bridge session (used by /status). */
export interface GuildStatus {
  connected: boolean;
  voiceChannelId?: string;
  relayRunning: boolean;
  inputDeviceName?: string;
  outputDeviceName?: string;
  outboundAudioRunning: boolean;
  inboundFfmpegRunning: boolean;
  gptSpeaking: boolean;
  discordInputGateOpen: boolean;
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
    outboundAudioRunning: false,
    inboundFfmpegRunning: false,
    gptSpeaking: false,
    discordInputGateOpen: true,
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
