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

export class DeviceNotFoundError extends AppError {
  constructor(deviceName: string, direction: 'input' | 'output') {
    super(
      `音声デバイスが見つかりません(${direction === 'input' ? '入力' : '出力'}): "${deviceName}"。/devices で一覧を確認してください。`,
      `DeviceNotFoundError: direction=${direction} name="${deviceName}"`,
    );
  }
}

export class FfmpegNotFoundError extends AppError {
  constructor(cause?: unknown) {
    super(
      'FFmpegが見つかりません。インストールされてPATHが通っているか確認してください。',
      'FfmpegNotFoundError',
      { cause },
    );
  }
}

export class FfmpegProcessError extends AppError {
  constructor(context: string, exitCode: number | null, stderrTail?: string) {
    super(
      `音声処理(FFmpeg)でエラーが発生しました(${context})。`,
      `FfmpegProcessError: context=${context} exitCode=${exitCode} stderrTail=${stderrTail ?? ''}`,
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

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;
  return '予期しないエラーが発生しました。詳細はログを確認してください。';
}
