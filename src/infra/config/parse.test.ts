import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, minimalRawConfig } from '../../../test/helpers.js';
import { loadConfig } from './load.js';
import { parseConfig } from './parse.js';
import { PROJECT_ROOT } from './paths.js';
import { ConfigError } from './schema.js';

function expectConfigError(raw: Record<string, unknown>, ...messages: string[]) {
  try {
    parseConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    for (const message of messages) expect((error as Error).message).toContain(message);
    return;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig', () => {
  it('fills defaults for everything except the token and model', () => {
    const config = parseConfig(minimalRawConfig());
    expect(config.brief).toMatchObject({
      time: '08:00',
      catch_up_until: '12:00',
      timezone: 'Pacific/Auckland',
      city: 'Auckland',
      retry_minutes: [2, 5, 10],
    });
    expect(config.ollama.num_ctx).toBe(16384);
    expect(config.news.feeds).toEqual([]);
    expect(config.monitor.healthcheck_url).toBe('');
    // Everything the program writes lives under data/, the one folder to mount or back up.
    expect(config.paths.data_dir).toBe(join(PROJECT_ROOT, 'data'));
    expect(config.archive.dir).toBe(join(PROJECT_ROOT, 'data', 'archive'));
  });

  it('accepts the shipped config.example.toml once the placeholders are filled in', async () => {
    const dir = await makeTempDir();
    const example = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(PROJECT_ROOT, 'config.example.toml'), 'utf8'),
    );
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      example
        .replace('在这里填 Discord Developer Portal 里 Bot 页面的 token', 'discord-token-example')
        .replace('填你的模型名', 'qwen3:32b'),
    );
    const config = await loadConfig({ path, env: {} });
    expect(config.news.feeds).toHaveLength(4);
    expect(config.brief.city).toBe('Auckland');
    expect(config.discord).toEqual({
      enabled: true,
      bot_token: 'discord-token-example',
      user_id: '',
    });
    expect(config.telegram.enabled).toBe(false);
  });

  it('reports missing fields in Chinese', () => {
    expectConfigError({ telegram: { enabled: true } }, '缺少 ollama');
    expectConfigError(
      { telegram: { enabled: true, chat_id: 1 }, ollama: { model: 'qwen3' } },
      '缺少 telegram.bot_token',
    );
    expectConfigError(
      { discord: { enabled: true }, ollama: { model: 'qwen3' } },
      '缺少 discord.bot_token',
    );
  });

  it('requires at least one chat channel, unless asked not to', () => {
    const raw = { ollama: { model: 'qwen3' } };
    expectConfigError(raw, '至少要开启一个聊天渠道');
    expect(parseConfig(raw, { requireChannel: false }).telegram).toEqual({
      enabled: false,
      bot_token: '',
      chat_id: 0,
    });
  });

  it('checks tokens only for enabled channels', () => {
    const config = parseConfig({
      telegram: { enabled: false, bot_token: '在这里填 BotFather 给你的 token' },
      discord: { enabled: true, bot_token: 'discord-token', user_id: '123456789012345678' },
      ollama: { model: 'qwen3' },
    });
    expect(config.discord.user_id).toBe('123456789012345678');
  });

  it('requires the Discord user id to be a quoted string of digits', () => {
    expectConfigError(
      { discord: { enabled: true, bot_token: 'x', user_id: 123 }, ollama: { model: 'qwen3' } },
      'discord.user_id 类型错误，应为 字符串',
    );
    expectConfigError(
      { discord: { enabled: true, bot_token: 'x', user_id: 'me' }, ollama: { model: 'qwen3' } },
      'discord.user_id 应为一串数字',
    );
  });

  it('reports wrong types', () => {
    const raw = minimalRawConfig();
    raw.brief = { latitude: 'north' };
    raw.news = { feeds: 'https://example.com/rss' };
    expectConfigError(raw, 'brief.latitude 类型错误，应为 数字', 'news.feeds 类型错误，应为 数组');
  });

  it('rejects the example placeholders', () => {
    expectConfigError(
      {
        telegram: { enabled: true, bot_token: '在这里填 BotFather 给你的 token' },
        ollama: { model: 'qwen3' },
      },
      'telegram.bot_token 还是示例值',
    );
    expectConfigError(
      {
        discord: {
          enabled: true,
          bot_token: '在这里填 Discord Developer Portal 里 Bot 页面的 token',
        },
        ollama: { model: 'qwen3' },
      },
      'discord.bot_token 还是示例值',
    );
    expectConfigError(
      { ...minimalRawConfig(), ollama: { model: '填你的模型名' } },
      'ollama.model 还是示例值',
    );
  });

  it('requires catch_up_until to be later than time', () => {
    const raw = minimalRawConfig();
    raw.brief = { time: '08:00', catch_up_until: '07:30' };
    expectConfigError(raw, 'brief.catch_up_until 必须晚于 brief.time');
    raw.brief = { time: '08:00', catch_up_until: '08:00' };
    expectConfigError(raw, 'brief.catch_up_until 必须晚于 brief.time');
  });

  it('validates time format and timezone', () => {
    const raw = minimalRawConfig();
    raw.brief = { time: '8am', timezone: 'Auckland' };
    expectConfigError(raw, 'brief.time 格式应为 HH:MM', 'brief.timezone 不是有效的 IANA 时区');
  });

  it('resolves data_dir against the project root and other paths against data_dir', () => {
    const relative = parseConfig({ ...minimalRawConfig(), paths: { data_dir: 'data' } });
    expect(relative.paths.data_dir).toBe(join(PROJECT_ROOT, 'data'));
    expect(relative.todo.file).toBe(join(PROJECT_ROOT, 'data', 'todo.md'));
    expect(relative.archive.dir).toBe(join(PROJECT_ROOT, 'data', 'archive'));

    const custom = parseConfig({
      ...minimalRawConfig(),
      paths: { data_dir: '/srv/brief' },
      todo: { file: '~/vault/todo.md' },
    });
    expect(custom.todo.file).toBe(join(homedir(), 'vault', 'todo.md'));
    expect(custom.archive.dir).toBe('/srv/brief/archive');
  });
});
