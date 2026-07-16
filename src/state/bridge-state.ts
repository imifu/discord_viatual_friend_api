import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Client } from 'discord.js';
import type { PassThrough } from 'node:stream';
import type { PcmMixer } from '../audio/pcm-mixer.js';
import type { PcmRingBuffer } from '../audio/pcm-ring-buffer.js';
import type { VirtualOutputHandle } from '../audio/virtual-output.js';
import type { VirtualInputHandle } from '../audio/virtual-input.js';
import type { VoiceActivityGate } from '../audio/voice-activity.js';
import type { ReceiverHandle } from '../discord/receiver.js';
import type { MessagePostingHandle } from '../services/message-posting-service.js';
import type { UtteranceRecorderHandle } from '../services/utterance-recorder.js';

/** Live, non-serializable handles for a guild's bridge session. */
export interface GuildRuntime {
  voiceConnection?: VoiceConnection;
  voiceChannelId?: string;
  /** RtAudio(WASAPI) stream writing Discord audio out to virtual device A. */
  outboundAudio?: VirtualOutputHandle;
  /** Delayed retry that reopens outboundAudio after a write/device failure. */
  outboundRestartTimer?: NodeJS.Timeout;
  /** Prevents a delayed retry from reopening outboundAudio after relay shutdown. */
  outboundRecoveryActive?: boolean;
  /** Mixes multiple Discord speakers' PCM into one stream fed to outboundAudio. */
  mixer?: PcmMixer;
  /** Subscribes to Discord speakers and feeds decoded PCM into the mixer. */
  receiverHandle?: ReceiverHandle;
  /** RtAudio(WASAPI) stream reading ChatGPT Live audio in from virtual device B. */
  inboundAudio?: VirtualInputHandle;
  /** Jitter-buffers inboundAudio's PCM on a fixed tick before it reaches Discord. */
  inboundMixer?: PcmMixer;
  /** Output of inboundMixer; the actual source handed to Discord's AudioResource. */
  inboundPlaybackStream?: PassThrough;
  /** Plays inboundPlaybackStream into the Discord voice connection. */
  audioPlayer?: AudioPlayer;
  /** Tracks ChatGPT Live speaking state (from inboundAudio) to gate outbound Discord audio. */
  vadGate?: VoiceActivityGate;
  /** Watches for a spoken trigger phrase and posts ChatGPT Live's next reply to a text channel. */
  messagePostingHandle?: MessagePostingHandle;
  /** Longer-hold speaking gate used only by messagePostingHandle, separate from vadGate. */
  postingSpeakingGate?: VoiceActivityGate;
  /** Persists and publishes durable utterance events for post-session transcripts. */
  utteranceRecorder?: UtteranceRecorderHandle;
  /** Longer-hold speaking gate used for GPT utterance boundaries, separate from vadGate. */
  utteranceSpeakingGate?: VoiceActivityGate;
  /** Discord client, stashed so stopRelay can post the finished transcript without needing a param. */
  client?: Client;
  /** Periodic check that restarts inboundAudio if ChatGPT Live's capture stream silently stalls. */
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
  inputDeviceName?: string;
  outputDeviceName?: string;
  outboundAudioRunning: boolean;
  inboundAudioRunning: boolean;
  gptSpeaking: boolean;
  discordInputGateOpen: boolean;
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
    outboundAudioRunning: false,
    inboundAudioRunning: false,
    gptSpeaking: false,
    discordInputGateOpen: true,
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
