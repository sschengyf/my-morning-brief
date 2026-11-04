import { describe, expect, it } from 'vitest';
import type { NewsItem } from '#/sources/news/types.js';
import { selectNews } from './select-news.js';

function item(source: string, n: number, hoursAgo: number | null = n): NewsItem {
  return {
    source,
    title: `${source} ${n}`,
    link: `https://${source.toLowerCase()}.test/${n}`,
    publishedAt:
      hoursAgo === null
        ? null
        : new Date(Date.parse('2026-11-03T00:00:00Z') - hoursAgo * 3600_000).toISOString(),
    summary: '',
    titleOnly: true,
  };
}

const titles = (items: NewsItem[]) => items.map((i) => i.title);

describe('selectNews', () => {
  it('takes one item per source in turn, newest first within each source', () => {
    const candidates = [
      item('RNZ', 2),
      item('RNZ', 1),
      item('RNZ', 3),
      item('HN', 1),
      item('BBC', 5),
    ];
    const { items, method } = selectNews(candidates, [], { select_count: 10 });
    expect(method).toBe('round_robin');
    expect(titles(items)).toEqual(['RNZ 1', 'HN 1', 'BBC 5', 'RNZ 2', 'RNZ 3']);
  });

  it('does not let a busy source fill the brief', () => {
    const rnz = Array.from({ length: 30 }, (_, i) => item('RNZ', i + 1));
    const { items } = selectNews([...rnz, item('HN', 1), item('KP', 1)], [], { select_count: 4 });
    expect(titles(items)).toEqual(['RNZ 1', 'HN 1', 'KP 1', 'RNZ 2']);
  });

  it('drops links already used in recent briefs', () => {
    const candidates = [item('RNZ', 1), item('RNZ', 2), item('HN', 1)];
    const { items } = selectNews(candidates, ['https://rnz.test/1', 'https://hn.test/1'], {
      select_count: 10,
    });
    expect(titles(items)).toEqual(['RNZ 2']);
  });

  it('returns every candidate when there are fewer than select_count', () => {
    const { items } = selectNews([item('RNZ', 1), item('HN', 1)], [], { select_count: 10 });
    expect(items).toHaveLength(2);
  });

  it('puts undated items after dated ones', () => {
    const { items } = selectNews([item('RNZ', 1, null), item('RNZ', 2, 5)], [], {
      select_count: 10,
    });
    expect(titles(items)).toEqual(['RNZ 2', 'RNZ 1']);
  });

  it('cuts the last round at select_count, keeping source order', () => {
    const { items } = selectNews([item('A', 1), item('B', 1), item('C', 1)], [], {
      select_count: 2,
    });
    expect(titles(items)).toEqual(['A 1', 'B 1']);
  });
});
