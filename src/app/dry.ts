import { Archive } from '../archive/index.js';
import { runBrief } from '../brief/index.js';
import { loadConfig, logger } from '../infra/index.js';
import { createLlm, prepare } from './setup.js';

/** brief:dry — prints the gathered data and the brief; sends nothing, writes no archive. */
export async function dryRun(): Promise<void> {
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
