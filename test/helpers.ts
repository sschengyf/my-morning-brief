import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { parseConfig, type Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';

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
  warnings: string[];
}

export function recordingLogger(): RecordingLogger {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined,
  };
}
