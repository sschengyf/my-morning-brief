import { describe, expect, it } from 'vitest';
import type { NewsItem, NumberedNews } from '#/sources/news/types.js';
import { sanitizeBrief, sanitizeOutput, stripThink, usedNewsIds } from './sanitize.js';

function newsItem(id: number, overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    source: 'RNZ',
    feed: 'https://rnz.test/rss',
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

describe('sanitizeBrief', () => {
  const news: NumberedNews[] = [
    { ...newsItem(1), id: 'N1', source: 'Latest stories from interest.co.nz' },
    { ...newsItem(2), id: 'N2', source: 'CNBC' },
  ];

  it('starts each news list line with its source, after the list mark', () => {
    const brief = [
      '今天有雨，最值得看的是央行加息 [N2]',
      '',
      '📰 新闻：',
      '- 国债招标结果 | 第 1016 次招标 [N1]',
      '2. 民主党拿下国会 [N2]',
      '3、没有空格的中文编号 [N2]',
      '3.5 级地震不是列表 [N2]',
    ].join('\n');
    expect(sanitizeBrief(brief, news)).toBe(
      [
        '今天有雨，最值得看的是央行加息 [原文](https://rnz.test/2)',
        '',
        '📰 新闻：',
        // The domain in the feed title stays readable but cannot become a link.
        '- Latest stories from interest．co．nz | 国债招标结果 | 第 1016 次招标 [原文](https://rnz.test/1)',
        '2. CNBC | 民主党拿下国会 [原文](https://rnz.test/2)',
        '3、CNBC | 没有空格的中文编号 [原文](https://rnz.test/2)',
        '3.5 级地震不是列表 [原文](https://rnz.test/2)',
      ].join('\n'),
    );
  });

  it('cleans links and Markdown out of a feed-controlled source', () => {
    const hostile: NumberedNews[] = [
      {
        ...newsItem(1),
        id: 'N1',
        source: '[Login](https://evil.example/x) **Big** | evil.com/login',
      },
    ];
    expect(sanitizeBrief('- 标题 [N1]', hostile)).toBe(
      '- Login Big evil．com/login | 标题 [原文](https://rnz.test/1)',
    );
  });

  it('uses the first known id’s source and leaves lines without known ids alone', () => {
    expect(sanitizeBrief('- 两条合写 [N9] [N2] [N1]\n- 编造的 [N9]', news)).toBe(
      '- CNBC | 两条合写 [原文](https://rnz.test/2) [原文](https://rnz.test/1)\n- 编造的',
    );
  });

  it('does not repeat a source the model already wrote', () => {
    expect(sanitizeBrief('- CNBC | 民主党拿下国会 [N2]', news)).toBe(
      '- CNBC | 民主党拿下国会 [原文](https://rnz.test/2)',
    );
  });

  it('still removes links the model wrote', () => {
    expect(sanitizeBrief('- 详见 evil.test.com/login 和 https://evil.test [N2]', news)).toBe(
      '- CNBC | 详见 和 [原文](https://rnz.test/2)',
    );
  });
});
