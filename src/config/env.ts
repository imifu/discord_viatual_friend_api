import 'dotenv/config';
import { ConfigError } from '../utils/errors.js';
import { DEFAULT_AIR_READING_PROMPT } from './air-reading.js';

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

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function optionalUnitFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    throw new ConfigError(`環境変数 ${name} は数値である必要があります (現在値: "${raw}")。`);
  }
  if (parsed < 0 || parsed > 1) {
    throw new ConfigError(`環境変数 ${name} は0以上1以下である必要があります (現在値: "${parsed}")。`);
  }
  return parsed;
}

export interface AppConfig {
  discord: {
    token: string;
    clientId: string;
    guildId: string;
  };
  openai: {
    apiKey: string;
    model: string;
    voice: string;
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
    ducking: boolean;
    duckingLevel: number;
  };
  bargeIn: {
    enabled: boolean;
    gptPlaybackLevel: number;
  };
  airReading: {
    enabled: boolean;
    prompt: string;
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
    openai: {
      apiKey: requireString('OPENAI_API_KEY'),
      model: optionalString('OPENAI_REALTIME_MODEL') ?? 'gpt-realtime-2.1',
      voice: optionalString('OPENAI_VOICE') ?? 'marin',
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
      ducking: optionalBool('DISCORD_INPUT_DUCKING', true),
      duckingLevel: optionalUnitFloat('DISCORD_INPUT_DUCKING_LEVEL', 0.1),
    },
    bargeIn: {
      enabled: optionalBool('BARGE_IN_ENABLED', true),
      gptPlaybackLevel: optionalUnitFloat('BARGE_IN_GPT_PLAYBACK_LEVEL', 0.2),
    },
    airReading: {
      enabled: optionalBool('AIR_READING_ENABLED', true),
      prompt: (optionalString('AIR_READING_PROMPT') ?? DEFAULT_AIR_READING_PROMPT).replace(/\\n/g, '\n'),
    },
  };

  cached = config;
  return config;
}
