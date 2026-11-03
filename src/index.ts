import { Archive } from './archive.js';
import { runBrief } from './brief.js';
import {
  CHANNEL_LABELS,
  sendToChannels,
  type Channel,
  type MessageHandler,
} from './chat/channel.js';
import { ChatCore } from './chat/commands.js';
import { DiscordChannel } from './chat/discord.js';
import { TelegramChannel } from './chat/telegram.js';
import { ConfigError, loadConfig, secretsOf, type Config } from './config.js';
import { cleanupTempFiles, DataDirError, ensureDataDir } from './fsUtil.js';
import { LlmError, LlmService, OllamaClient } from './llm.js';
import { getEffectiveLocation } from './location.js';
import { acquireLock, LockError } from './lock.js';
import { logger, registerSecrets } from './logger.js';
import { loadState } from './state.js';

type Mode = 'start' | 'once' | 'dry';

function parseMode(args: string[]): Mode {
  if (args.includes('--dry')) return 'dry';
  if (args.includes('--once')) return 'once';
  return 'start';
}

async function prepare(config: Config): Promise<void> {
  registerSecrets(secretsOf(config));
  await ensureDataDir(config.paths.data_dir);
  const removed = await cleanupTempFiles(config.paths.data_dir);
  if (removed.length > 0) logger.info(`清理了 ${removed.length} 个上次中断写入留下的临时文件`);
}

async function createLlm(config: Config): Promise<LlmService> {
  const client = new OllamaClient(config.ollama);
  await client.check();
  return new LlmService(client, config.ollama.num_ctx);
}

/** brief:dry — prints the gathered data and the brief; sends nothing, writes no archive. */
async function dryRun(): Promise<void> {
  const config = await loadConfig({ requireChannel: false });
  await prepare(config);
  const llm = await createLlm(config);
  logger.info(`正在抓取数据并用 ${config.ollama.model} 生成早报…`);

  const result = await runBrief(
    { kind: 'manual', archive: false, send: async () => undefined },
    { config, llm, archive: new Archive(config.archive.dir) },
  );
  if (result.input !== undefined) {
    process.stdout.write(`\n===== 给模型的数据 =====\n\n${result.input}\n`);
  }
  if (result.status === 'llm_failed') {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n===== 早报 =====\n\n${result.text}\n`);
}

function createChannels(config: Config): Channel[] {
  const channels: Channel[] = [];
  if (config.telegram.enabled) channels.push(new TelegramChannel(config.telegram));
  if (config.discord.enabled) channels.push(new DiscordChannel(config.discord));
  return channels;
}

const NO_OWNER_HINT =
  '还没有配置主人 id：先运行 npm start，给机器人发一条私信，按回复把 id 填进 config.toml';

/** brief:once — sends one brief to every ready channel and exits; lastBriefDate is untouched. */
async function once(): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const ready = createChannels(config).filter((channel) => channel.ready);
  if (ready.length === 0) {
    logger.error(NO_OWNER_HINT);
    process.exitCode = 1;
    return;
  }
  const llm = await createLlm(config);
  // Send-only: no handler, so a running `npm start` keeps receiving the messages.
  const connected = await startChannels(ready);
  try {
    if (connected.length === 0) throw new Error('没有一个聊天渠道连接成功');
    const result = await runBrief(
      { kind: 'manual', archive: true, send: (text) => sendToChannels(connected, text) },
      { config, llm, archive: new Archive(config.archive.dir) },
    );
    if (result.status === 'sent' && connected.length === ready.length) logger.info('早报已发送');
    else process.exitCode = 1;
  } finally {
    await stopChannels(connected);
  }
}

/** Starts each channel on its own; one that fails is stopped, logged and left out. */
async function startChannels(channels: Channel[], handler?: MessageHandler): Promise<Channel[]> {
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

async function stopChannels(channels: Channel[]): Promise<void> {
  await Promise.allSettled(channels.map((channel) => channel.stop()));
}

async function start(): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const releaseLock = await acquireLock(config.paths.data_dir);
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

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'dry') await dryRun();
  else if (mode === 'once') await once();
  else await start();
}

main().catch((error: unknown) => {
  if (
    error instanceof ConfigError ||
    error instanceof DataDirError ||
    error instanceof LlmError ||
    error instanceof LockError
  ) {
    logger.error(error.message);
  } else {
    logger.error('启动失败', error);
  }
  process.exitCode = 1;
});
