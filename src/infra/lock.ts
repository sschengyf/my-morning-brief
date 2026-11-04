import { randomBytes } from 'node:crypto';
import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname, uptime } from 'node:os';
import { join } from 'node:path';
import { isNotFound } from './fs.js';

export class LockError extends Error {
  override name = 'LockError';
}

export const LOCK_FILE = 'app.lock';

// Boot times derived from the clock drift when NTP adjusts it; within this, it is the same boot.
const BOOT_TIME_TOLERANCE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Identifies the current boot: Linux's boot id if there is one, else the boot time. */
export interface Boot {
  id?: string;
  /** ms since the epoch */
  time?: number;
}

export async function currentBoot(): Promise<Boot> {
  const time = Date.now() - uptime() * 1000;
  try {
    // Unaffected by clock jumps, unlike the boot time: hosts without an RTC
    // often boot with a wrong clock that NTP corrects later.
    const id = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (id) return { id, time };
  } catch {
    // not Linux
  }
  return { time };
}

/** False only when both boots are known and differ; an unknown boot counts as the same. */
function sameBoot(a: Boot, b: Boot): boolean {
  if (a.id && b.id) return a.id === b.id;
  if (a.time !== undefined && b.time !== undefined) {
    return Math.abs(a.time - b.time) <= BOOT_TIME_TOLERANCE_MS;
  }
  return true;
}

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
  boot?: Boot;
  host?: string;
}

interface Owner {
  pid: number | null;
  boot: Boot;
  /** Missing in locks from before it was recorded: taken as this host. */
  host?: string;
  /** Identifies this lock file, so a takeover never removes a newer one. */
  ino: number;
}

/**
 * Makes sure only one instance runs against a data_dir. Telegram rejects a
 * second poller with 409, but Discord happily connects both and every message
 * would be answered twice. Returns a function that releases the lock.
 *
 * The lock holds the pid and the boot it started in, and is created complete
 * in one step (a hard link to a file that already holds them), so nobody
 * reads it half-written. It is stale when its process has died, or when it is
 * from an earlier boot: after a power cut its pid may belong to some
 * unrelated process by now.
 *
 * It also holds the host name. A container and the Mac can share data/, and
 * neither can see the other's processes, so a lock from another host is never
 * taken over; the user removes it. A container's program is always pid 1 under
 * the host name set in compose.yaml, so a container's own leftover lock is
 * still taken over (same pid as ours).
 */
export async function acquireLock(
  dataDir: string,
  options: LockOptions = {},
): Promise<() => Promise<void>> {
  const pid = options.pid ?? process.pid;
  const boot = options.boot ?? (await currentBoot());
  const host = options.host ?? hostname();
  const path = join(dataDir, LOCK_FILE);
  const suffix = randomBytes(6).toString('hex');
  const temp = join(dataDir, `.${LOCK_FILE}.${suffix}.tmp`);
  const content = JSON.stringify({ pid, boot, host });

  try {
    for (let attempt = 1; ; attempt++) {
      if (attempt > MAX_ATTEMPTS) throw new LockError('获取 app.lock 失败：反复被其他实例抢占');
      // Written each round: a starting instance's temp-file cleanup may have removed it.
      await writeFile(temp, content);
      try {
        await link(temp, path);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (isNotFound(error)) continue;
          throw error;
        }
      }
      const owner = await readOwner(path);
      if (!owner) continue; // released in between
      if (owner.host !== undefined && owner.host !== host) {
        throw new LockError(
          `${path} 属于另一台机器或容器（${owner.host}）上的实例。它在运行就先停掉它（docker compose down，或在那边按 Ctrl-C）；确认已经停了，再删掉这个文件`,
        );
      }
      if (
        owner.pid !== null &&
        owner.pid !== pid &&
        isAlive(owner.pid) &&
        sameBoot(owner.boot, boot)
      ) {
        throw new LockError(`另一个实例正在运行（进程 ${owner.pid}），请先停掉其中一个`);
      }
      await removeStale(path, owner.ino, join(dataDir, `.${LOCK_FILE}.${suffix}.stale`));
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }

  return async () => {
    try {
      const owner = await readOwner(path);
      if (owner?.pid === pid) await unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };
}

/**
 * Removes the stale lock with inode `ino`. It is renamed aside first and
 * checked, because another starter may have replaced it with its own live
 * lock in the meantime; that one is put back.
 */
export async function removeStale(path: string, ino: number, aside: string): Promise<void> {
  try {
    await rename(path, aside);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  if ((await stat(aside)).ino !== ino) {
    await link(aside, path).catch(() => undefined);
  }
  await unlink(aside).catch(() => undefined);
}

async function readOwner(path: string): Promise<Owner | null> {
  let text: string;
  let ino: number;
  try {
    [text, { ino }] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const validPid = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { pid: null, boot: {}, ino };
  }
  // A lock from before the boot was recorded holds just the pid.
  if (typeof parsed === 'number') return { pid: validPid(parsed), boot: {}, ino };
  const record = (parsed ?? {}) as { pid?: unknown; boot?: Boot; host?: unknown };
  return {
    pid: validPid(record.pid),
    boot: record.boot ?? {},
    ...(typeof record.host === 'string' && { host: record.host }),
    ino,
  };
}
