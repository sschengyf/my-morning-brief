import { randomBytes } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
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

export interface LockOptions {
  pid?: number;
  /** When the system booted, in ms since the epoch. */
  bootTime?: number;
}

/**
 * Makes sure only one instance runs against a data_dir. Telegram rejects a
 * second poller with 409, but Discord happily connects both and every message
 * would be answered twice. Returns a function that releases the lock.
 *
 * The lock is created complete in one step (a hard link to a file that
 * already holds the pid), so nobody ever reads it half-written. It is stale
 * when its process has died, or when it predates the last boot: after a power
 * cut its pid may belong to some unrelated process by now.
 */
export async function acquireLock(
  dataDir: string,
  { pid = process.pid, bootTime = Date.now() - uptime() * 1000 }: LockOptions = {},
): Promise<() => Promise<void>> {
  const path = join(dataDir, LOCK_FILE);
  const temp = join(dataDir, `.${LOCK_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(temp, String(pid));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await link(temp, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 3) throw error;
      }
      const owner = await readOwner(path);
      if (owner && owner.pid !== pid && owner.since >= bootTime && isAlive(owner.pid)) {
        throw new LockError(
          `另一个实例正在运行（进程 ${owner.pid}，可能是开机自启的那个），请先停掉其中一个`,
        );
      }
      // Stale: remove it and try to create ours again; if another starter
      // gets there first, the next round sees its live lock.
      await unlink(path).catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }

  return async () => {
    try {
      if ((await readFile(path, 'utf8')).trim() === String(pid)) await unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };
}

async function readOwner(path: string): Promise<{ pid: number; since: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? { pid, since: info.mtimeMs } : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
