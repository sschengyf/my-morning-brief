import { spawn } from 'node:child_process';
import { logger as defaultLogger, type Logger } from '../infra/index.js';

/**
 * Keeps a Mac awake until the returned function is called: after a pmset
 * wake-up it would fall asleep again within a minute, mid-brief. Uses
 * `caffeinate -i -w <pid>`, which also ends on its own if this process dies.
 * Does nothing on other platforms.
 */
export function keepAwake(logger: Logger = defaultLogger): () => void {
  if (process.platform !== 'darwin') return () => undefined;
  const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', (error) =>
    logger.warn('caffeinate 启动失败，生成早报期间 Mac 可能会睡眠', error),
  );
  return () => {
    child.kill();
  };
}
