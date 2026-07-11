type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = 'info';
const secrets: string[] = [];

export function setLogLevel(level: string): void {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    currentLevel = level;
  }
}

/** Registers a secret value (e.g. the bot token) so it is never printed verbatim. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.push(value);
}

function redact(message: string): string {
  let out = message;
  for (const secret of secrets) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

function format(level: LogLevel, scope: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${scope}] ${redact(message)}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, meta?: unknown) => {
    if (!shouldLog(level)) return;
    const line = format(level, scope, message);
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (meta !== undefined) {
      consoleFn(line, meta);
    } else {
      consoleFn(line);
    }
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}
