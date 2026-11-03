import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export class DataDirError extends Error {
  override name = 'DataDirError';
}

const TEMP_FILE_PATTERN = /^\..+\.[0-9a-f]{12}\.tmp$/;

/**
 * Writes via a temp file in the same directory, then renames over the target,
 * so a crash mid-write never leaves a truncated file behind. Same directory
 * keeps the rename on one filesystem, where it is atomic.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/** Creates data_dir if needed and fails with a readable message when it is not writable. */
export async function ensureDataDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch (error) {
    throw new DataDirError(
      `数据目录 ${dir} 无法创建或没有写权限，请检查 config.toml 里的 paths.data_dir`,
      { cause: error },
    );
  }
}

/** Removes temp files left behind by writes that were interrupted. Returns the removed paths. */
export async function cleanupTempFiles(dir: string): Promise<string[]> {
  const removed: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        removed.push(...(await cleanupTempFiles(path)));
      }
    } else if (entry.isFile() && TEMP_FILE_PATTERN.test(entry.name)) {
      await unlink(path).catch(() => undefined);
      removed.push(path);
    }
  }
  return removed;
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
