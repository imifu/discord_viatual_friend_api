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

export class AudioStreamOpenError extends AppError {
  constructor(deviceName: string, direction: 'input' | 'output', cause?: unknown) {
    super(
      `音声デバイスを開始できませんでした(${direction === 'input' ? '入力' : '出力'}): "${deviceName}"。` +
        '他のアプリで使用中でないか、デバイス名が正しいか確認してください。',
      `AudioStreamOpenError: direction=${direction} name="${deviceName}"`,
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
