import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../test/helpers.js';
import { OllamaClient, sameModel } from './ollama.js';

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
