import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { BriefData } from '#/llm/service.js';
import type { Location } from '#/location/effective.js';
import type { NewsItem } from '#/sources/news/types.js';
import { formatFallbackBrief } from './fallback.js';

function newsItem(id: number, overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    source: 'RNZ',
    title: `Story ${id}`,
    link: `https://rnz.test/${id}`,
    publishedAt: null,
    summary: `Summary ${id}`,
    titleOnly: false,
    ...overrides,
  };
}

const HOME: Location = {
  city: 'Auckland',
  timezone: 'Pacific/Auckland',
  latitude: -36.85,
  longitude: 174.76,
  isHome: true,
};

function briefData(newsCount: number, summaryLength = 10): BriefData {
  return {
    gather: {
      now: DateTime.fromISO('2026-11-02T19:00:00Z'),
      location: HOME,
      weather: '今天：晴，12–19°C',
      calendar: '09:00-09:30 Standup',
      todos: '1. Renew passport',
    },
    news: {
      items: Array.from({ length: newsCount }, (_, i) =>
        newsItem(i + 1, { summary: 'x'.repeat(summaryLength) }),
      ),
      failures: [{ source: 'hnrss', reason: 'HTTP 500' }],
    },
  };
}

describe('formatFallbackBrief', () => {
  it('lists the raw sections and every selected news item with a link', () => {
    const data = briefData(7);
    data.gather.calendar = '09:00 Call — join at https://evil.test/zoom';
    expect(formatFallbackBrief(data)).toBe(
      [
        '⚠️ 本地模型暂时不可用，以下是原始数据',
        '2026年11月3日 星期二，现在 08:00',
        '🌤 **天气**\n今天：晴，12–19°C',
        '📅 **日程**\n09:00 Call — join at',
        '✅ **待办**\n1. Renew passport',
        '📰 **新闻**\n' +
          [1, 2, 3, 4, 5, 6, 7]
            .map((i) => `${i}. Story ${i} [原文](https://rnz.test/${i})`)
            .join('\n') +
          '\n（hnrss 获取失败：HTTP 500）',
      ].join('\n\n'),
    );
  });
});
