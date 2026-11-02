import type { DateTime } from 'luxon';
import Parser from 'rss-parser';
import { describeError, fetchOk, oneLine } from './common.js';

export interface NewsItem {
  source: string;
  title: string;
  link: string;
  /** ISO date-time, or null when the feed gives none. */
  publishedAt: string | null;
  summary: string;
  /** The feed carried no usable summary (e.g. hnrss), so the model only gets the title. */
  titleOnly: boolean;
}

export interface FeedFailure {
  source: string;
  reason: string;
}

export interface NewsFetchResult {
  items: NewsItem[];
  /** Dropped for being older than max_age_hours; kept for the archive. */
  tooOld: NewsItem[];
  failures: FeedFailure[];
  /** False only when every feed failed. */
  ok: boolean;
}

export interface NewsOptions {
  maxItemsPerFeed: number;
  maxAgeHours: number;
}

const SUMMARY_LENGTH = 200;
const TRACKING_PARAMS = /^(utm_.+|at_.+|fbclid|gclid|mc_cid|mc_eid)$/i;
// hnrss puts only these in the description; they carry no news content.
const METADATA_LINE = /^\s*(Article URL|Comments URL|Points|# Comments):.*$/gim;
const BARE_URL = /https?:\/\/\S+/g;

const parser = new Parser();

/** Fetches every feed; one failing feed never affects the others. */
export async function fetchNews(
  feeds: string[],
  options: NewsOptions,
  now: DateTime,
  fetchImpl: typeof fetch = fetch,
): Promise<NewsFetchResult> {
  const results = await Promise.allSettled(
    feeds.map((url) => fetchFeed(url, options.maxItemsPerFeed, fetchImpl)),
  );

  const items: NewsItem[] = [];
  const tooOld: NewsItem[] = [];
  // Blog feeds keep months-old posts; without this they would read as today's news.
  const oldest = now.minus({ hours: options.maxAgeHours }).toMillis();
  const failures: FeedFailure[] = [];
  const seenLinks = new Set<string>();
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push({
        source: feedLabel(feeds[index]!),
        reason: describeError(result.reason),
      });
      return;
    }
    for (const item of result.value) {
      if (item.publishedAt && Date.parse(item.publishedAt) < oldest) {
        tooOld.push(item);
        continue;
      }
      if (seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);
      items.push(item);
    }
  });

  return { items, tooOld, failures, ok: feeds.length === 0 || failures.length < feeds.length };
}

/**
 * A name for a feed whose title is unknown: the main part of the host, e.g.
 * "rnz" for www.rnz.co.nz. Not the host itself, which the output cleanup in
 * llm.ts would strip as a bare domain.
 */
export function feedLabel(url: string): string {
  const { hostname } = new URL(url);
  return hostname.split('.').find((label) => !/^(www|feeds?|rss)$/.test(label)) ?? hostname;
}

async function fetchFeed(
  url: string,
  maxItems: number,
  fetchImpl: typeof fetch,
): Promise<NewsItem[]> {
  const response = await fetchOk(url, fetchImpl);
  const feed = await parser.parseString(await response.text());
  const source = oneLine(feed.title ?? '') || feedLabel(url);

  return feed.items.slice(0, maxItems).flatMap((entry) => {
    const title = oneLine(entry.title ?? '');
    if (!title || !entry.link) return [];

    const published = entry.isoDate ? Date.parse(entry.isoDate) : NaN;

    const summary = cleanSummary(entry.contentSnippet ?? entry.summary ?? entry.content ?? '');
    return [
      {
        source,
        title,
        link: normalizeLink(entry.link),
        publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
        summary,
        titleOnly: summary === '',
      },
    ];
  });
}

/** Strips HTML, hnrss metadata lines and bare URLs; truncates to SUMMARY_LENGTH characters. */
export function cleanSummary(text: string): string {
  const cleaned = oneLine(
    text
      .replace(/<[^>]*>/g, ' ')
      .replace(METADATA_LINE, ' ')
      .replace(BARE_URL, ' '),
  );
  const chars = [...cleaned];
  return chars.length > SUMMARY_LENGTH ? `${chars.slice(0, SUMMARY_LENGTH).join('')}…` : cleaned;
}

/** Removes tracking parameters and a trailing slash, so the same article dedupes across days and feeds. */
export function normalizeLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return link.trim();
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export interface NumberedNews extends NewsItem {
  id: string;
}

/** Numbers the selected news N1, N2, … The model only sees the ids; code swaps them for links. */
export function numberNews(items: NewsItem[]): NumberedNews[] {
  return items.map((item, index) => ({ ...item, id: `N${index + 1}` }));
}

export function formatNews(items: NumberedNews[], failures: FeedFailure[]): string {
  const lines = items.map(
    (item) =>
      `[${item.id}] 来源 ${item.source}｜${item.title}｜${item.titleOnly ? '（只有标题）' : item.summary}`,
  );
  if (items.length === 0 && failures.length === 0) lines.push('没有新的新闻');
  for (const failure of failures) lines.push(`（${failure.source} 获取失败：${failure.reason}）`);
  return lines.join('\n');
}
