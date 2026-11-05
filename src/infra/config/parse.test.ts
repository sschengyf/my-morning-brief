import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { minimalRawConfig } from '../../../test/helpers.js';
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
      catch_up_hours: 4,
      timezone: 'Pacific/Auckland',
      city: 'Auckland',
      retry_minutes: [2, 5, 10],
    });
    expect(config.ollama.num_ctx).toBe(16384);
    expect(config.news.feeds).toEqual([]);
    expect(config.news).toMatchObject({ select_count: 40, brief_count: 10 });
    expect(config.monitor.healthcheck_url).toBe('');
    // Everything the program writes lives under data/, the one folder to mount or back up.
    expect(config.paths.data_dir).toBe(join(PROJECT_ROOT, 'data'));
    expect(config.archive.dir).toBe(join(PROJECT_ROOT, 'data', 'archive'));
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

  it('limits catch_up_hours to more than 0 and at most 12', () => {
    const raw = minimalRawConfig();
    raw.brief = { catch_up_hours: 0 };
    expectConfigError(raw, 'brief.catch_up_hours 超出允许范围');
    raw.brief = { catch_up_hours: 13 };
    expectConfigError(raw, 'brief.catch_up_hours 超出允许范围');
    raw.brief = { catch_up_hours: 1.5 };
    expect(parseConfig(raw).brief.catch_up_hours).toBe(1.5);
  });

  it('does not let brief_count exceed select_count', () => {
    const raw = minimalRawConfig();
    raw.news = { select_count: 8 };
    expectConfigError(raw, 'news.brief_count 不能大于 news.select_count');
    raw.news = { select_count: 8, brief_count: 8 };
    expect(parseConfig(raw).news.brief_count).toBe(8);
  });

  it('validates the timezone', () => {
    const raw = minimalRawConfig();
    raw.brief = { timezone: 'Auckland' };
    expectConfigError(raw, 'brief.timezone 不是有效的 IANA 时区');
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
