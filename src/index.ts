import { dryRun, once, start } from './app/index.js';
import { ConfigError, DataDirError, LockError, logger } from './infra/index.js';
import { LlmError } from './llm/index.js';

type Mode = 'start' | 'once' | 'dry';

function parseMode(args: string[]): Mode {
  if (args.includes('--dry')) return 'dry';
  if (args.includes('--once')) return 'once';
  return 'start';
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
