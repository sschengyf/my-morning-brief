import { open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound } from './fsUtil.js';

export class LockError extends Error {
  override name = 'LockError';
}

export const LOCK_FILE = 'app.lock';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Makes sure only one instance runs against a data_dir. Telegram rejects a
 * second poller with 409, but Discord happily connects both and every message
 * would be answered twice. A lock left by a process that died is taken over.
 * Returns a function that releases the lock.
 */
export async function acquireLock(
  dataDir: string,
  pid = process.pid,
): Promise<() => Promise<void>> {
  const path = join(dataDir, LOCK_FILE);
  for (;;) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(String(pid));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: number;
    try {
      owner = Number((await readFile(path, 'utf8')).trim());
    } catch (error) {
      if (isNotFound(error)) continue; // released in between; try again
      throw error;
    }
    if (Number.isInteger(owner) && owner > 0 && owner !== pid && isAlive(owner)) {
      throw new LockError(
        `另一个实例正在运行（进程 ${owner}，可能是开机自启的那个），请先停掉其中一个`,
      );
    }
    await writeFile(path, String(pid));
    break;
  }

  return async () => {
    try {
      if ((await readFile(path, 'utf8')).trim() === String(pid)) await unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };
}
