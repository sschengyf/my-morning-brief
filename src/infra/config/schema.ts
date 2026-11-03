import { IANAZone } from 'luxon';
import { z } from 'zod';

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

export const schema = z.object({
  paths: z.object({ data_dir: z.string().min(1).default('data') }).prefault({}),
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

export function channelProblems(config: Config): string[] {
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
