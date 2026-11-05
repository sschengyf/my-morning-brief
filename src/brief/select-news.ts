import type { SelectionMethod } from '#/archive/index.js';
import type { Config, Logger } from '#/infra/index.js';
import type { PickRequest } from '#/llm/index.js';
import type { NewsItem } from '#/sources/index.js';

export interface NewsSelection {
  items: NewsItem[];
  method: SelectionMethod;
  /** How many round-robin candidates the selection chose from. */
  poolSize: number;
}

export type NewsSelectConfig = Pick<
  Config['news'],
  'select_count' | 'brief_count' | 'interests' | 'avoid' | 'select_timeout_seconds'
>;

/** Asks the model for candidate numbers; LlmService.pickNews, or null to skip the model. */
export type PickNews = ((request: PickRequest) => Promise<number[]>) | null;

/**
 * Picks the news for today's brief: drops links used in recent briefs, takes a
 * pool of candidates by source in turn, then lets the model choose brief_count
 * of them by title. Picking happens here, not while writing the brief, because
 * the model favours the first items when it picks and writes at once.
 */
export async function selectNews(
  candidates: NewsItem[],
  excludeLinks: Iterable<string>,
  config: NewsSelectConfig,
  pick: PickNews,
  logger: Logger,
): Promise<NewsSelection> {
  const pool = candidatePool(candidates, excludeLinks, config.select_count);
  const count = config.brief_count;
  const firstInTurn = { items: pool.slice(0, count), poolSize: pool.length };
  if (pool.length <= count || !pick) return { ...firstInTurn, method: 'round_robin' };

  try {
    const picks = await pick({
      candidates: pool,
      count,
      interests: config.interests,
      avoid: config.avoid,
      timeoutSeconds: config.select_timeout_seconds,
    });
    const items = resolvePicks(pool, picks, count);
    if (items) {
      logger.info(`模型从 ${pool.length} 条候选里挑了：${picks.map((n) => `C${n}`).join(',')}`);
      return { items, method: 'model', poolSize: pool.length };
    }
    logger.warn(`模型挑选的新闻编号无效（${picks.join(',') || '没有编号'}），改为按源轮流`);
  } catch (error) {
    logger.warn('模型挑选新闻失败，改为按源轮流', error);
  }
  return { ...firstInTurn, method: 'round_robin_fallback' };
}

/**
 * Turns the model's candidate numbers (1-based) into items: unknown and repeated
 * numbers are ignored, extra ones cut. Null when fewer than half of `count` are
 * usable; otherwise topped up from the pool's round-robin order.
 */
export function resolvePicks(pool: NewsItem[], picks: number[], count: number): NewsItem[] | null {
  const chosen = [...new Set(picks)]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= pool.length)
    .slice(0, count);
  if (chosen.length * 2 < count) return null;
  const items = chosen.map((n) => pool[n - 1]!);
  const rest = pool.filter((item) => !items.includes(item));
  return [...items, ...rest.slice(0, count - items.length)];
}

/**
 * Up to `size` candidates without the model: drops links used in recent
 * briefs, then takes one item per source in turn (newest first within a
 * source) so a busy feed cannot crowd out the others.
 */
export function candidatePool(
  candidates: NewsItem[],
  excludeLinks: Iterable<string>,
  size: number,
): NewsItem[] {
  const excluded = new Set(excludeLinks);
  // By feed, not by the name shown: several feeds may share a name (SCMP sections).
  const byFeed = new Map<string, NewsItem[]>();
  for (const item of candidates) {
    if (excluded.has(item.link)) continue;
    const queue = byFeed.get(item.feed) ?? [];
    queue.push(item);
    byFeed.set(item.feed, queue);
  }

  // Feeds keep their order from config; undated items go last.
  const queues = [...byFeed.values()].map((items) =>
    [...items].sort((a, b) => timestamp(b) - timestamp(a)),
  );

  const picked: NewsItem[] = [];
  for (let round = 0; picked.length < size; round++) {
    const row = queues.flatMap((queue) => (round < queue.length ? [queue[round]!] : []));
    if (row.length === 0) break;
    picked.push(...row.slice(0, size - picked.length));
  }
  return picked;
}

function timestamp(item: NewsItem): number {
  return item.publishedAt ? Date.parse(item.publishedAt) : -Infinity;
}
