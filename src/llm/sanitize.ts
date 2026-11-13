import { defuseDomains, stripDomains } from '#/infra/index.js';
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
    .replace(/.+/g, stripDomains)
    .replace(NEWS_ID, (_match, n: string) => {
      const link = links.get(`N${Number(n)}`);
      return link ? `[原文](${link})` : '';
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * A feed's name or title, safe to show: it comes from the feed, so links and
 * Markdown are removed, "|" would break the news line, and a domain is kept
 * readable but not linkable ("interest．co．nz") instead of being deleted.
 */
export function cleanSource(source: string): string {
  return defuseDomains(
    source
      .replace(MARKDOWN_LINK, '$1')
      .replace(AUTOLINK, '')
      .replace(SCHEME_URL, '')
      .replace(/[*_`[\]|]/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// "- ", "1. ", "1、" (often without a space); not "3.5 级地震".
const LIST_MARK = /^(\s*(?:[-*•]\s+|\d+[.)、](?!\d)\s*))/;

/**
 * sanitizeOutput for a brief, which also starts each news list line with its
 * number and source: "- 标题 | 副标题 [N3]" becomes
 * "- **3** RNZ | 标题 | 副标题 [原文](…)". The number is the id's, so /more 3
 * finds it; it is not a "3. " list, which Discord would renumber past a gap.
 * The model is told not to write the source, since it translates names it
 * should copy. Lines outside lists (the greeting citing a story) are left alone.
 */
export function sanitizeBrief(text: string, news: NumberedNews[]): string {
  const sources = new Map(news.map((item) => [item.id.toUpperCase(), cleanSource(item.source)]));
  return text
    .split('\n')
    .map((line) => {
      const clean = sanitizeOutput(line, news);
      const mark = LIST_MARK.exec(clean)?.[1];
      // The first id the map knows; a made-up one before it does not count.
      const number = [...line.matchAll(NEWS_ID)]
        .map((match) => Number(match[1]))
        .find((n) => sources.has(`N${n}`));
      if (mark === undefined || number === undefined) return clean;
      const source = sources.get(`N${number}`)!;
      let rest = clean.slice(mark.length);
      if (!source) return `- **${number}** ${rest}`;
      // The model wrote the source anyway, exactly: do not repeat it.
      if (rest.startsWith(`${source} |`)) rest = rest.slice(source.length + 2).trimStart();
      return `- **${number}** ${source} | ${rest}`;
    })
    .join('\n')
    .trim();
}

/** Known news ids mentioned in `text`, in order of first mention. */
export function usedNewsIds(text: string, news: NumberedNews[]): string[] {
  const known = new Set(news.map((item) => item.id));
  const ids = [...text.matchAll(NEWS_ID)].map((match) => `N${Number(match[1])}`);
  return [...new Set(ids)].filter((id) => known.has(id));
}
