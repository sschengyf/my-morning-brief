import type { SelectionMethod } from '#/archive/index.js';
import type { Config } from '#/infra/index.js';
import type { NewsItem } from '#/sources/index.js';

export interface NewsSelection {
  items: NewsItem[];
  method: SelectionMethod;
}

/**
 * Picks the news for today's brief without the model: drops links used in
 * recent briefs, then takes one item per source in turn (newest first within
 * a source) so a busy feed cannot crowd out the others. Stage 8 adds a
 * model-based interest filter between these steps, with this as its fallback.
 */
export function selectNews(
  candidates: NewsItem[],
  excludeLinks: Iterable<string>,
  config: Pick<Config['news'], 'select_count'>,
): NewsSelection {
  const excluded = new Set(excludeLinks);
  const bySource = new Map<string, NewsItem[]>();
  for (const item of candidates) {
    if (excluded.has(item.link)) continue;
    const queue = bySource.get(item.source) ?? [];
    queue.push(item);
    bySource.set(item.source, queue);
  }

  // Sources keep their feed order from config; undated items go last.
  const queues = [...bySource.values()].map((items) =>
    [...items].sort((a, b) => timestamp(b) - timestamp(a)),
  );

  const picked: NewsItem[] = [];
  for (let round = 0; picked.length < config.select_count; round++) {
    const row = queues.flatMap((queue) => (round < queue.length ? [queue[round]!] : []));
    if (row.length === 0) break;
    picked.push(...row.slice(0, config.select_count - picked.length));
  }
  return { items: picked, method: 'round_robin' };
}

function timestamp(item: NewsItem): number {
  return item.publishedAt ? Date.parse(item.publishedAt) : -Infinity;
}
