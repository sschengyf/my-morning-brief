import type { NumberedNews } from '#/sources/index.js';

/**
 * Turns "[原文](link)" back into "[N2]" for the conversation history, so the
 * model sees its own ids rather than links it was told never to write.
 */
export function linksToIds(text: string, news: NumberedNews[]): string {
  const ids = new Map(news.map((item) => [item.link, item.id]));
  return text.replace(/\[原文\]\(<?([^)\s>]+)>?\)/g, (whole, link: string) => {
    const id = ids.get(link);
    return id ? `[${id}]` : whole;
  });
}
