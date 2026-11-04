import { describe, expect, it } from 'vitest';
import { formatNews, numberNews } from './format.js';

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
