import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, LOCK_FILE, LockError } from '../src/lock.js';
import { makeTempDir } from './helpers.js';

// A pid far above any real one, so it is never alive.
const DEAD_PID = 2 ** 22 + 12345;

describe('acquireLock', () => {
  it('writes the pid and removes the lock on release', async () => {
    const dir = await makeTempDir();
    const release = await acquireLock(dir, { pid: 1234 });
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe('1234');
    await release();
    await expect(readFile(join(dir, LOCK_FILE), 'utf8')).rejects.toThrow();
  });

  it('refuses to start while the owning process is alive', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, LOCK_FILE), String(process.pid));
    await expect(acquireLock(dir, { pid: process.pid + 1 })).rejects.toThrow(LockError);
    await expect(acquireLock(dir, { pid: process.pid + 1 })).rejects.toThrow('另一个实例正在运行');
  });

  it('takes over a lock left by a process that died', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, LOCK_FILE), String(DEAD_PID));
    await acquireLock(dir, { pid: 1234 });
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe('1234');
  });

  it('takes over a lock from before the last boot, even if its pid is in use again', async () => {
    const dir = await makeTempDir();
    const path = join(dir, LOCK_FILE);
    await writeFile(path, String(process.pid)); // alive, but now a different program
    const hourAgo = new Date(Date.now() - 3600_000);
    await utimes(path, hourAgo, hourAgo);
    await acquireLock(dir, { pid: 1234, bootTime: Date.now() - 60_000 });
    expect(await readFile(path, 'utf8')).toBe('1234');
  });

  it('treats an empty or unreadable lock as stale and leaves no temp files', async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, LOCK_FILE), '');
    await acquireLock(dir, { pid: 1234 });
    expect(await readdir(dir)).toEqual([LOCK_FILE]);
  });

  it('does not remove a lock another process took over', async () => {
    const dir = await makeTempDir();
    const release = await acquireLock(dir, { pid: 1234 });
    await writeFile(join(dir, LOCK_FILE), '5678');
    await release();
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe('5678');
  });
});
