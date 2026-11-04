import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../../test/helpers.js';
import { acquireLock, LOCK_FILE, LockError, removeStale, type Boot } from './lock.js';

// A pid far above any real one, so it is never alive.
const DEAD_PID = 2 ** 22 + 12345;
const BOOT: Boot = { id: 'boot-a', time: Date.parse('2026-11-04T07:00:00Z') };

async function lockContent(dir: string) {
  return JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8')) as { pid: number; boot: Boot };
}

function writeLock(dir: string, pid: number, boot: Boot = BOOT) {
  return writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid, boot }));
}

describe('acquireLock', () => {
  it('records the pid and boot, and removes the lock on release', async () => {
    const dir = await makeTempDir();
    const release = await acquireLock(dir, { pid: 1234, boot: BOOT });
    expect(await lockContent(dir)).toEqual({ pid: 1234, boot: BOOT });
    expect(await readdir(dir)).toEqual([LOCK_FILE]); // no temp file left behind
    await release();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses to start while the owner is alive in this boot', async () => {
    const dir = await makeTempDir();
    await writeLock(dir, process.pid);
    const second = acquireLock(dir, { pid: 1234, boot: BOOT });
    await expect(second).rejects.toThrow(LockError);
    await expect(acquireLock(dir, { pid: 1234, boot: BOOT })).rejects.toThrow('另一个实例正在运行');
  });

  it('takes over a lock left by a process that died', async () => {
    const dir = await makeTempDir();
    await writeLock(dir, DEAD_PID);
    await acquireLock(dir, { pid: 1234, boot: BOOT });
    expect((await lockContent(dir)).pid).toBe(1234);
  });

  it('takes over a lock from an earlier boot, even if its pid is in use again', async () => {
    const dir = await makeTempDir();
    await writeLock(dir, process.pid, {
      id: 'boot-before-power-cut',
      time: BOOT.time! - 86_400_000,
    });
    await acquireLock(dir, { pid: 1234, boot: BOOT });
    expect((await lockContent(dir)).pid).toBe(1234);
  });

  it('uses the boot id when there is one, so a clock jump does not make a live lock stale', async () => {
    const dir = await makeTempDir();
    // Same boot, but the clock was corrected by a day after the lock was written.
    await writeLock(dir, process.pid, { id: 'boot-a', time: BOOT.time! - 86_400_000 });
    await expect(acquireLock(dir, { pid: 1234, boot: BOOT })).rejects.toThrow(LockError);
  });

  it('without a boot id, allows some drift in the boot time', async () => {
    const dir = await makeTempDir();
    await writeLock(dir, process.pid, { time: BOOT.time! - 60_000 });
    await expect(acquireLock(dir, { pid: 1234, boot: { time: BOOT.time! } })).rejects.toThrow(
      LockError,
    );
    await writeLock(dir, process.pid, { time: BOOT.time! - 3_600_000 });
    await acquireLock(dir, { pid: 1234, boot: { time: BOOT.time! } });
    expect((await lockContent(dir)).pid).toBe(1234);
  });

  it('reads locks from before the boot was recorded, which hold just the pid', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, LOCK_FILE), String(process.pid));
    await expect(acquireLock(dir, { pid: 1234, boot: BOOT })).rejects.toThrow(LockError);
    await writeFile(join(dir, LOCK_FILE), String(DEAD_PID));
    await acquireLock(dir, { pid: 1234, boot: BOOT });
    expect((await lockContent(dir)).pid).toBe(1234);
  });

  it('treats an empty or unreadable lock as stale', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, LOCK_FILE), '');
    await acquireLock(dir, { pid: 1234, boot: BOOT });
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it('never removes a live lock that replaced the stale one it meant to remove', async () => {
    const dir = await makeTempDir();
    const path = join(dir, LOCK_FILE);
    await writeLock(dir, DEAD_PID);
    const staleIno = (await stat(path)).ino;
    // Another starter removes the stale lock and creates its own before we act.
    await unlink(path);
    await writeLock(dir, process.pid);
    await removeStale(path, staleIno, join(dir, '.aside'));
    expect((await lockContent(dir)).pid).toBe(process.pid);
    expect(await readdir(dir)).toEqual([LOCK_FILE]);

    // The stale lock itself is removed.
    await removeStale(path, (await stat(path)).ino, join(dir, '.aside'));
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not remove a lock another process took over', async () => {
    const dir = await makeTempDir();
    const release = await acquireLock(dir, { pid: 1234, boot: BOOT });
    await writeLock(dir, 5678);
    await release();
    expect((await lockContent(dir)).pid).toBe(5678);
  });
});
