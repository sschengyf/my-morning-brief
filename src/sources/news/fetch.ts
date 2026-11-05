import type { DateTime } from 'luxon';
import Parser from 'rss-parser';
import { describeError, fetchOk, oneLine } from '../common.js';
import { cleanSummary, normalizeLink, repeatsTitle } from './clean.js';
import type { FeedFailure, FeedSource, NewsFetchResult, NewsItem, NewsOptions } from './types.js';

const parser = new Parser();

/** Fetches every feed; one failing feed never affects the others. */
export async function fetchNews(
  feeds: FeedSource[],
  options: NewsOptions,
  now: DateTime,
  fetchImpl: typeof fetch = fetch,
): Promise<NewsFetchResult> {
  const results = await Promise.allSettled(
    feeds.map((feed) => fetchFeed(feed, options.maxItemsPerFeed, fetchImpl)),
  );

  const items: NewsItem[] = [];
  const tooOld: NewsItem[] = [];
  // Blog feeds keep months-old posts; without this they would read as today's news.
  const oldest = now.minus({ hours: options.maxAgeHours }).toMillis();
  const failures: FeedFailure[] = [];
  const seenLinks = new Set<string>();
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const feed = feeds[index]!;
      failures.push({
        source: feed.name ?? feedLabel(feed.url),
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
 * llm/sanitize.ts would strip as a bare domain.
 */
export function feedLabel(url: string): string {
  const { hostname } = new URL(url);
  return hostname.split('.').find((label) => !/^(www|feeds?|rss)$/.test(label)) ?? hostname;
}

async function fetchFeed(
  { url, name }: FeedSource,
  maxItems: number,
  fetchImpl: typeof fetch,
): Promise<NewsItem[]> {
  const response = await fetchOk(url, fetchImpl);
  const feed = await parser.parseString(await response.text());
  const source = name ?? (oneLine(feed.title ?? '') || feedLabel(url));

  return feed.items.slice(0, maxItems).flatMap((entry) => {
    const title = oneLine(entry.title ?? '');
    if (!title || !entry.link) return [];

    const published = entry.isoDate ? Date.parse(entry.isoDate) : NaN;

    const cleaned = cleanSummary(entry.contentSnippet ?? entry.summary ?? entry.content ?? '');
    const summary = repeatsTitle(cleaned, title) ? '' : cleaned;
    return [
      {
        source,
        feed: url,
        title,
        link: normalizeLink(entry.link),
        publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
        summary,
        titleOnly: summary === '',
      },
    ];
  });
}
