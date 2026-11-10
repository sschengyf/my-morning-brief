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

export const schema = z
  .object({
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
        brief_count: positiveInt.optional(),
        dedup_days: nonNegativeInt.default(3),
        feeds: z.array(feed).default([]),
        // A person's feeds on top of the shared ones.
        extra_feeds: z.array(feed).default([]),
        interests: z.array(z.string().min(1)).default([]),
        avoid: z.array(z.string().min(1)).default([]),
        select_timeout_seconds: positiveInt.default(120),
      })
      // Unset, it is 10 but never more than select_count, so older configs with a
      // small select_count still start.
      .transform(({ brief_count, extra_feeds, ...news }) => ({
        ...news,
        feeds: [...news.feeds, ...extra_feeds],
        brief_count: brief_count ?? Math.min(10, news.select_count),
      }))
      .refine((news) => news.brief_count <= news.select_count, {
        message: '不能大于 news.select_count',
        path: ['brief_count'],
      })
      .prefault({}),
    todo: z
      .object({
        // markdown: todo.md, managed with /add and /done. ms_todo: Microsoft To Do, read only.
        backend: z.enum(['markdown', 'ms_todo']).default('markdown'),
        file: z.string().min(1).default('todo.md'),
        // Microsoft To Do lists to read; empty means the default list.
        lists: z.array(z.string().trim().min(1)).default([]),
        // Microsoft To Do: due within this many days (or overdue) is urgent; the brief lists only those.
        // Its old name brief_days is renamed in each file before merging (load.ts).
        urgent_days: nonNegativeInt.default(3),
      })
      .prefault({}),
    microsoft: z
      .object({
        // An app registration's client id: a public client has no secret, so this is not one.
        client_id: z
          .string()
          .trim()
          .regex(
            /^$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
            '应为应用注册里的“应用程序（客户端）ID”，例如 "00000000-0000-0000-0000-000000000000"',
          )
          .default(''),
      })
      .prefault({}),
    archive: z
      .object({
        dir: z.string().min(1).default('archive'),
        retention_days: nonNegativeInt.default(90),
      })
      .prefault({}),
    monitor: z
      .object({ healthcheck_url: z.union([z.literal(''), z.url()]).default('') })
      .prefault({}),
  })
  .refine((config) => config.todo.backend !== 'ms_todo' || config.microsoft.client_id !== '', {
    message: '用 Microsoft To Do（todo.backend = "ms_todo"）时必须填写，一般写在共用配置里',
    path: ['microsoft', 'client_id'],
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
