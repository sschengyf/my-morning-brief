import { describe, expect, it } from 'vitest';
import type { NewsItem, NumberedNews } from '#/sources/news/types.js';
import { sanitizeOutput, stripThink, usedNewsIds } from './sanitize.js';

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

const NEWS: NumberedNews[] = [
  { ...newsItem(1), id: 'N1' },
  { ...newsItem(3), id: 'N3' },
];

describe('output cleanup', () => {
  it('removes <think> blocks', () => {
    expect(stripThink('<think>let me see</think>\n\n早上好')).toBe('早上好');
    expect(stripThink('reasoning without an opening tag</think>早上好')).toBe('早上好');
  });

  it('replaces news ids with their real links and drops unknown ids', () => {
    expect(sanitizeOutput('第一条 [N1]，第二条【N3】，编造的 [N9]', NEWS)).toBe(
      '第一条 [原文](https://rnz.test/1)，第二条[原文](https://rnz.test/3)，编造的',
    );
  });

  it('lists the known ids a brief mentions, once each', () => {
    expect(usedNewsIds('[N3] 和 [N1]，又提到【n3】，还有编造的 [N9]', NEWS)).toEqual(['N3', 'N1']);
  });

  it('removes every link the model wrote itself, keeping link text', () => {
    const text = [
      '点[这里](https://evil.test/login)领取',
      '访问 https://evil.test/a?b=c 或 <https://evil.test>',
      '也可以去 evil.com/login 或 www.phish.net',
      '![图](https://evil.test/x.png)',
      '新闻 [N1](https://evil.test)',
    ].join('\n');
    expect(sanitizeOutput(text, NEWS)).toBe(
      ['点这里领取', '访问 或', '也可以去 或', '图', '新闻 N1'].join('\n'),
    );
  });

  it('keeps ordinary text such as versions and file names', () => {
    expect(sanitizeOutput('Node.js 24 和 Postgres 19.1 发布，见 config.toml')).toBe(
      'Node.js 24 和 Postgres 19.1 发布，见 config.toml',
    );
  });
});
