import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSecretsForTesting,
  createLogger,
  formatLine,
  type LogLevel,
  redact,
  registerSecrets,
} from '../../src/infra/logger.js';

const TOKEN = '7012345678:AAH9xYzExampleTokenValue_abcdefghijk';

afterEach(() => clearSecretsForTesting());

describe('redact', () => {
  it('removes Telegram tokens from grammY-style error stacks even before secrets are registered', () => {
    const error = new Error(
      `Network request for 'getUpdates' failed! (https://api.telegram.org/bot${TOKEN}/getUpdates)`,
    );
    const line = formatLine('error', '长轮询失败', [error]);
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('https://api.telegram.org/bot***/getUpdates');
    expect(line).toContain('at '); // the stack trace is still there
  });

  it('removes registered secrets such as calendar links', () => {
    registerSecrets(['https://calendar.example.com/private-a1b2c3/basic.ics', undefined, '']);
    expect(redact('下载失败：https://calendar.example.com/private-a1b2c3/basic.ics 超时')).toBe(
      '下载失败：*** 超时',
    );
  });

  it('redacts secrets inside an error cause', () => {
    registerSecrets(['https://hc-ping.com/secret-uuid']);
    const error = new Error('ping failed', {
      cause: new Error('fetch https://hc-ping.com/secret-uuid timed out'),
    });
    expect(formatLine('warn', '健康检查', [error])).not.toContain('secret-uuid');
  });

  it('ignores secrets too short to redact safely', () => {
    registerSecrets(['abc']);
    expect(redact('abc def')).toBe('abc def');
  });
});

describe('createLogger', () => {
  it('writes timestamped lines and routes warnings and errors to the error stream', () => {
    const lines: [LogLevel, string][] = [];
    const log = createLogger((level, line) => lines.push([level, line]));
    log.info('启动');
    log.warn('小心', { retry: 2 });
    log.error('失败');

    expect(lines.map(([level]) => level)).toEqual(['info', 'warn', 'error']);
    expect(lines[0]?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] 启动$/);
    expect(lines[1]?.[1]).toContain('[WARN] 小心 {"retry":2}');
  });
});
