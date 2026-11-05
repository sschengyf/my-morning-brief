import { describe, expect, it } from 'vitest';
import { mergeConfig } from './merge.js';

describe('mergeConfig', () => {
  it('merges tables key by key, the personal value winning', () => {
    const shared = { news: { select_count: 40, brief_count: 10 }, archive: { retention_days: 90 } };
    const personal = { news: { brief_count: 8, interests: ['AI'] }, brief: { city: 'Wellington' } };
    expect(mergeConfig(shared, personal)).toEqual({
      news: { select_count: 40, brief_count: 8, interests: ['AI'] },
      archive: { retention_days: 90 },
      brief: { city: 'Wellington' },
    });
  });

  it('replaces arrays instead of joining them, and leaves its inputs alone', () => {
    const shared = { news: { feeds: ['https://a.test/rss', 'https://b.test/rss'] } };
    const personal = { news: { feeds: ['https://c.test/rss'] } };
    expect(mergeConfig(shared, personal)).toEqual({ news: { feeds: ['https://c.test/rss'] } });
    expect(shared.news.feeds).toHaveLength(2);
  });
});
