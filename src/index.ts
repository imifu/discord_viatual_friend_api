import { Events } from 'discord.js';
import { loadConfig } from './config/env.js';
import { createLogger, registerSecret, setLogLevel } from './utils/logger.js';
import { createDiscordClient } from './discord/client.js';
import { dispatchCommand } from './discord/commands.js';
import { leaveChannel } from './discord/voice-connection.js';
import { ConfigError } from './utils/errors.js';
import { preloadSttModel, type WorkerPurpose } from './audio/stt.js';

const logger = createLogger('index');

process.on('unhandledRejection', (reason) => {
  logger.error('未処理のPromise rejectionが発生しました', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('未処理の例外が発生しました', err);
});

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.userMessage);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  setLogLevel(config.logLevel);
  registerSecret(config.discord.token);

  logger.info('Bot起動処理を開始します');

  const preloadPurposes: WorkerPurpose[] = [];
  if (config.messagePosting.enabled) preloadPurposes.push('scan', 'capture');
  if (preloadPurposes.length > 0) preloadSttModel(preloadPurposes);

  const client = createDiscordClient();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Discordログイン成功: ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void dispatchCommand(interaction);
  });

  client.on(Events.Error, (err) => {
    logger.error('Discordクライアントエラー', err);
  });

  client.on(Events.ShardReconnecting, () => {
    logger.warn('Discord Gatewayに再接続中です');
  });

  client.on(Events.ShardResume, () => {
    logger.info('Discord Gatewayへの再接続が完了しました');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} を受信、終了処理を開始します`);
    const guildIds = [...client.guilds.cache.keys()];
    await Promise.all(guildIds.map((guildId) => leaveChannel(guildId).catch(() => undefined)));
    client.destroy();
    logger.info('終了処理が完了しました');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await client.login(config.discord.token);
  } catch (err) {
    logger.error('Discordログインに失敗しました。DISCORD_TOKENを確認してください。', err);
    process.exitCode = 1;
  }
}

void main();
