import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { cleanSummary, normalizeLink } from '../../src/sources/news/clean.js';
import { fetchNews } from '../../src/sources/news/fetch.js';
import { formatNews, numberNews } from '../../src/sources/news/format.js';

// The fixtures were captured at about 07:20 on 3 Nov 2026, Auckland time.
const CAPTURED = DateTime.fromISO('2026-11-03T07:20', { zone: 'Pacific/Auckland' });
const OPTIONS = { maxItemsPerFeed: 10, maxAgeHours: 48 };

/** Serves fixture files by feed URL; unknown URLs get a 500. */
function feedFetch(files: Record<string, string>) {
  return vi.fn<typeof fetch>(async (url) => {
    const name = files[String(url)];
    if (!name) return new Response('error', { status: 500 });
    return new Response(
      await readFile(join(import.meta.dirname, '../fixtures/news', name), 'utf8'),
    );
  });
}

function rss(items: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title>${items.join('')}</channel></rss>`;
}

describe('fetchNews', () => {
  it('reads RSS items with source, link, date and summary', async () => {
    const result = await fetchNews(
      ['https://rnz.test/rss'],
      OPTIONS,
      CAPTURED,
      feedFetch({ 'https://rnz.test/rss': 'rnz.xml' }),
    );
    expect(result.items).toHaveLength(10);
    expect(result.items[0]).toEqual({
      source: 'RNZ New Zealand Headlines',
      title:
        'Gisborne District Council unfairly criticised for forestry regulation handling - land use group',
      link: 'https://www.rnz.co.nz/news/regions_gisborne/2306247/gisborne-district-council-unfairly-criticised-for-forestry-regulation-handling-land-use-group',
      publishedAt: '2026-11-02T18:01:23.000Z',
      summary: expect.stringContaining('found no evidence of anti-forestry bias'),
      titleOnly: false,
    });
  });

  it('drops hnrss metadata and marks link-only items as title only', async () => {
    const { items } = await fetchNews(
      ['https://hn.test/rss'],
      OPTIONS,
      CAPTURED,
      feedFetch({ 'https://hn.test/rss': 'hnrss.xml' }),
    );
    const ubuntu = items.find((item) => item.title === 'WTF Ubuntu?');
    expect(ubuntu).toMatchObject({ summary: '', titleOnly: true });
    // "Ask HN" posts carry real text, which is kept without the metadata.
    const askHn = items.find((item) => item.title.startsWith('Ask HN'));
    expect(askHn?.titleOnly).toBe(false);
    for (const item of items) expect(item.summary).not.toMatch(/Comments URL|Points:|https?:/);
  });

  it('drops items older than max_age_hours, such as old blog posts', async () => {
    const files = { 'https://kp.test/feed': 'karpathy.xml' };
    // HackerTube was published 2026-10-31T17:00Z, 49 hours before the capture.
    const atCapture = await fetchNews(
      ['https://kp.test/feed'],
      OPTIONS,
      CAPTURED,
      feedFetch(files),
    );
    expect(atCapture.items).toEqual([]);
    expect(atCapture.tooOld.map((item) => item.title)).toContain('HackerTube');

    const dayEarlier = await fetchNews(
      ['https://kp.test/feed'],
      OPTIONS,
      CAPTURED.minus({ days: 1 }),
      feedFetch(files),
    );
    expect(dayEarlier.items.map((item) => item.title)).toEqual(['HackerTube']);
    expect(dayEarlier.items[0]).toMatchObject({
      source: 'karpathy',
      link: 'https://karpathy.bearblog.dev/hacker-tube',
      summary: expect.stringContaining('YouTube'),
    });
  });

  it('keeps items without a publish date', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(rss(['<item><title>Undated</title><link>https://a.test/1</link></item>'])),
    );
    const { items } = await fetchNews(['https://a.test/rss'], OPTIONS, CAPTURED, fetchMock);
    expect(items).toMatchObject([{ title: 'Undated', publishedAt: null, titleOnly: true }]);
  });

  it('takes at most max_items_per_feed from each feed', async () => {
    const { items } = await fetchNews(
      ['https://rnz.test/rss'],
      { ...OPTIONS, maxItemsPerFeed: 3 },
      CAPTURED,
      feedFetch({ 'https://rnz.test/rss': 'rnz.xml' }),
    );
    expect(items).toHaveLength(3);
  });

  it('strips tracking parameters from links (BBC adds at_medium and at_campaign)', async () => {
    const { items } = await fetchNews(
      ['https://bbc.test/rss'],
      OPTIONS,
      CAPTURED,
      feedFetch({ 'https://bbc.test/rss': 'bbc-zhongwen.xml' }),
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.link).not.toMatch(/at_medium|at_campaign|\?/);
  });

  it('keeps one copy of a link that several feeds share', async () => {
    // HN links to Karpathy's post, which his own feed also lists (with a trailing slash).
    const files = { 'https://hn.test/rss': 'hnrss.xml', 'https://kp.test/feed': 'karpathy.xml' };
    const { items } = await fetchNews(
      Object.keys(files),
      OPTIONS,
      CAPTURED.minus({ days: 1 }),
      feedFetch(files),
    );
    const copies = items.filter(
      (item) => item.link === 'https://karpathy.bearblog.dev/hacker-tube',
    );
    expect(copies).toHaveLength(1);
    expect(copies[0]?.source).toBe('Hacker News: Front Page');
  });

  it('reports a failing feed by host name while the others still work', async () => {
    const result = await fetchNews(
      ['https://rnz.test/rss', 'https://broken.test/rss'],
      OPTIONS,
      CAPTURED,
      feedFetch({ 'https://rnz.test/rss': 'rnz.xml' }),
    );
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(10);
    expect(result.failures).toEqual([{ source: 'broken', reason: 'HTTP 500' }]);
  });

  it('is not ok when every feed fails, including on unparseable XML', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('<html>not a feed'));
    const result = await fetchNews(['https://a.test/rss'], OPTIONS, CAPTURED, fetchMock);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });
});

describe('normalizeLink', () => {
  it('removes tracking parameters and trailing slashes', () => {
    expect(normalizeLink('https://Example.com/a/?utm_source=x&id=3&fbclid=y')).toBe(
      'https://example.com/a?id=3',
    );
    expect(normalizeLink('https://example.com/')).toBe('https://example.com');
    expect(normalizeLink(' not a url ')).toBe('not a url');
  });
});

describe('cleanSummary', () => {
  it('strips HTML and URLs and truncates to 200 characters', () => {
    expect(cleanSummary('<p>Hello <b>world</b></p> see https://x.test/a')).toBe('Hello world see');
    const long = cleanSummary('长'.repeat(300));
    expect([...long]).toHaveLength(201);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('formatNews', () => {
  it('writes ids, sources and summaries but never links', () => {
    const items = numberNews([
      {
        source: 'RNZ',
        title: 'Story',
        link: 'https://rnz.test/1',
        publishedAt: null,
        summary: 'Details',
        titleOnly: false,
      },
      {
        source: 'HN',
        title: 'WTF Ubuntu?',
        link: 'https://hn.test/2',
        publishedAt: null,
        summary: '',
        titleOnly: true,
      },
    ]);
    const text = formatNews(items, [{ source: 'bbc.test', reason: '请求超时' }]);
    expect(text).toBe(
      [
        '[N1] 来源 RNZ｜Story｜Details',
        '[N2] 来源 HN｜WTF Ubuntu?｜（只有标题）',
        '（bbc.test 获取失败：请求超时）',
      ].join('\n'),
    );
    expect(text).not.toContain('https://');
  });

  it('says when there is nothing new', () => {
    expect(formatNews([], [])).toBe('没有新的新闻');
  });
});
