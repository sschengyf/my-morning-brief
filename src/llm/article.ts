import { type ArticleResult, type NumberedNews, wrapData } from '#/sources/index.js';
import { estimateTokens } from './tokens.js';

/**
 * The most article text the model gets: enough for a news story, and short
 * enough not to hold the shared Ollama (and others' briefs) for long.
 */
export const ARTICLE_MAX_TOKENS = 6000;

const TRUNCATED = '（原文较长，只读了前面部分）';

/** What the model matches a description against: ids, sources and titles only. */
export function formatMatchInput(news: NumberedNews[], description: string): string {
  const lines = news.map((item) => `[${item.id}] 来源 ${item.source}｜${item.title}`);
  return [wrapData('今天的新闻', lines.join('\n')), wrapData('用户的描述', description)].join(
    '\n\n',
  );
}

/** The id the model picked ("N3" → "N3"), or null for "无" or anything else. */
export function parseMatch(reply: string): string | null {
  const match = /\bN\s*(\d+)/i.exec(reply);
  return match ? `N${Number(match[1])}` : null;
}

/**
 * The model input for one story: the article text, or the feed's summary when
 * the article could not be read, cut to `maxTokens`. The source and title come
 * from the feed, so they go inside the data tags too.
 */
export function formatArticleInput(
  item: NumberedNews,
  article: ArticleResult,
  maxTokens: number,
): { input: string; truncated: boolean } {
  const header = [
    `来源：${item.source}`,
    `标题：${item.title}`,
    ...(item.publishedAt ? [`发布时间：${item.publishedAt.slice(0, 10)}`] : []),
  ].join('\n');
  if (!article.ok) {
    const summary = item.titleOnly ? '（只有标题，没有摘要）' : item.summary;
    return {
      input: `没能读到原文，下面只有摘要，只根据摘要写。\n\n${wrapData('摘要', `${header}\n\n${summary}`)}`,
      truncated: false,
    };
  }
  const { text, truncated } = truncate(article.text, maxTokens);
  return { input: wrapData('原文', `${header}\n\n${text}`), truncated };
}

function truncate(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  let cut = maxTokens > 0 ? text : '';
  while (cut !== '' && estimateTokens(cut) > maxTokens) {
    cut = cut.slice(0, Math.floor((cut.length * maxTokens) / estimateTokens(cut) / 1.05));
  }
  return { text: `${cut}\n${TRUNCATED}`, truncated: true };
}
