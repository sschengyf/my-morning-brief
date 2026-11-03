import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, minimalRawConfig } from '../helpers.js';
import { loadConfig } from '../../src/infra/config/load.js';
import { parseConfig } from '../../src/infra/config/parse.js';
import { PROJECT_ROOT } from '../../src/infra/config/paths.js';
import { ConfigError } from '../../src/infra/config/schema.js';
import { secretsOf } from '../../src/infra/config/secrets.js';

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

  it('lists the tokens, Discord user id, calendar links and healthcheck url as secrets', () => {
    const config = parseConfig({
      ...minimalRawConfig(),
      discord: { bot_token: 'discord-token', user_id: '123456789012345678' },
      calendar: { ics_urls: ['webcal://example.com/private-abc.ics'] },
    });
    expect(secretsOf(config)).toEqual([
      '123456789:AAEexampleexampleexampleexampleexample',
      'discord-token',
      '123456789012345678',
      'webcal://example.com/private-abc.ics',
      'https://example.com/private-abc.ics',
    ]);
  });
});

describe('loadConfig', () => {
  it('asks the user to copy the example when config.toml is missing', async () => {
    const dir = await makeTempDir();
    await expect(loadConfig({ path: join(dir, 'config.toml'), env: {} })).rejects.toThrow(
      '请先复制 config.example.toml 为 config.toml',
    );
  });

  it('honours MORNING_BRIEF_CONFIG', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'custom.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "abcdefgh"\n[ollama]\nmodel = "qwen3"\n',
    );
    const config = await loadConfig({ env: { MORNING_BRIEF_CONFIG: path } });
    expect(config.ollama.model).toBe('qwen3');
  });

  it('lets environment variables override the token and chat id', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "from-file"\nchat_id = 0\n[ollama]\nmodel = "qwen3"\n',
    );
    const config = await loadConfig({
      path,
      env: { TELEGRAM_BOT_TOKEN: 'from-env-token', TELEGRAM_CHAT_ID: '987654' },
    });
    expect(config.telegram).toEqual({
      enabled: true,
      bot_token: 'from-env-token',
      chat_id: 987654,
    });
  });

  it('lets environment variables supply the Discord token and user id', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(path, '[discord]\nenabled = true\n[ollama]\nmodel = "qwen3"\n');
    const config = await loadConfig({
      path,
      env: { DISCORD_BOT_TOKEN: 'env-discord-token', DISCORD_USER_ID: '123456789012345678' },
    });
    expect(config.discord).toEqual({
      enabled: true,
      bot_token: 'env-discord-token',
      user_id: '123456789012345678',
    });
  });

  it('supplies the token from the environment when the file has none', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(path, '[telegram]\nenabled = true\n[ollama]\nmodel = "qwen3"\n');
    const config = await loadConfig({ path, env: { TELEGRAM_BOT_TOKEN: 'from-env-token' } });
    expect(config.telegram.bot_token).toBe('from-env-token');
  });

  it('rejects a non-numeric TELEGRAM_CHAT_ID', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "abcdefgh"\n[ollama]\nmodel = "qwen3"\n',
    );
    await expect(loadConfig({ path, env: { TELEGRAM_CHAT_ID: 'me' } })).rejects.toThrow(
      'telegram.chat_id 类型错误',
    );
  });

  it('accepts a placeholder token when no channel is required', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "在这里填 BotFather 给你的 token"\n[ollama]\nmodel = "qwen3"\n',
    );
    await expect(loadConfig({ path, env: {} })).rejects.toThrow('telegram.bot_token 还是示例值');
    const config = await loadConfig({ path, env: {}, requireChannel: false });
    expect(config.ollama.model).toBe('qwen3');
  });

  it('reports invalid TOML', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(path, '[telegram\n');
    await expect(loadConfig({ path, env: {} })).rejects.toThrow('不是有效的 TOML');
  });
});
