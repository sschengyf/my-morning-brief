import { IANAZone } from 'luxon';
import { z } from 'zod';
import { looksLikeDomain } from '../text.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// Values copied verbatim from config.example.toml mean the user has not filled them in yet.
const PLACEHOLDER_BOT_TOKEN = '在这里填 BotFather 给你的 token';
const PLACEHOLDER_DISCORD_TOKEN = '在这里填 Discord Developer Portal 里 Bot 页面的 token';
const PLACEHOLDER_MODEL = '填你的模型名';

const timezone = z
  .string()
  .refine((value) => IANAZone.isValidZone(value), '不是有效的 IANA 时区，例如 Pacific/Auckland');
const positiveInt = z.number().int().positive();

/** A feed URL, or { url, name } to show a short name instead of the feed's own title. */
const feed = z.union([
  z.url().transform((url) => ({ url })),
  z.object({
    url: z.url(),
    name: z
      .string()
      .trim()
      .min(1)
      .refine(
        (name) => !looksLikeDomain(name),
        '不要写成域名的样子（会被输出清理删掉），例如把 interest.co.nz 写成 interest',
      )
      .optional(),
  }),
]);
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
      weekend_news: z.boolean().default(true),
      // Send times are not here: they are set in chat with /schedule (data/schedules.json).
      catch_up_hours: z.number().positive().max(12).default(4),
      retry_minutes: z.array(positiveInt).default([2, 5, 10]),
      timezone: timezone.default('Pacific/Auckland'),
      city: z.string().min(1).default('Auckland'),
      latitude: z.number().min(-90).max(90).default(-36.85),
      longitude: z.number().min(-180).max(180).default(174.76),
    })
    .prefault({}),
  calendar: z.object({ ics_urls: z.array(z.string().min(1)).default([]) }).prefault({}),
  news: z
    .object({
      max_items_per_feed: positiveInt.default(10),
      max_age_hours: positiveInt.default(48),
      select_count: positiveInt.default(40),
      brief_count: positiveInt.default(10),
      dedup_days: nonNegativeInt.default(3),
      feeds: z.array(feed).default([]),
      interests: z.array(z.string().min(1)).default([]),
      avoid: z.array(z.string().min(1)).default([]),
      select_timeout_seconds: positiveInt.default(120),
    })
    .refine((news) => news.brief_count <= news.select_count, {
      message: '不能大于 news.select_count',
      path: ['brief_count'],
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
