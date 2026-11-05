import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import type { Location } from '#/location/effective.js';
import type { NewsItem, NumberedNews } from '#/sources/news/types.js';
import { BRIEF_PROMPT, SELECT_PROMPT } from './prompts.js';
import { type BriefData, estimateTokens, LlmService } from './service.js';
import type { LlmClient } from './types.js';

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
