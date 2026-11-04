import { Archive } from '../archive/index.js';
import { type Channel, ChatCore } from '../chat/index.js';
import { acquireLock, type Config, loadConfig, logger } from '../infra/index.js';
import { LlmError, LlmService, OllamaClient } from '../llm/index.js';
import { getEffectiveLocation } from '../location/index.js';
import { remindToSchedule, Scheduler } from '../scheduler/index.js';
import {
  cleanupLeftovers,
  createChannels,
  NO_OWNER_HINT,
  prepare,
  startChannels,
  stopChannels,
} from './setup.js';

/** How long shutdown waits for a brief or reply in progress. */
const SHUTDOWN_GRACE_MS = 30_000;

interface Running {
  core?: ChatCore;
  scheduler?: Scheduler;
}

export async function start(): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const releaseLock = await acquireLock(config.paths.data_dir);
  await cleanupLeftovers(config);
  const channels = createChannels(config);
  const running: Running = {};
  // Registered before anything that can hang (a Discord login that never gets
  // ready), so Ctrl-C always disconnects and releases the lock.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signal}，正在退出`);
    await finishWork(running);
    await stopChannels(channels);
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  try {
    await startBot(config, channels, running);
  } catch (error) {
    await running.scheduler?.stop();
    await stopChannels(channels);
    await releaseLock();
    throw error;
  }
}

/**
 * Stops starting new briefs and waits, up to SHUTDOWN_GRACE_MS, for the brief
 * or replies in progress. Cut short, nothing is corrupted (all writes are
 * atomic); an unsent brief is simply sent again after the restart.
 */
async function finishWork(running: Running): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
  });
  const done = Promise.all([running.scheduler?.stop(), running.core?.settle()]).then(() => 'done');
  if ((await Promise.race([done, timeout])) === 'timeout') {
    logger.warn(`等了 ${SHUTDOWN_GRACE_MS / 1000} 秒，正在进行的早报或回复还没完成，直接退出`);
  }
  clearTimeout(timer);
}

async function startBot(config: Config, channels: Channel[], running: Running): Promise<void> {
  const location = await getEffectiveLocation(config);
  logger.info(
    `配置加载成功：模型 ${config.ollama.model}，位置 ${location.city}（${location.timezone}）`,
  );

  // Ollama may still be starting after a reboot; the check is retried on the first request.
  const client = new OllamaClient(config.ollama);
  await client.check().catch((error: unknown) => {
    logger.warn(
      `模型检查没有通过，先继续运行：${error instanceof LlmError ? error.message : String(error)}`,
    );
  });
  const llm = new LlmService(client, config.ollama.num_ctx);
  const archive = new Archive(config.archive.dir);
  const core = new ChatCore({ config, llm, archive });
  running.core = core;
  await core.restore();

  const started = await startChannels(channels, (text, io) => core.handle(text, io));
  if (started.length === 0) throw new Error('没有一个聊天渠道启动成功');
  const ready = started.filter((channel) => channel.ready);
  if (ready.length === 0) {
    // Nobody to send to yet; retries would only be used up.
    logger.info(NO_OWNER_HINT);
    logger.info('还没有配置主人 id，定时早报暂不启动');
    return;
  }

  await remindToSchedule(config.paths.data_dir, ready);
  const scheduler = new Scheduler({ brief: { config, llm, archive }, core, channels: ready });
  running.scheduler = scheduler;
  scheduler.start();
}
