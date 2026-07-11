import { REST, Routes } from 'discord.js';
import { loadConfig } from '../config/env.js';
import { createLogger, registerSecret } from '../utils/logger.js';
import { commandDefinitions } from './commands.js';

const logger = createLogger('command-register');

async function main(): Promise<void> {
  const config = loadConfig();
  registerSecret(config.discord.token);

  const rest = new REST().setToken(config.discord.token);

  logger.info(`スラッシュコマンド登録開始: guild=${config.discord.guildId} count=${commandDefinitions.length}`);
  await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
    body: commandDefinitions,
  });
  logger.info('スラッシュコマンド登録完了');
}

main().catch((err) => {
  logger.error('スラッシュコマンド登録に失敗しました', err);
  process.exitCode = 1;
});
