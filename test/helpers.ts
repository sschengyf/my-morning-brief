import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { parseConfig } from '../src/infra/config/parse.js';
import type { Config } from '../src/infra/config/schema.js';
import type { Logger } from '../src/infra/logger.js';

/** Reads a file from test/fixtures, e.g. readFixture('news/rnz.xml'). */
export function readFixture(path: string): Promise<string> {
  return readFile(join(import.meta.dirname, 'fixtures', path), 'utf8');
}

/** The raw bytes of a fixture, for files that are not UTF-8. */
export function readFixtureBytes(path: string): Promise<Buffer> {
  return readFile(join(import.meta.dirname, 'fixtures', path));
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'morning-brief-test-'));
  tempDirs.push(dir);
  return dir;
}

export function minimalRawConfig(): Record<string, unknown> {
  return {
    telegram: {
      enabled: true,
      bot_token: '123456789:AAEexampleexampleexampleexampleexample',
      chat_id: 42,
    },
    ollama: { model: 'qwen3:32b' },
  };
}

export function testConfig(dataDir: string): Config {
  return parseConfig({ ...minimalRawConfig(), paths: { data_dir: dataDir } });
}

export interface RecordingLogger extends Logger {
  infos: string[];
  warnings: string[];
}

export function recordingLogger(): RecordingLogger {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    error: () => undefined,
  };
}
