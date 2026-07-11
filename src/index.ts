import { Events } from 'discord.js';
import { loadConfig } from './config/env.js';
import { createLogger, registerSecret, setLogLevel } from './utils/logger.js';
import { createDiscordClient } from './discord/client.js';
import { dispatchCommand } from './discord/commands.js';
import { leaveChannel } from './discord/voice-connection.js';
import { ConfigError } from './utils/errors.js';

const logger = createLogger('index');

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

  const shutdown = async (signal: string): Promise<void> => {
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
