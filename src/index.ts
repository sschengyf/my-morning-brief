import { Archive } from './archive.js';
import { runBrief } from './brief.js';
import { ConfigError, loadConfig, secretsOf, type Config } from './config.js';
import { cleanupTempFiles, DataDirError, ensureDataDir } from './fsUtil.js';
import { LlmError, LlmService, OllamaClient } from './llm.js';
import { getEffectiveLocation } from './location.js';
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

/** brief:dry — prints the gathered data and the brief; no Telegram, no archive. */
async function dryRun(): Promise<void> {
  const config = await loadConfig({ requireTelegram: false });
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

async function start(mode: 'start' | 'once'): Promise<void> {
  const config = await loadConfig();
  await prepare(config);
  const state = await loadState(config.paths.data_dir);
  const location = await getEffectiveLocation(config);
  logger.info(
    `配置加载成功：模型 ${config.ollama.model}，位置 ${location.city}（${location.timezone}），上次早报 ${state.lastBriefDate ?? '无'}`,
  );
  // Telegram (brief:once and the bot) arrives in stage 5, the scheduler in stage 6.
  if (mode === 'once') {
    logger.error('brief:once 需要 Telegram，阶段 5 实现后可用；现在可以先用 npm run brief:dry');
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  if (mode === 'dry') await dryRun();
  else await start(mode);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof DataDirError || error instanceof LlmError) {
    logger.error(error.message);
  } else {
    logger.error('启动失败', error);
  }
  process.exitCode = 1;
});
