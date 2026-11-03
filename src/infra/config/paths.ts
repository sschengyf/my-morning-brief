import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './schema.js';

export const PROJECT_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function resolveFrom(base: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function resolvePaths(config: Config): Config {
  const dataDir = resolveFrom(PROJECT_ROOT, config.paths.data_dir);
  return {
    ...config,
    paths: { data_dir: dataDir },
    todo: { file: resolveFrom(dataDir, config.todo.file) },
    archive: { ...config.archive, dir: resolveFrom(dataDir, config.archive.dir) },
  };
}
