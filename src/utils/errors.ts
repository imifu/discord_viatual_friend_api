/**
 * Base class for all expected application errors.
 * `userMessage` is safe to show in a Discord reply; `logMessage` (or the message
 * itself) is for developer-facing logs and may contain more detail.
 */
export class AppError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string, logMessage?: string, options?: ErrorOptions) {
    super(logMessage ?? userMessage, options);
    this.name = new.target.name;
    this.userMessage = userMessage;
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(`設定エラー: ${message}`, `ConfigError: ${message}`);
  }
}

export class OpenAIConnectionError extends AppError {
  constructor(cause?: unknown) {
    super(
      'OpenAI Realtime APIへの接続に失敗しました。OPENAI_API_KEYが正しいか、ネットワーク状態を確認してください。',
      'OpenAIConnectionError',
      { cause },
    );
  }
}

export class OpenAISessionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(
      `OpenAI Realtime APIとのセッションでエラーが発生しました: ${message}`,
      `OpenAISessionError: ${message}`,
      { cause },
    );
  }
}

export class NotInVoiceChannelError extends AppError {
  constructor() {
    super('先にボイスチャンネルへ参加してからコマンドを実行してください。');
  }
}

export class VoiceChannelJoinError extends AppError {
  constructor(cause?: unknown) {
    super('ボイスチャンネルへの参加に失敗しました。', 'VoiceChannelJoinError', { cause });
  }
}

export class NotConnectedError extends AppError {
  constructor() {
    super('BotはVCに参加していません。先に /join を実行してください。');
  }
}

export class RelayAlreadyRunningError extends AppError {
  constructor() {
    super('中継は既に開始されています。');
  }
}

export class ClipUnavailableError extends AppError {
  constructor(reason: string) {
    super(`クリップを保存できません: ${reason}`);
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;
  return '予期しないエラーが発生しました。詳細はログを確認してください。';
}
