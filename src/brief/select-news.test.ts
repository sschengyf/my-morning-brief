import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import type { PickRequest } from '#/llm/pick-news.js';
import type { NewsItem } from '#/sources/news/types.js';
import { candidatePool, type NewsSelectConfig, resolvePicks, selectNews } from './select-news.js';

function item(source: string, n: number, hoursAgo: number | null = n): NewsItem {
  return {
    source,
    title: `${source} ${n}`,
    link: `https://${source.toLowerCase()}.test/${n}`,
    publishedAt:
      hoursAgo === null
        ? null
        : new Date(Date.parse('2026-11-03T00:00:00Z') - hoursAgo * 3600_000).toISOString(),
    summary: '',
    titleOnly: true,
  };
}

const titles = (items: NewsItem[]) => items.map((i) => i.title);

describe('candidatePool', () => {
  it('takes one item per source in turn, newest first within each source', () => {
    const candidates = [
      item('RNZ', 2),
      item('RNZ', 1),
      item('RNZ', 3),
      item('HN', 1),
      item('BBC', 5),
    ];
    expect(titles(candidatePool(candidates, [], 10))).toEqual([
      'RNZ 1',
      'HN 1',
      'BBC 5',
      'RNZ 2',
      'RNZ 3',
    ]);
  });

  it('does not let a busy source fill the brief', () => {
    const rnz = Array.from({ length: 30 }, (_, i) => item('RNZ', i + 1));
    expect(titles(candidatePool([...rnz, item('HN', 1), item('KP', 1)], [], 4))).toEqual([
      'RNZ 1',
      'HN 1',
      'KP 1',
      'RNZ 2',
    ]);
  });

  it('drops links already used in recent briefs', () => {
    const candidates = [item('RNZ', 1), item('RNZ', 2), item('HN', 1)];
    const pool = candidatePool(candidates, ['https://rnz.test/1', 'https://hn.test/1'], 10);
    expect(titles(pool)).toEqual(['RNZ 2']);
  });

  it('returns every candidate when there are fewer than the pool size', () => {
    expect(candidatePool([item('RNZ', 1), item('HN', 1)], [], 10)).toHaveLength(2);
  });

  it('puts undated items after dated ones', () => {
    expect(titles(candidatePool([item('RNZ', 1, null), item('RNZ', 2, 5)], [], 10))).toEqual([
      'RNZ 2',
      'RNZ 1',
    ]);
  });

  it('cuts the last round at the pool size, keeping source order', () => {
    expect(titles(candidatePool([item('A', 1), item('B', 1), item('C', 1)], [], 2))).toEqual([
      'A 1',
      'B 1',
    ]);
  });
});

// Sources A..F with two items each: the pool's round-robin order is A 1, B 1, …, F 1, A 2, …
const SIX_SOURCES = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((source) => [
  item(source, 1),
  item(source, 2),
]);

const CONFIG: NewsSelectConfig = {
  select_count: 12,
  brief_count: 4,
  interests: ['AI'],
  avoid: ['体育'],
  select_timeout_seconds: 120,
};

describe('resolvePicks', () => {
  const pool = candidatePool(SIX_SOURCES, [], 12);

  it('keeps the model’s order', () => {
    expect(titles(resolvePicks(pool, [8, 3, 12, 1], 4)!)).toEqual(['B 2', 'C 1', 'F 2', 'A 1']);
  });

  it('ignores unknown and repeated numbers and cuts extra ones', () => {
    expect(titles(resolvePicks(pool, [0, 3, 3, 99, 5, 1, 2, 4], 3)!)).toEqual([
      'C 1',
      'E 1',
      'A 1',
    ]);
  });

  it('tops up from the round-robin order when at least half are usable', () => {
    expect(titles(resolvePicks(pool, [5, 99, 2], 4)!)).toEqual(['E 1', 'B 1', 'A 1', 'C 1']);
  });

  it('fails when fewer than half are usable', () => {
    expect(resolvePicks(pool, [5, 99], 4)).toBeNull();
    expect(resolvePicks(pool, [], 4)).toBeNull();
  });
});

describe('selectNews', () => {
  it('asks the model to pick from the pool, by title, with the configured limits', async () => {
    const pick = vi.fn(async (_request: PickRequest) => [7, 2, 11, 4]);
    const selection = await selectNews(SIX_SOURCES, [], CONFIG, pick, recordingLogger());
    expect(selection.method).toBe('model');
    expect(selection.poolSize).toBe(12);
    expect(titles(selection.items)).toEqual(['A 2', 'B 1', 'E 2', 'D 1']);
    expect(pick).toHaveBeenCalledWith({
      candidates: candidatePool(SIX_SOURCES, [], 12),
      count: 4,
      interests: ['AI'],
      avoid: ['体育'],
      timeoutSeconds: 120,
    });
  });

  it('asks the model even when interests and avoid are empty', async () => {
    const pick = vi.fn(async () => [1, 2, 3, 4]);
    const config = { ...CONFIG, interests: [], avoid: [] };
    const selection = await selectNews(SIX_SOURCES, [], config, pick, recordingLogger());
    expect(pick).toHaveBeenCalledOnce();
    expect(selection.method).toBe('model');
  });

  it('does not ask the model when the pool is no bigger than brief_count', async () => {
    const pick = vi.fn(async () => [1]);
    const candidates = [item('A', 1), item('B', 1), item('C', 1), item('D', 1)];
    const selection = await selectNews(candidates, [], CONFIG, pick, recordingLogger());
    expect(pick).not.toHaveBeenCalled();
    expect(selection).toMatchObject({ method: 'round_robin', poolSize: 4 });
    expect(selection.items).toHaveLength(4);
  });

  it('takes the first round-robin items without the model when pick is null', async () => {
    const selection = await selectNews(SIX_SOURCES, [], CONFIG, null, recordingLogger());
    expect(selection.method).toBe('round_robin');
    expect(titles(selection.items)).toEqual(['A 1', 'B 1', 'C 1', 'D 1']);
  });

  it('falls back to round robin when the model fails', async () => {
    const logger = recordingLogger();
    const pick = vi.fn(async () => {
      throw new Error('模型 120 秒内没有回复');
    });
    const selection = await selectNews(SIX_SOURCES, [], CONFIG, pick, logger);
    expect(selection.method).toBe('round_robin_fallback');
    expect(titles(selection.items)).toEqual(['A 1', 'B 1', 'C 1', 'D 1']);
    expect(logger.warnings).toEqual(['模型挑选新闻失败，改为按源轮流']);
  });

  it('falls back to round robin when too few picks are usable', async () => {
    const logger = recordingLogger();
    const selection = await selectNews(SIX_SOURCES, [], CONFIG, async () => [99], logger);
    expect(selection.method).toBe('round_robin_fallback');
    expect(selection.items).toHaveLength(4);
    expect(logger.warnings).toEqual(['模型挑选的新闻编号无效（99），改为按源轮流']);
  });
});
