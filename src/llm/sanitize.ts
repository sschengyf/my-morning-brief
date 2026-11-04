import type { NumberedNews } from '#/sources/index.js';

/** Removes <think>…</think> blocks, and anything before a stray closing tag. */
export function stripThink(text: string): string {
  let result = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const strayClose = result.lastIndexOf('</think>');
  if (strayClose !== -1) result = result.slice(strayClose + '</think>'.length);
  return result.trim();
}

const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g;
const AUTOLINK = /<(?:https?|ftp|mailto|tg):[^>\s]*>/gi;
const SCHEME_URL = /\b(?:https?|ftp|tg):\/\/\S+/gi;
// Telegram also turns bare domains into links, e.g. "evil.com/login".
const BARE_DOMAIN =
  /\b(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|xyz|top|info|me|ly|gl|link|click|ru|cn|nz|uk|au)\b(?:\/\S*)?/gi;
const NEWS_ID = /[[【]\s*N(\d+)\s*[\]】]/gi;

/**
 * Makes model output safe to send. Every URL the model wrote is removed (input
 * comes from calendar invites and feeds anyone can write), and only then are
 * news ids like [N3] replaced with links from our own id → link map. Ids the
 * map does not know are dropped.
 */
export function sanitizeOutput(text: string, news: NumberedNews[] = []): string {
  const links = new Map(news.map((item) => [item.id.toUpperCase(), item.link]));
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(AUTOLINK, '')
    .replace(SCHEME_URL, '')
    .replace(BARE_DOMAIN, '')
    .replace(NEWS_ID, (_match, n: string) => {
      const link = links.get(`N${Number(n)}`);
      return link ? `[原文](${link})` : '';
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Known news ids mentioned in `text`, in order of first mention. */
export function usedNewsIds(text: string, news: NumberedNews[]): string[] {
  const known = new Set(news.map((item) => item.id));
  const ids = [...text.matchAll(NEWS_ID)].map((match) => `N${Number(match[1])}`);
  return [...new Set(ids)].filter((id) => known.has(id));
}
