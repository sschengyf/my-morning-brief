import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import type { Location } from '#/location/effective.js';
import type { NewsItem, NumberedNews } from '#/sources/news/types.js';
import {
  ARTICLE_PROMPT,
  BRIEF_PROMPT,
  MATCH_PROMPT,
  SELECT_PROMPT,
  WEEKLY_REVIEW_PROMPT,
} from './prompts.js';
import { type BriefData, LlmService } from './service.js';
import { estimateTokens } from './tokens.js';
import type { LlmClient } from './types.js';

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

function recordingClient(reply = '早上好 [N2]') {
  const calls: Parameters<LlmClient['chat']>[0][] = [];
  const client: LlmClient = {
    chat: async (messages) => {
      calls.push(messages);
      return reply;
    },
  };
  return { client, calls };
}

describe('LlmService', () => {
  it('adds the weekly review rule to the system prompt only when there is a review', async () => {
    const plain = recordingClient('今天晴。');
    await new LlmService(plain.client, 16384).writeBrief(briefData(1));
    expect(plain.calls[0]?.[0]?.content).not.toContain('本周回顾');
    const review = recordingClient('今天晴。');
    await new LlmService(review.client, 16384).writeBrief({
      ...briefData(1),
      gather: { ...briefData(1).gather, review: '📅 重要不紧急\n- ⭐ A' },
    });
    expect(review.calls[0]?.[0]).toEqual({
      role: 'system',
      content: `${BRIEF_PROMPT}\n\n${WEEKLY_REVIEW_PROMPT}`,
    });
    expect(review.calls[0]?.[1]?.content).toContain('<数据 类型="每周回顾">\n📅 重要不紧急');
  });

  it('writes the brief from the system prompt and gathered data, linking news ids', async () => {
    const { client, calls } = recordingClient('<think>…</think>今天晴。[N2] 见 https://evil.test');
    const result = await new LlmService(client, 16384).writeBrief(briefData(3));

    expect(calls[0]?.[0]).toEqual({ role: 'system', content: BRIEF_PROMPT });
    expect(calls[0]?.[1]?.content).toBe(result.input);
    expect(result.input).toContain('[N2] 来源 RNZ｜Story 2｜xxxxxxxxxx');
    expect(result.input).toContain('（hnrss 获取失败：HTTP 500）');
    expect(result.input).not.toContain('https://');
    expect(result.brief).toBe('今天晴。[原文](https://rnz.test/2) 见');
    expect(result.news.map((item) => item.id)).toEqual(['N1', 'N2', 'N3']);
    expect(result.usedIds).toEqual(['N2']);
  });

  it('leaves out the news section when news is skipped', async () => {
    const { client } = recordingClient();
    const data = briefData(0);
    delete data.news;
    const result = await new LlmService(client, 16384).writeBrief(data);
    expect(result.input).not.toContain('新闻');
  });

  it('drops news from the end when the input would exceed 75% of num_ctx', async () => {
    const { client } = recordingClient();
    const logger = recordingLogger();
    // Each item is about 500 tokens; the prompt and other sections about 1,100.
    const result = await new LlmService(client, 4096, logger).writeBrief(briefData(10, 2000));

    expect(estimateTokens(BRIEF_PROMPT) + estimateTokens(result.input)).toBeLessThanOrEqual(3072);
    expect(result.news.length).toBeGreaterThan(0);
    expect(result.news.length).toBeLessThan(10);
    expect(result.news.at(-1)?.id).toBe(`N${result.news.length}`);
    expect(logger.warnings[0]).toMatch(/超过 num_ctx（4096）的 75%，新闻从 10 条减到 \d 条/);
  });

  it('picks news with the selection prompt and its own timeout, returning candidate numbers', async () => {
    const options: unknown[] = [];
    const calls: Parameters<LlmClient['chat']>[0][] = [];
    const client: LlmClient = {
      chat: async (messages, chatOptions) => {
        calls.push(messages);
        options.push(chatOptions);
        return '<think>…</think>C2,C1';
      },
    };
    const service = new LlmService(client, 16384);
    const picks = await service.pickNews({
      candidates: [newsItem(1), newsItem(2)],
      count: 1,
      interests: [],
      avoid: [],
      timeoutSeconds: 120,
    });

    expect(picks).toEqual([2, 1]);
    expect(options).toEqual([{ timeoutSeconds: 120 }]);
    expect(calls[0]?.[0]).toEqual({ role: 'system', content: SELECT_PROMPT });
    expect(calls[0]?.[1]?.content).toContain('[C2] 来源 RNZ｜Story 2');
    expect(calls[0]?.[1]?.content).not.toMatch(/Summary|https?:/);
  });

  it('answers with the context, history and question, cleaning the reply', async () => {
    const { client, calls } = recordingClient('看 [N1] 和 www.phish.net');
    const service = new LlmService(client, 16384);
    const reply = await service.answer(
      { text: '<数据 类型="天气">晴</数据>', news: NEWS },
      [
        { role: 'user', content: '早' },
        { role: 'assistant', content: '早上好' },
      ],
      '新闻第一条讲什么？',
    );
    expect(reply).toBe('看 [原文](https://rnz.test/1) 和');
    expect(calls[0]?.[0]?.content).toContain('<数据 类型="天气">晴</数据>');
    expect(calls[0]?.slice(1)).toEqual([
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早上好' },
      { role: 'user', content: '新闻第一条讲什么？' },
    ]);
  });

  it('runs one request at a time and reports what is running', async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    const client: LlmClient = {
      chat: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => (release = resolve));
        active--;
        return 'ok';
      },
    };
    const service = new LlmService(client, 16384);
    expect(service.isBusy()).toBe(false);

    const brief = service.writeBrief(briefData(1));
    const chat = service.answer({ text: '', news: [] }, [], 'hi');
    await vi.waitFor(() => expect(service.currentTask()).toBe('brief'));
    expect(service.isBusy()).toBe(true);

    release();
    await brief;
    await vi.waitFor(() => expect(service.currentTask()).toBe('chat'));
    release();
    await chat;

    expect(maxActive).toBe(1);
    expect(service.isBusy()).toBe(false);
    expect(service.currentTask()).toBeNull();
  });

  it('keeps the queue going after a failed request', async () => {
    let calls = 0;
    const client: LlmClient = {
      chat: async () => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
    };
    const service = new LlmService(client, 16384);
    await expect(service.answer({ text: '', news: [] }, [], 'a')).rejects.toThrow('boom');
    expect(await service.answer({ text: '', news: [] }, [], 'b')).toBe('ok');
  });
});

describe('LlmService articles', () => {
  function client(reply: string) {
    const calls: { messages: Parameters<LlmClient['chat']>[0]; timeout?: number }[] = [];
    const chat: LlmClient = {
      chat: async (messages, options) => {
        calls.push({ messages, timeout: options?.timeoutSeconds });
        return reply;
      },
    };
    return { chat, calls };
  }

  it('matches a description to an id with the selection timeout', async () => {
    const { chat, calls } = client('<think>…</think>N3');
    expect(await new LlmService(chat, 16384).matchNews(NEWS, '第三条那个', 120)).toBe('N3');
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: MATCH_PROMPT });
    expect(calls[0]?.timeout).toBe(120);
  });

  it('frames the summary with the source, title and link, and strips links the model wrote', async () => {
    const { chat, calls } = client('概括 https://evil.test 和 [点这里](https://evil.test/x)');
    const item = { ...NEWS[0]!, source: 'RNZ | **Politics**', title: 'A *bold* | title' };
    const result = await new LlmService(chat, 16384).summarizeArticle(item, {
      ok: true,
      text: 'Body.',
    });
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: ARTICLE_PROMPT });
    expect(result).toEqual({
      text: '**RNZ Politics | A bold title**\n概括 和 点这里\n\n[原文](https://rnz.test/1)',
      truncated: false,
    });
  });

  it('cuts a long article to fit and says so', async () => {
    const { chat, calls } = client('概括');
    const long = 'word '.repeat(40_000);
    const result = await new LlmService(chat, 16384).summarizeArticle(NEWS[0]!, {
      ok: true,
      text: long,
    });
    const input = calls[0]!.messages[1]!.content;
    expect(result.truncated).toBe(true);
    expect(input).toContain('（原文较长，只读了前面部分）');
    expect(estimateTokens(input)).toBeLessThanOrEqual(6100);
    // A small num_ctx cuts further.
    const small = client('概括');
    await new LlmService(small.chat, 4096).summarizeArticle(NEWS[0]!, { ok: true, text: long });
    expect(estimateTokens(small.calls[0]!.messages[1]!.content)).toBeLessThanOrEqual(3072);
  });

  it('falls back to the summary, and says so, when num_ctx leaves no room for the article', async () => {
    const { chat, calls } = client('概括');
    const result = await new LlmService(chat, 512).summarizeArticle(NEWS[0]!, {
      ok: true,
      text: 'Body.',
    });
    expect(calls[0]!.messages[1]!.content).toContain('<数据 类型="摘要">');
    expect(calls[0]!.messages[1]!.content).not.toContain('Body.');
    expect(result.text).toContain('没能读到原文（模型上下文太小），以下只根据摘要。');
  });
});
