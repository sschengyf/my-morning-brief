import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseToml, TomlError } from 'smol-toml';
import { isNotFound } from '../fs.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { mergeConfig } from './merge.js';
import { parseConfig } from './parse.js';
import { PROJECT_ROOT } from './paths.js';
import { type Config, ConfigError } from './schema.js';

export interface LoadConfigOptions {
  /**
   * Defaults to MORNING_BRIEF_CONFIG, then config.toml in the project root.
   * With MORNING_BRIEF_SHARED_CONFIG set, this is the person's own config,
   * applied on top of the shared one.
   */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * False for brief:dry, which never sends anything: no channel needs to be
   * enabled or have a real token, so the brief can be tried first.
   */
  requireChannel?: boolean;
  logger?: Logger;
}

/** Settings that are gone; set them elsewhere now. Warned about, not fatal. */
const RETIRED: [section: string, key: string, message: string][] = [
  ['brief', 'time', 'brief.time 已经不用了，定时请在聊天里用 /schedule 设置，可以删掉这一行'],
  [
    'brief',
    'catch_up_until',
    'brief.catch_up_until 已经改为 brief.catch_up_hours（定时后几小时内仍补发），可以删掉这一行',
  ],
];

function warnRetired(raw: Record<string, unknown>, logger: Logger): void {
  for (const [section, key, message] of RETIRED) {
    const table = raw[section];
    if (table && typeof table === 'object' && key in table) logger.warn(message);
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? defaultLogger;
  const path = resolve(
    PROJECT_ROOT,
    options.path ?? env.MORNING_BRIEF_CONFIG ?? join(PROJECT_ROOT, 'config.toml'),
  );

  if (!env.MORNING_BRIEF_SHARED_CONFIG) {
    const raw = await readToml(path, '请先复制 config.example.toml 为 config.toml');
    warnRetired(raw, logger);
    return parseConfig(applyEnvOverrides(raw, env), options);
  }

  const sharedPath = resolve(PROJECT_ROOT, env.MORNING_BRIEF_SHARED_CONFIG);
  const shared = await readToml(
    sharedPath,
    '请先复制 config.shared.example.toml 为 config.shared.toml',
  );
  const personal = await readToml(path, '请先复制 config.user.example.toml 为个人配置');
  if ('ollama' in personal) {
    // Every container must ask Ollama for the same model and num_ctx, or it keeps reloading.
    throw new ConfigError(
      `个人配置 ${path} 里不能写 [ollama]：所有人必须用同一个模型和 num_ctx，请写在共用配置 ${sharedPath} 里`,
    );
  }
  warnRetired(shared, logger);
  warnRetired(personal, logger);
  try {
    return parseConfig(applyEnvOverrides(mergeConfig(shared, personal), env), options);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(`${error.message}\n（共用配置 ${sharedPath}，个人配置 ${path}）`);
  }
}

async function readToml(path: string, hint: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw new ConfigError(`找不到配置文件 ${path}，${hint}`);
    throw error;
  }
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`配置文件 ${path} 不是有效的 TOML：${describeTomlError(error)}`);
  }
}

/**
 * Where and why, without the parser's quote of the offending line: logs are
 * not redacted yet at this point, and that line may hold a token or a link.
 */
function describeTomlError(error: unknown): string {
  if (!(error instanceof TomlError)) return '格式错误';
  const reason = error.message.split('\n')[0]!.replace(/^Invalid TOML document: /, '');
  return `第 ${error.line} 行第 ${error.column} 列，${reason}`;
}

function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const telegram = { ...(raw.telegram as Record<string, unknown> | undefined) };
  if (env.TELEGRAM_BOT_TOKEN) telegram.bot_token = env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_CHAT_ID) {
    const chatId = Number(env.TELEGRAM_CHAT_ID);
    // Keep the raw string when it is not a number so validation reports it.
    telegram.chat_id = Number.isInteger(chatId) ? chatId : env.TELEGRAM_CHAT_ID;
  }
  const discord = { ...(raw.discord as Record<string, unknown> | undefined) };
  if (env.DISCORD_BOT_TOKEN) discord.bot_token = env.DISCORD_BOT_TOKEN;
  if (env.DISCORD_USER_ID) discord.user_id = env.DISCORD_USER_ID;
  // Not OLLAMA_HOST: Ollama's own variable is often a bare "0.0.0.0" meant for the server.
  const ollama = { ...(raw.ollama as Record<string, unknown> | undefined) };
  if (env.MORNING_BRIEF_OLLAMA_HOST) ollama.host = env.MORNING_BRIEF_OLLAMA_HOST;
  // Lets one personal config run both in its container (/app/data) and locally (dev:dry).
  const paths = { ...(raw.paths as Record<string, unknown> | undefined) };
  if (env.MORNING_BRIEF_DATA_DIR) paths.data_dir = env.MORNING_BRIEF_DATA_DIR;
  return { ...raw, telegram, discord, ollama, paths };
}
