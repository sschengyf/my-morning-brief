import {
  type Channel,
  CHANNEL_LABELS,
  DiscordChannel,
  type MessageHandler,
  TelegramChannel,
} from '../chat/index.js';
import {
  cleanupTempFiles,
  type Config,
  ensureDataDir,
  logger,
  registerSecrets,
  secretsOf,
} from '../infra/index.js';
import { LlmService, OllamaClient } from '../llm/index.js';

export async function prepare(config: Config): Promise<void> {
  registerSecrets(secretsOf(config));
  await ensureDataDir(config.paths.data_dir);
  const removed = await cleanupTempFiles(config.paths.data_dir);
  if (removed.length > 0) logger.info(`清理了 ${removed.length} 个上次中断写入留下的临时文件`);
}

export async function createLlm(config: Config): Promise<LlmService> {
  const client = new OllamaClient(config.ollama);
  await client.check();
  return new LlmService(client, config.ollama.num_ctx);
}

export function createChannels(config: Config): Channel[] {
  const channels: Channel[] = [];
  if (config.telegram.enabled) channels.push(new TelegramChannel(config.telegram));
  if (config.discord.enabled) channels.push(new DiscordChannel(config.discord));
  return channels;
}

export const NO_OWNER_HINT =
  '还没有配置主人 id：先运行 pnpm start，给机器人发一条私信，按回复把 id 填进 config.toml';

/** Starts each channel on its own; one that fails is stopped, logged and left out. */
export async function startChannels(
  channels: Channel[],
  handler?: MessageHandler,
): Promise<Channel[]> {
  const started: Channel[] = [];
  for (const channel of channels) {
    try {
      await channel.start(handler);
      started.push(channel);
    } catch (error) {
      logger.error(`${CHANNEL_LABELS[channel.name]} 启动失败，请检查 token 和网络`, error);
      await channel.stop().catch(() => undefined);
    }
  }
  return started;
}

export async function stopChannels(channels: Channel[]): Promise<void> {
  await Promise.allSettled(channels.map((channel) => channel.stop()));
}
