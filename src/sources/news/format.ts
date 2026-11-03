import type { FeedFailure, NewsItem, NumberedNews } from './types.js';

/** Numbers the selected news N1, N2, … The model only sees the ids; code swaps them for links. */
export function numberNews(items: NewsItem[]): NumberedNews[] {
  return items.map((item, index) => ({ ...item, id: `N${index + 1}` }));
}

export function formatNews(items: NumberedNews[], failures: FeedFailure[]): string {
  const lines = items.map(
    (item) =>
      `[${item.id}] 来源 ${item.source}｜${item.title}｜${item.titleOnly ? '（只有标题）' : item.summary}`,
  );
  if (items.length === 0 && failures.length === 0) lines.push('没有新的新闻');
  for (const failure of failures) lines.push(`（${failure.source} 获取失败：${failure.reason}）`);
  return lines.join('\n');
}
