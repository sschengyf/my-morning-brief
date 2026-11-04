import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../../test/helpers.js';
import { loadConfig } from './load.js';
import { PROJECT_ROOT } from './paths.js';

describe('loadConfig', () => {
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

  it('lets MORNING_BRIEF_OLLAMA_HOST override the Ollama host, and ignores OLLAMA_HOST', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "abcdefgh"\n[ollama]\nmodel = "qwen3"\nhost = "http://localhost:11434"\n',
    );
    const fromFile = await loadConfig({ path, env: { OLLAMA_HOST: '0.0.0.0' } });
    expect(fromFile.ollama.host).toBe('http://localhost:11434');
    const config = await loadConfig({
      path,
      env: { MORNING_BRIEF_OLLAMA_HOST: 'http://host.docker.internal:11434' },
    });
    expect(config.ollama.host).toBe('http://host.docker.internal:11434');
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

  it('warns about retired brief.time and catch_up_until instead of failing', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(
      path,
      '[telegram]\nenabled = true\nbot_token = "abcdefgh"\n[ollama]\nmodel = "qwen3"\n[brief]\ntime = "08:00"\ncatch_up_until = "12:00"\n',
    );
    const logger = recordingLogger();
    const config = await loadConfig({ path, env: {}, logger });
    expect(config.brief.catch_up_hours).toBe(4);
    expect(logger.warnings).toEqual([
      expect.stringContaining('brief.time 已经不用了，定时请在聊天里用 /schedule 设置'),
      expect.stringContaining('brief.catch_up_until 已经改为 brief.catch_up_hours'),
    ]);
  });

  it('reports invalid TOML', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'config.toml');
    await writeFile(path, '[telegram\n');
    await expect(loadConfig({ path, env: {} })).rejects.toThrow('不是有效的 TOML');
  });
});
