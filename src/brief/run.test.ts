import { DateTime } from 'luxon';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, minimalRawConfig, recordingLogger } from '../../test/helpers.js';
import { Archive } from '../archive/archive.js';
import type { ArchiveRaw } from '../archive/types.js';
import { parseConfig } from '../infra/config/parse.js';
import { LlmService } from '../llm/service.js';
import type { LlmClient } from '../llm/types.js';
import type { NewsItem } from '../sources/news/types.js';
import type { Sources } from './data-sources.js';
import { type BriefDeps, runBrief } from './run.js';

// Tuesday 3 Nov 2026, 08:00 in Auckland.
const TUESDAY = DateTime.fromISO('2026-11-02T19:00:00Z');

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

function fakeSources(newsItems = [item(1), item(2)]): Sources & { newsCalls: number } {
  const sources = {
    newsCalls: 0,
    weather: async () => ({ text: '今天：晴', raw: { condition: '晴' }, ok: true }),
    calendar: async () => ({ text: '09:00-09:30 Standup', raw: { events: [] }, ok: true }),
    todos: async () => ({ text: '1. A', raw: { open: [] }, ok: true }),
    news: async () => {
      sources.newsCalls++;
      return { items: newsItems, tooOld: [], failures: [], ok: true };
    },
  };
  return sources;
}

async function setup(
  options: {
    reply?: string | Error;
    sources?: Sources;
    now?: DateTime;
    config?: Record<string, unknown>;
  } = {},
) {
  const dataDir = await makeTempDir();
  const config = parseConfig({
    ...minimalRawConfig(),
    paths: { data_dir: dataDir },
    ...options.config,
  });
  const calls: string[] = [];
  const client: LlmClient = {
    chat: async (messages) => {
      calls.push(messages.at(-1)!.content);
      if (options.reply instanceof Error) throw options.reply;
      return options.reply ?? '今天晴，看看 [N2]';
    },
  };
  const logger = recordingLogger();
  const archive = new Archive(config.archive.dir, logger);
  const deps: BriefDeps = {
    config,
    llm: new LlmService(client, config.ollama.num_ctx, logger),
    archive,
    sources: options.sources ?? fakeSources(),
    logger,
    now: () => options.now ?? TUESDAY,
  };
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => {
    sent.push(text);
  });
  return { config, deps, archive, calls, sent, send };
}

describe('runBrief', () => {
  it('gathers, writes, archives and sends the brief', async () => {
    const { deps, archive, calls, send } = await setup();
    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);

    expect(result).toMatchObject({
      status: 'sent',
      date: '2026-11-03',
      generatedAt: '2026-11-03T08:00:00.000+13:00',
      text: '今天晴，看看 [原文](https://rnz.test/2)',
      fallback: false,
      archived: true,
      sources: { weather: true, calendar: true, todos: true, news: true },
    });
    expect(send).toHaveBeenCalledWith('今天晴，看看 [原文](https://rnz.test/2)');
    expect(result.input).toBe(calls[0]);
    expect(result.input).toContain('[N1] 来源 RNZ｜Story 1｜Summary 1');
    expect(result.news.map((n) => n.id)).toEqual(['N1', 'N2']);

    const raw = await archive.readRaw('2026-11-03');
    expect(raw).toMatchObject({
      kind: 'scheduled',
      generatedAt: '2026-11-03T08:00:00.000+13:00',
      location: { city: 'Auckland', timezone: 'Pacific/Auckland', isHome: true },
      model: 'qwen3:32b',
      news: { method: 'round_robin', usedIds: ['N2'], dedupExcluded: [] },
    });
    expect(raw?.news?.selected.map((n) => n.link)).toEqual([
      'https://rnz.test/1',
      'https://rnz.test/2',
    ]);
    const input = await readFile(join(archive.dir, '2026-11-03', 'input.txt'), 'utf8');
    expect(input.startsWith('你是用户的私人助理')).toBe(true);
    expect(input).toContain(calls[0]);
  });

  it('writes nothing when archive is false', async () => {
    const { deps, archive, send } = await setup();
    const result = await runBrief({ kind: 'manual', send, archive: false }, deps);
    expect(result).toMatchObject({ status: 'sent', archived: false });
    expect(await archive.listDates()).toEqual([]);
  });

  it('skips news that a recent brief already used', async () => {
    const { deps, archive, send } = await setup({ reply: '[N1]' });
    // Yesterday's brief used Story 2.
    const yesterday = await setup({ reply: '[N2]', now: TUESDAY.minus({ days: 1 }) });
    await runBrief(
      { kind: 'scheduled', send, archive: true },
      { ...yesterday.deps, archive, now: () => TUESDAY.minus({ days: 1 }) },
    );

    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);
    expect(result.news.map((n) => n.link)).toEqual(['https://rnz.test/1']);
    expect((await archive.readRaw('2026-11-03'))?.news?.dedupExcluded).toEqual([
      'https://rnz.test/2',
    ]);
  });

  it('returns the generated brief when sending fails, for a later resend', async () => {
    const { deps, archive } = await setup();
    const send = vi.fn(async () => {
      throw new Error('Telegram down');
    });
    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);
    expect(result).toMatchObject({
      status: 'send_failed',
      text: '今天晴，看看 [原文](https://rnz.test/2)',
      archived: true,
    });
    expect((result.error as Error).message).toBe('Telegram down');
    expect(await archive.readBrief('2026-11-03')).not.toBeNull();
  });

  it('neither sends nor archives when the model fails', async () => {
    const { deps, archive, send } = await setup({ reply: new Error('Ollama down') });
    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);
    expect(result).toMatchObject({ status: 'llm_failed', archived: false });
    expect(result.text).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(await archive.listDates()).toEqual([]);
  });

  it('sends the raw data without the model when asked for a fallback', async () => {
    const { deps, calls, sent, archive } = await setup();
    const send = vi.fn(async (text: string) => void sent.push(text));
    const result = await runBrief({ kind: 'scheduled', send, archive: true, fallback: true }, deps);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: 'sent', fallback: true });
    expect(sent[0]).toMatch(/^⚠️ 本地模型暂时不可用/);
    expect(sent[0]).toContain('1. Story 1 [原文](https://rnz.test/1)');
    expect(result.input).toContain('<数据 类型="新闻">');
    const raw = (await archive.readRaw('2026-11-03')) as ArchiveRaw;
    expect(raw.fallback).toBe(true);
    expect(raw.news?.usedIds).toEqual(['N1', 'N2']);
  });

  it('does not fetch news on weekends when weekend_news is false', async () => {
    const sources = fakeSources();
    const saturday = DateTime.fromISO('2026-11-06T19:00:00Z'); // Sat 08:00 in Auckland
    const { deps, archive, send } = await setup({
      sources,
      now: saturday,
      config: { brief: { weekend_news: false } },
    });
    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);
    expect(sources.newsCalls).toBe(0);
    expect(result.sources.news).toBeNull();
    expect(result.input).not.toContain('新闻');
    expect((await archive.readRaw('2026-11-07'))?.news).toBeNull();
  });

  it('still sends when the archive cannot be written', async () => {
    const { deps, config, send } = await setup();
    await writeFile(config.archive.dir, 'a file where the archive folder should be');
    const result = await runBrief({ kind: 'scheduled', send, archive: true }, deps);
    expect(result).toMatchObject({ status: 'sent', archived: false });
    expect(send).toHaveBeenCalled();
  });

  it('uses the /city location for the date and the archive folder', async () => {
    const { deps, config, archive, send } = await setup();
    await writeFile(
      join(config.paths.data_dir, 'location.json'),
      JSON.stringify({
        city: 'Los Angeles',
        timezone: 'America/Los_Angeles',
        latitude: 34.05,
        longitude: -118.24,
      }),
    );
    // 08:00 Tuesday in Auckland is still 11:00 Monday in Los Angeles.
    const result = await runBrief({ kind: 'manual', send, archive: true }, deps);
    expect(result.date).toBe('2026-11-02');
    expect(result.input).toContain('（Los Angeles 时间）');
    expect(await readdir(archive.dir)).toEqual(['2026-11-02']);
  });
});
