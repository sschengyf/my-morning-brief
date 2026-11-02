import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import {
  BRIEF_PROMPT,
  estimateTokens,
  formatFallbackBrief,
  LlmService,
  OllamaClient,
  sameModel,
  sanitizeOutput,
  stripThink,
  type BriefData,
  type LlmClient,
  usedNewsIds,
} from '../src/llm.js';
import type { Location } from '../src/location.js';
import type { NewsItem, NumberedNews } from '../src/sources/news.js';
import { recordingLogger, testConfig } from './helpers.js';

const OLLAMA = testConfig('/tmp').ollama;

interface FakeOllamaOptions {
  models?: string[];
  capabilities?: string[];
  reply?: string;
}

/** A fake Ollama server that records request bodies by path. */
function fakeOllama({
  models = ['qwen3:32b'],
  capabilities = ['completion', 'tools', 'thinking'],
  reply = '早上好',
}: FakeOllamaOptions = {}) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const json = (data: unknown) => new Response(JSON.stringify(data));
    if (path === '/api/tags') return json({ models: models.map((name) => ({ name })) });
    if (path === '/api/show') return json({ capabilities });
    if (path === '/api/chat') {
      return json({ message: { role: 'assistant', content: reply }, done: true });
    }
    return new Response('not found', { status: 404 });
  });
  return { fetchMock, requests, chatBodies: () => requests.filter((r) => r.path === '/api/chat') };
}

describe('OllamaClient', () => {
  it('sends num_ctx, temperature and keep_alive, and think when the model supports it', async () => {
    const ollama = fakeOllama();
    const client = new OllamaClient(OLLAMA, ollama.fetchMock);
    expect(await client.chat([{ role: 'user', content: 'hi' }])).toBe('早上好');
    expect(ollama.chatBodies()[0]?.body).toMatchObject({
      model: 'qwen3:32b',
      stream: false,
      keep_alive: '30m',
      think: false,
      options: { temperature: 0.3, num_ctx: 16384 },
    });
  });

  it('leaves think out for models that cannot think', async () => {
    const ollama = fakeOllama({
      models: ['qwen2.5-coder:32b'],
      capabilities: ['completion', 'tools', 'insert'],
    });
    const client = new OllamaClient({ ...OLLAMA, model: 'qwen2.5-coder:32b' }, ollama.fetchMock);
    await client.chat([{ role: 'user', content: 'hi' }]);
    expect(ollama.chatBodies()[0]?.body).not.toHaveProperty('think');
  });

  it('checks the model only once', async () => {
    const ollama = fakeOllama();
    const client = new OllamaClient(OLLAMA, ollama.fetchMock);
    await client.chat([{ role: 'user', content: 'a' }]);
    await client.chat([{ role: 'user', content: 'b' }]);
    expect(ollama.requests.map((r) => r.path)).toEqual([
      '/api/tags',
      '/api/show',
      '/api/chat',
      '/api/chat',
    ]);
  });

  it('tells the user to pull a missing model', async () => {
    const client = new OllamaClient(OLLAMA, fakeOllama({ models: ['llama3:latest'] }).fetchMock);
    await expect(client.check()).rejects.toThrow('请先运行 ollama pull qwen3:32b');
  });

  it('explains when Ollama is not running', async () => {
    const refused = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    });
    const client = new OllamaClient(OLLAMA, refused);
    await expect(client.check()).rejects.toThrow(
      '无法连接 Ollama（http://localhost:11434）：网络错误（ECONNREFUSED）。请确认 Ollama 已经启动',
    );
  });

  it('reports a timeout in seconds', async () => {
    const ollama = fakeOllama();
    const slow = vi.fn<typeof fetch>(async (input, init) =>
      new URL(String(input)).pathname === '/api/chat'
        ? Promise.reject(new DOMException('timed out', 'TimeoutError'))
        : ollama.fetchMock(input, init),
    );
    const client = new OllamaClient(OLLAMA, slow);
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      '模型 600 秒内没有回复',
    );
  });
});

describe('sameModel', () => {
  it('treats a missing tag as :latest', () => {
    expect(sameModel('qwen3', 'qwen3:latest')).toBe(true);
    expect(sameModel('qwen3:32b', 'qwen3:latest')).toBe(false);
    expect(sameModel('registry.local:5000/qwen3', 'registry.local:5000/qwen3:latest')).toBe(true);
  });
});

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

describe('formatFallbackBrief', () => {
  it('lists the raw sections and the first five news with links', () => {
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
          [1, 2, 3, 4, 5].map((i) => `${i}. Story ${i} [原文](https://rnz.test/${i})`).join('\n') +
          '\n（hnrss 获取失败：HTTP 500）',
      ].join('\n\n'),
    );
  });
});
