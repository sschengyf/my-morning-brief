import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IANAZone } from 'luxon';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { isNotFound } from './fsUtil.js';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Values copied verbatim from config.example.toml mean the user has not filled them in yet.
const PLACEHOLDER_BOT_TOKEN = '在这里填 BotFather 给你的 token';
const PLACEHOLDER_DISCORD_TOKEN = '在这里填 Discord Developer Portal 里 Bot 页面的 token';
const PLACEHOLDER_MODEL = '填你的模型名';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const time = z.string().regex(TIME_PATTERN, '格式应为 HH:MM，例如 08:00');
const timezone = z
  .string()
  .refine((value) => IANAZone.isValidZone(value), '不是有效的 IANA 时区，例如 Pacific/Auckland');
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const schema = z.object({
  paths: z.object({ data_dir: z.string().min(1).default('.') }).prefault({}),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
      chat_id: z.number().int().default(0),
    })
    .prefault({}),
  discord: z
    .object({
      enabled: z.boolean().default(false),
      bot_token: z.string().default(''),
      // Snowflakes exceed Number.MAX_SAFE_INTEGER, so they must stay strings.
      user_id: z
        .string()
        .regex(/^\d*$/, '应为一串数字（加引号），例如 "123456789012345678"')
        .default(''),
    })
    .prefault({}),
  ollama: z.object({
    host: z.url().default('http://localhost:11434'),
    model: z
      .string()
      .min(1)
      .refine(
        (value) => value !== PLACEHOLDER_MODEL,
        '还是示例值，请填入 `ollama list` 里显示的模型名',
      ),
    temperature: z.number().min(0).max(2).default(0.3),
    think: z.boolean().default(false),
    timeout_seconds: positiveInt.default(600),
    num_ctx: positiveInt.default(16384),
    keep_alive: z.string().min(1).default('30m'),
  }),
  brief: z
    .object({
      time: time.default('08:00'),
      weekend_news: z.boolean().default(true),
      catch_up_until: time.default('12:00'),
      retry_minutes: z.array(positiveInt).default([2, 5, 10]),
      timezone: timezone.default('Pacific/Auckland'),
      city: z.string().min(1).default('Auckland'),
      latitude: z.number().min(-90).max(90).default(-36.85),
      longitude: z.number().min(-180).max(180).default(174.76),
    })
    .prefault({})
    // HH:MM strings compare correctly as text.
    .refine((brief) => brief.catch_up_until > brief.time, {
      message: '必须晚于 brief.time（不支持跨午夜）',
      path: ['catch_up_until'],
    }),
  calendar: z.object({ ics_urls: z.array(z.string().min(1)).default([]) }).prefault({}),
  news: z
    .object({
      max_items_per_feed: positiveInt.default(10),
      max_age_hours: positiveInt.default(48),
      select_count: positiveInt.default(10),
      dedup_days: nonNegativeInt.default(3),
      feeds: z.array(z.url()).default([]),
      interests: z.array(z.string().min(1)).default([]),
      avoid: z.array(z.string().min(1)).default([]),
      select_timeout_seconds: positiveInt.default(120),
    })
    .prefault({}),
  todo: z.object({ file: z.string().min(1).default('todo.md') }).prefault({}),
  archive: z
    .object({
      dir: z.string().min(1).default('archive'),
      retention_days: nonNegativeInt.default(90),
    })
    .prefault({}),
  monitor: z
    .object({ healthcheck_url: z.union([z.literal(''), z.url()]).default('') })
    .prefault({}),
});

export type Config = z.infer<typeof schema>;

export interface LoadConfigOptions {
  /** Defaults to MORNING_BRIEF_CONFIG, then config.toml in the project root. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * False for brief:dry, which never sends anything: no channel needs to be
   * enabled or have a real token, so the brief can be tried first.
   */
  requireChannel?: boolean;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const path = resolve(
    PROJECT_ROOT,
    options.path ?? env.MORNING_BRIEF_CONFIG ?? join(PROJECT_ROOT, 'config.toml'),
  );

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      throw new ConfigError(`找不到配置文件 ${path}，请先复制 config.example.toml 为 config.toml`);
    }
    throw error;
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`配置文件 ${path} 不是有效的 TOML：${(error as Error).message}`);
  }

  return parseConfig(applyEnvOverrides(raw, env), options);
}

/** Validates an already-parsed TOML object and resolves relative paths. */
export function parseConfig(
  raw: Record<string, unknown>,
  options: Pick<LoadConfigOptions, 'requireChannel'> = {},
): Config {
  const result = schema.safeParse(raw);
  const lines = result.success
    ? []
    : result.error.issues.map((issue) => `- ${describeIssue(issue, raw)}`);
  if (result.success && options.requireChannel !== false) {
    lines.push(...channelProblems(result.data).map((problem) => `- ${problem}`));
  }
  if (!result.success || lines.length > 0) {
    throw new ConfigError(`配置有误：\n${lines.join('\n')}`);
  }
  return resolvePaths(result.data);
}

function channelProblems(config: Config): string[] {
  const { telegram, discord } = config;
  if (!telegram.enabled && !discord.enabled) {
    return ['至少要开启一个聊天渠道：telegram.enabled 或 discord.enabled 设为 true'];
  }
  const problems: string[] = [];
  if (telegram.enabled) {
    if (!telegram.bot_token) problems.push('缺少 telegram.bot_token');
    else if (telegram.bot_token === PLACEHOLDER_BOT_TOKEN) {
      problems.push('telegram.bot_token 还是示例值，请填入 BotFather 给你的 token');
    }
  }
  if (discord.enabled) {
    if (!discord.bot_token) problems.push('缺少 discord.bot_token');
    else if (discord.bot_token === PLACEHOLDER_DISCORD_TOKEN) {
      problems.push(
        'discord.bot_token 还是示例值，请填入 Discord Developer Portal 里 Bot 页面的 token',
      );
    }
  }
  return problems;
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
  return { ...raw, telegram, discord };
}

function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const key = issue.path.join('.');
  if (issue.code === 'invalid_type') {
    return valueAt(raw, issue.path) === undefined
      ? `缺少 ${key}`
      : `${key} 类型错误，应为 ${TYPE_NAMES[issue.expected] ?? issue.expected}`;
  }
  if (issue.code === 'invalid_format' && issue.format === 'url') return `${key} 不是有效的网址`;
  if (issue.code === 'too_small' || issue.code === 'too_big') return `${key} 超出允许范围`;
  if (issue.code === 'invalid_union') return `${key} 格式不对`;
  // Custom refinements and regex checks already carry Chinese messages.
  return `${key} ${issue.message}`;
}

const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  int: '整数',
  boolean: 'true 或 false',
  array: '数组',
  object: '表（[section]）',
};

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function resolveFrom(base: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

function resolvePaths(config: Config): Config {
  const dataDir = resolveFrom(PROJECT_ROOT, config.paths.data_dir);
  return {
    ...config,
    paths: { data_dir: dataDir },
    todo: { file: resolveFrom(dataDir, config.todo.file) },
    archive: { ...config.archive, dir: resolveFrom(dataDir, config.archive.dir) },
  };
}

/** Values that must never appear in logs. */
export function secretsOf(config: Config): string[] {
  return [
    config.telegram.bot_token,
    config.discord.bot_token,
    config.discord.user_id,
    ...config.calendar.ics_urls,
    ...config.calendar.ics_urls.map((url) => url.replace(/^webcal:\/\//i, 'https://')),
    config.monitor.healthcheck_url,
  ].filter((value) => value.length > 0);
}
