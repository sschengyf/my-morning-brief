import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger, testConfig } from '../../../../test/helpers.js';
import { Archive } from '#/archive/archive.js';
import { LlmError } from '#/llm/types.js';
import { LlmService } from '#/llm/service.js';
import type { ChatMessage, LlmClient } from '#/llm/types.js';
import type { ArticleResult } from '#/sources/article/fetch.js';
import type { NumberedNews } from '#/sources/news/types.js';
import type { ChatIO } from '../../channel.js';
import { moreCommand, parseNewsNumber } from './more.js';

describe('parseNewsNumber', () => {
  it('reads a number with or without #, N or 第…条, in half or full width', () => {
    for (const args of ['3', '３', '#3', '＃3', 'N3', 'n3', ' 3 ', '第3条', '第 3 条', '第3则']) {
      expect(parseNewsNumber(args), args).toEqual({ number: 3, more: false });
    }
  });

  it('takes the first of several numbers and says there were more', () => {
    expect(parseNewsNumber('3 5')).toEqual({ number: 3, more: true });
    expect(parseNewsNumber('3,5')).toEqual({ number: 3, more: true });
  });

  it('leaves descriptions to the model', () => {
    for (const args of ['第三条', 'Kiwibank', '加州富人税', '2026 大选', '']) {
      expect(parseNewsNumber(args), args).toBeNull();
    }
  });
});

const news: NumberedNews[] = [1, 2, 3].map((n) => ({
  id: `N${n}`,
  source: 'RNZ',
  feed: 'https://rnz.test/rss',
  title: `Story ${n}`,
  link: `https://www.rnz.test/news/${n}`,
  publishedAt: '2026-11-11T20:00:00Z',
  summary: `Summary ${n}`,
  titleOnly: false,
}));

const ARTICLE: ArticleResult = { ok: true, text: 'Paragraph one.\nParagraph two.' };

async function setup(
  options: {
    replies?: (string | Error)[];
    article?: ArticleResult | Error;
    news?: NumberedNews[] | null;
  } = {},
) {
  const dir = await makeTempDir();
  const config = testConfig(dir);
  const logger = recordingLogger();
  const requests: ChatMessage[][] = [];
  const replies = [...(options.replies ?? ['一句话概括。\n- 要点'])];
  const client: LlmClient = {
    chat: async (messages) => {
      requests.push(messages);
      const reply = replies.shift() ?? '';
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const fetched: string[] = [];
  const deps = {
    config,
    llm: new LlmService(client, config.ollama.num_ctx, logger),
    archive: new Archive(config.archive.dir, logger),
    logger,
    fetchArticle: async (url: string) => {
      fetched.push(url);
      const article = options.article ?? ARTICLE;
      if (article instanceof Error) throw article;
      return article;
    },
  };
  const remembered: [string, string][] = [];
  const replied: string[] = [];
  /** What happened, in order: replies, typing, model requests and loading the news. */
  const events: string[] = [];
  const io: ChatIO = {
    reply: async (text) => {
      replied.push(text);
      events.push('reply');
    },
    typing: () => {
      events.push('typing');
      return () => events.push('typing stopped');
    },
  };
  const more = (args: string) =>
    moreCommand(args, io, deps, {
      news: async () => {
        events.push('news');
        return options.news === undefined ? news : options.news;
      },
      noticeIfBusy: async () => void events.push('notice'),
      remember: (question, answer) => remembered.push([question, answer]),
    });
  return { more, replied, requests, fetched, remembered, logger, events };
}

describe('moreCommand', () => {
  it('summarises the numbered story from its article, with source, title and link', async () => {
    const { more, replied, requests, fetched, remembered, logger } = await setup();
    await more('2');
    expect(fetched).toEqual(['https://www.rnz.test/news/2']);
    expect(replied).toEqual([
      '正在读原文，稍等',
      '**RNZ | Story 2**\n一句话概括。\n- 要点\n\n[原文](https://www.rnz.test/news/2)',
    ]);
    expect(requests[0]?.[1]?.content).toMatch(
      /<数据 类型="原文">\n来源：RNZ\n标题：Story 2\n[^<]*Paragraph one\./,
    );
    expect(remembered).toEqual([
      ['/more 2（Story 2）', '**RNZ | Story 2**\n一句话概括。\n- 要点\n\n[N2]'],
    ]);
    expect(logger.infos).toEqual([
      expect.stringMatching(
        /^\/more N2（RNZ，www\.rnz\.test）：读到原文 29 字，未截断，网页 .+ 秒，模型 .+ 秒$/,
      ),
    ]);
    expect(logger.infos.join()).not.toContain('/news/2');
  });

  it('falls back to the summary, saying why, when the article cannot be read', async () => {
    const { more, replied, requests, logger } = await setup({
      article: { ok: false, reason: 'HTTP 403' },
    });
    await more('1');
    expect(replied.at(-1)).toMatch(
      /^\*\*RNZ \| Story 1\*\*\n没能读到原文（HTTP 403），以下只根据摘要。\n\n一句话概括。/,
    );
    expect(requests[0]?.[1]?.content).toContain('只根据摘要写');
    expect(requests[0]?.[1]?.content).toMatch(
      /<数据 类型="摘要">\n来源：RNZ\n标题：Story 1\n[^<]*Summary 1/,
    );
    expect(logger.infos[0]).toContain('没读到原文（HTTP 403），用摘要');
  });

  it('lets the model match a description, and says when it cannot', async () => {
    const matched = await setup({ replies: ['N3', '总结'] });
    await matched.more('加州富人税');
    expect(matched.requests[0]?.[1]?.content).toContain('[N3] 来源 RNZ｜Story 3');
    expect(matched.requests[0]?.[1]?.content).toContain('<数据 类型="用户的描述">\n加州富人税');
    expect(matched.fetched).toEqual(['https://www.rnz.test/news/3']);
    expect(matched.events).toEqual([
      'typing',
      'news',
      'notice',
      'reply',
      'reply',
      'typing stopped',
    ]);
    expect(matched.logger.infos[0]).toMatch(
      /^\/more N3（按描述“加州富人税”认出；RNZ，www\.rnz\.test）：/,
    );

    for (const reply of ['无', 'N9', new LlmError('模型请求超时')]) {
      const unmatched = await setup({ replies: [reply] });
      await unmatched.more('Kiwibank');
      expect(unmatched.replied).toEqual(['没认出是哪条，用编号试试，例如 /more 3']);
      expect(unmatched.fetched).toEqual([]);
    }

    const none = await setup({ replies: ['无'] });
    await none.more('Kiwibank');
    expect(none.logger.infos).toEqual(['/more 没认出描述“Kiwibank”是哪条']);
    const empty = await setup({ news: [] });
    await empty.more('Kiwibank');
    expect(empty.replied).toEqual(['没认出是哪条，用编号试试，例如 /more 3']);
    expect(empty.requests).toEqual([]);
    const failed = await setup({ replies: [new LlmError('模型请求超时')] });
    await failed.more('Kiwibank');
    expect(failed.logger.infos).toEqual([]);
    expect(failed.logger.warnings[0]).toContain('/more 认新闻失败（描述“Kiwibank”）');
  });

  it('answers usage, unknown numbers and a missing brief without reading anything', async () => {
    const usage = await setup();
    await usage.more('  ');
    expect(usage.replied[0]).toMatch(/^用法：\/more/);
    expect(usage.events).toEqual(['reply']);
    const missing = await setup();
    await missing.more('7');
    expect(missing.replied).toEqual(['今天最近一份早报里没有第 7 条']);
    expect(missing.events).not.toContain('notice');
    const noBrief = await setup({ news: null });
    await noBrief.more('1');
    expect(noBrief.replied).toEqual(['今天的早报还没生成']);
    expect([usage, missing, noBrief].flatMap((s) => s.fetched)).toEqual([]);
  });

  it('says one at a time when several numbers were given', async () => {
    const { more, fetched, replied } = await setup();
    await more('3 5');
    expect(fetched).toEqual(['https://www.rnz.test/news/3']);
    expect(replied.at(-1)).toMatch(/（一次看一条，其他的再发 \/more）$/);
  });

  it('reports a failed summary in Chinese with the link, and remembers nothing', async () => {
    const { more, replied, remembered, logger } = await setup({
      replies: [new LlmError('模型请求超时')],
    });
    await more('2');
    expect(replied.at(-1)).toBe(
      '总结失败：模型请求超时，稍后再试\n[原文](https://www.rnz.test/news/2)',
    );
    expect(remembered).toEqual([]);
    expect(logger.warnings[0]).toContain('/more N2（RNZ，www.rnz.test）总结失败');
  });
});
