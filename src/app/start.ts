import { Archive } from '../archive/index.js';
import { type Channel, ChatCore } from '../chat/index.js';
import { acquireLock, type Config, loadConfig, loadState, logger } from '../infra/index.js';
import { LlmError, LlmService, OllamaClient } from '../llm/index.js';
import { getEffectiveLocation } from '../location/index.js';
import {
  cleanupLeftovers,
  createChannels,
  NO_OWNER_HINT,
  prepare,
  startChannels,
  stopChannels,
} from './setup.js';

export async function start(): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const releaseLock = await acquireLock(config.paths.data_dir);
  await cleanupLeftovers(config);
  const channels = createChannels(config);
  // Registered before anything that can hang (a Discord login that never gets
  // ready), so Ctrl-C always disconnects and releases the lock.
  const shutdown = async (signal: string) => {
    logger.info(`收到 ${signal}，正在退出`);
    await stopChannels(channels);
    await releaseLock();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  try {
    await startBot(config, channels);
  } catch (error) {
    await stopChannels(channels);
    await releaseLock();
    throw error;
  }
}

async function startBot(config: Config, channels: Channel[]): Promise<void> {
  const state = await loadState(config.paths.data_dir);
  const location = await getEffectiveLocation(config);
  logger.info(
    `配置加载成功：模型 ${config.ollama.model}，位置 ${location.city}（${location.timezone}），上次早报 ${state.lastBriefDate ?? '无'}`,
  );

  // Ollama may still be starting after a reboot; the check is retried on the first request.
  const client = new OllamaClient(config.ollama);
  await client.check().catch((error: unknown) => {
    logger.warn(
      `模型检查没有通过，先继续运行：${error instanceof LlmError ? error.message : String(error)}`,
    );
  });
  const llm = new LlmService(client, config.ollama.num_ctx);
  const core = new ChatCore({ config, llm, archive: new Archive(config.archive.dir) });
  await core.restore();

  const started = await startChannels(channels, (text, io) => core.handle(text, io));
  if (started.length === 0) throw new Error('没有一个聊天渠道启动成功');
  if (!started.some((channel) => channel.ready)) logger.info(NO_OWNER_HINT);
  // The scheduler arrives in stage 6.
}
