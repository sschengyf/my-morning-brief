import { DateTime } from 'luxon';
import type { Archive, ArchiveRaw, BriefKind, NewsRecord } from './archive.js';
import type { Config } from './config.js';
import {
  BRIEF_PROMPT,
  FALLBACK_NEWS_COUNT,
  formatFallbackBrief,
  type BriefData,
  type LlmService,
} from './llm.js';
import { getEffectiveLocation, type Location } from './location.js';
import { logger as defaultLogger, type Logger } from './logger.js';
import { selectNews } from './newsSelect.js';
import { fetchCalendar } from './sources/calendar.js';
import type { SourceResult } from './sources/common.js';
import { gatherText, includeNews } from './sources/gather.js';
import {
  fetchNews,
  formatNews,
  numberNews,
  type NewsFetchResult,
  type NumberedNews,
} from './sources/news.js';
import { fetchTodos } from './sources/todos.js';
import { fetchWeather } from './sources/weather.js';

/** The data sources, replaceable in tests. */
export interface Sources {
  weather(location: Location, now: DateTime): Promise<SourceResult<unknown>>;
  calendar(timezone: string, now: DateTime): Promise<SourceResult<unknown>>;
  todos(): Promise<SourceResult<unknown>>;
  news(now: DateTime): Promise<NewsFetchResult>;
}

export function defaultSources(config: Config): Sources {
  return {
    weather: (location, now) => fetchWeather(location, now),
    calendar: (timezone, now) => fetchCalendar(config.calendar.ics_urls, timezone, now),
    todos: () => fetchTodos(config.todo.file),
    news: (now) =>
      fetchNews(
        config.news.feeds,
        { maxItemsPerFeed: config.news.max_items_per_feed, maxAgeHours: config.news.max_age_hours },
        now,
      ),
  };
}

export interface BriefDeps {
  config: Config;
  llm: LlmService;
  archive: Archive;
  sources?: Sources;
  logger?: Logger;
  now?: () => DateTime;
}

export interface RunBriefOptions {
  kind: BriefKind;
  /** Delivers the finished brief: Telegram, or the terminal for brief:dry. */
  send: (text: string) => Promise<void>;
  /** False for brief:dry. */
  archive: boolean;
  /** Skip the model and send the raw data; the scheduler's last resort. */
  fallback?: boolean;
}

export type BriefStatus = 'sent' | 'llm_failed' | 'send_failed';

export interface BriefRunResult {
  status: BriefStatus;
  /** Date in the effective timezone. */
  date: string;
  location: Location;
  /** The generated brief; present for send_failed so the scheduler can resend it. */
  text?: string;
  /** The gathered data (without the prompt), for brief:dry and chat context. */
  input?: string;
  /** News the brief was written from, with ids, for chat follow-ups. */
  news: NumberedNews[];
  fallback: boolean;
  sources: { weather: boolean; calendar: boolean; todos: boolean; news: boolean | null };
  archived: boolean;
  error?: unknown;
}

/**
 * The whole brief, shared by the scheduler, /brief, brief:once and brief:dry.
 * It neither retries nor updates lastBriefDate; the caller decides that.
 */
export async function runBrief(options: RunBriefOptions, deps: BriefDeps): Promise<BriefRunResult> {
  const { config, llm, archive } = deps;
  const logger = deps.logger ?? defaultLogger;
  const sources = deps.sources ?? defaultSources(config);
  const clock = deps.now ?? (() => DateTime.now());
  const now = clock();

  const location = await getEffectiveLocation(config, logger);
  const local = now.setZone(location.timezone);
  const date = local.toISODate()!;
  const withNews = includeNews(now, location, config.brief.weekend_news);

  const [weather, calendar, todos, fetched] = await Promise.all([
    sources.weather(location, now),
    sources.calendar(location.timezone, now),
    sources.todos(),
    withNews ? sources.news(now) : Promise.resolve(null),
  ]);

  let newsRecord: NewsRecord | null = null;
  let data: BriefData = {
    gather: { now, location, weather: weather.text, calendar: calendar.text, todos: todos.text },
  };
  if (fetched) {
    const recent = await archive
      .recentUsedNewsLinks(config.news.dedup_days, date)
      .catch((error: unknown) => {
        logger.warn('读取最近的归档失败，这次不做跨天去重', error);
        return new Set<string>();
      });
    const selection = selectNews(fetched.items, recent, config.news);
    data = { ...data, news: { items: selection.items, failures: fetched.failures } };
    newsRecord = {
      ok: fetched.ok,
      failures: fetched.failures,
      candidates: fetched.items,
      tooOld: fetched.tooOld,
      dedupExcluded: fetched.items.filter((item) => recent.has(item.link)).map((i) => i.link),
      method: selection.method,
      selected: [],
      usedIds: [],
    };
  }

  const base = {
    date,
    location,
    sources: {
      weather: weather.ok,
      calendar: calendar.ok,
      todos: todos.ok,
      news: fetched ? fetched.ok : null,
    },
  };

  let text: string;
  let input: string;
  /** input.txt: what the model was sent; empty for a fallback brief. */
  let modelInput: string;
  let news: NumberedNews[];
  const fallback = options.fallback ?? false;
  if (fallback) {
    text = formatFallbackBrief(data);
    news = numberNews(data.news?.items.slice(0, FALLBACK_NEWS_COUNT) ?? []);
    input = gatherText({
      ...data.gather,
      ...(data.news && { news: formatNews(news, data.news.failures) }),
    });
    modelInput = '';
    if (newsRecord) newsRecord = { ...newsRecord, selected: news, usedIds: news.map((n) => n.id) };
  } else {
    try {
      const result = await llm.writeBrief(data);
      text = result.brief;
      input = result.input;
      modelInput = `${BRIEF_PROMPT}\n\n${result.input}`;
      news = result.news;
      if (newsRecord) newsRecord = { ...newsRecord, selected: news, usedIds: result.usedIds };
    } catch (error) {
      logger.error('生成早报失败', error);
      return { ...base, status: 'llm_failed', news: [], fallback, archived: false, error };
    }
  }

  let archived = false;
  if (options.archive) {
    const raw: ArchiveRaw = {
      version: 1,
      kind: options.kind,
      generatedAt: clock().setZone(location.timezone).toISO()!,
      location: { city: location.city, timezone: location.timezone, isHome: location.isHome },
      model: config.ollama.model,
      fallback,
      sources: {
        weather: { ok: weather.ok, text: weather.text, data: weather.raw },
        calendar: { ok: calendar.ok, text: calendar.text, data: calendar.raw },
        todos: { ok: todos.ok, text: todos.text, data: todos.raw },
      },
      news: newsRecord,
    };
    try {
      const path = await archive.write({ date, raw, input: modelInput, brief: text });
      logger.info(`早报已归档：${path}`);
      archived = true;
    } catch (error) {
      // Archiving is a record, not the product: never block sending over it.
      logger.error('写归档失败，早报照常发送', error);
    }
  }

  const result = { ...base, text, input, news, fallback, archived };
  try {
    await options.send(text);
  } catch (error) {
    logger.error('发送早报失败', error);
    return { ...result, status: 'send_failed', error };
  }
  return { ...result, status: 'sent' };
}
