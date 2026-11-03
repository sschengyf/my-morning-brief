import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers.js';
import {
  cleanupTempFiles,
  DataDirError,
  ensureDataDir,
  writeFileAtomic,
} from '../../src/infra/fs.js';

describe('writeFileAtomic', () => {
  it('creates and replaces files', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'state.json');
    await writeFileAtomic(path, 'first');
    await writeFileAtomic(path, '第二次');
    expect(await readFile(path, 'utf8')).toBe('第二次');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('leaves the original untouched and cleans up when writing fails midway', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'todo.md');
    await writeFile(path, '- [ ] original');

    // Invalid content makes the write itself throw after the temp file is open.
    await expect(writeFileAtomic(path, 42 as unknown as string)).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe('- [ ] original');
    expect(await readdir(dir)).toEqual(['todo.md']);
  });

  it('cleans up when the final rename fails', async () => {
    const dir = await makeTempDir();
    const target = join(dir, 'occupied');
    await mkdir(join(target, 'child'), { recursive: true });

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['occupied']);
  });
});

describe('cleanupTempFiles', () => {
  it('removes leftover temp files recursively and keeps everything else', async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, 'archive', '2026-11-02'), { recursive: true });
    await writeFile(join(dir, '.state.json.0123456789ab.tmp'), '');
    await writeFile(join(dir, 'archive', '2026-11-02', '.brief.md.abcdef012345.tmp'), '');
    await writeFile(join(dir, 'state.json'), '{}');
    await writeFile(join(dir, '.gitignore'), '');

    const removed = await cleanupTempFiles(dir);

    expect(removed).toHaveLength(2);
    expect((await readdir(dir)).sort()).toEqual(['.gitignore', 'archive', 'state.json']);
    expect(await readdir(join(dir, 'archive', '2026-11-02'))).toEqual([]);
  });
});

describe('ensureDataDir', () => {
  it('creates missing directories', async () => {
    const dir = join(await makeTempDir(), 'nested', 'data');
    await ensureDataDir(dir);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails with a Chinese message when the directory is not writable', async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const parent = await makeTempDir();
    const dir = join(parent, 'readonly');
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      await expect(ensureDataDir(dir)).rejects.toThrow(DataDirError);
      await expect(ensureDataDir(dir)).rejects.toThrow('没有写权限');
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
