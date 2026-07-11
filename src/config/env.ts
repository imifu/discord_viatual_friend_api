import 'dotenv/config';
import { ConfigError } from '../utils/errors.js';

function requireString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(`環境変数 ${name} が設定されていません。.env を確認してください。`);
  }
  return value;
}

function optionalString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`環境変数 ${name} は数値である必要があります (現在値: "${raw}")。`);
  }
  return parsed;
}

function optionalFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`環境変数 ${name} は数値である必要があります (現在値: "${raw}")。`);
  }
  return parsed;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export interface AppConfig {
  discord: {
    token: string;
    clientId: string;
    guildId: string;
  };
  devices: {
    discordToGpt?: string;
    gptToDiscord?: string;
  };
  input: {
    sampleRate: number;
    channels: number;
  };
  output: {
    sampleRate: number;
    channels: number;
  };
  logLevel: string;
  vad: {
    threshold: number;
    gptSpeakingHoldMs: number;
    ducking: boolean;
    duckingLevel: number;
  };
}

let cached: AppConfig | undefined;

/** Loads and validates configuration from process.env. Throws ConfigError on invalid required values. */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const config: AppConfig = {
    discord: {
      token: requireString('DISCORD_TOKEN'),
      clientId: requireString('DISCORD_CLIENT_ID'),
      guildId: requireString('DISCORD_GUILD_ID'),
    },
    devices: {
      discordToGpt: optionalString('DISCORD_TO_GPT_DEVICE'),
      gptToDiscord: optionalString('GPT_TO_DISCORD_DEVICE'),
    },
    input: {
      sampleRate: optionalInt('INPUT_SAMPLE_RATE', 48000),
      channels: optionalInt('INPUT_CHANNELS', 2),
    },
    output: {
      sampleRate: optionalInt('OUTPUT_SAMPLE_RATE', 48000),
      channels: optionalInt('OUTPUT_CHANNELS', 2),
    },
    logLevel: optionalString('LOG_LEVEL') ?? 'info',
    vad: {
      threshold: optionalFloat('VOICE_ACTIVITY_THRESHOLD', 0.02),
      gptSpeakingHoldMs: optionalInt('GPT_SPEAKING_HOLD_MS', 500),
      ducking: optionalBool('DISCORD_INPUT_DUCKING', true),
      duckingLevel: optionalFloat('DISCORD_INPUT_DUCKING_LEVEL', 0.1),
    },
  };

  cached = config;
  return config;
}

/** Ensures both virtual device names are configured; throws ConfigError otherwise. Call before starting the relay. */
export function requireDeviceConfig(config: AppConfig): { discordToGpt: string; gptToDiscord: string } {
  const { discordToGpt, gptToDiscord } = config.devices;
  if (!discordToGpt || !gptToDiscord) {
    throw new ConfigError(
      'DISCORD_TO_GPT_DEVICE と GPT_TO_DISCORD_DEVICE を .env に設定してください。/devices で利用可能なデバイス名を確認できます。',
    );
  }
  return { discordToGpt, gptToDiscord };
}
