import { describe, expect, it } from 'vitest';
import type { NewsItem } from '#/sources/news/types.js';
import { linksToIds } from './links.js';

function item(n: number): NewsItem {
  return {
    source: 'RNZ',
    title: `Story ${n}`,
    link: `https://rnz.test/${n}`,
    publishedAt: null,
    summary: `Summary ${n}`,
    titleOnly: false,
  };
}

describe('parsing helpers', () => {
  it('turns news links back into ids', () => {
    const news = [{ ...item(2), id: 'N2' }];
    expect(linksToIds('看 [原文](https://rnz.test/2) 和 [原文](https://other.test)', news)).toBe(
      '看 [N2] 和 [原文](https://other.test)',
    );
  });
});
