import { describeError, fetchOk } from '../common.js';
import { extractArticle } from './extract.js';

/** Bigger pages are not news articles worth waiting for. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Less text than this is a teaser, a bot check or a page that needs JavaScript. */
export const MIN_ARTICLE_CHARS = 300;

export type ArticleResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Reads a news page and extracts its text. Never throws: every failure is a
 * Chinese reason, and the caller falls back to the feed's summary.
 */
export async function fetchArticle(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ArticleResult> {
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return failed('链接不是网页');
    const response = await fetchOk(url, fetchImpl);
    const type = response.headers.get('content-type') ?? '';
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type)) return failed('不是网页');
    const bytes = await readLimited(response, MAX_PAGE_BYTES);
    if (!bytes) return failed('网页太大');
    const html = decode(bytes, type);
    if (html === null) return failed('编码不支持');
    const text = extractArticle(html);
    if (text.length < MIN_ARTICLE_CHARS) {
      return failed('正文太短，可能要登录、付费或要 JavaScript 才能显示');
    }
    return { ok: true, text };
  } catch (error) {
    return failed(describeError(error));
  }
}

function failed(reason: string): ArticleResult {
  return { ok: false, reason };
}

/** The body, or null once it passes `maxBytes`; Content-Length is often missing. */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Decodes by the Content-Type charset, then a <meta> charset near the top,
 * then UTF-8. Null for an encoding TextDecoder does not know.
 */
export function decode(bytes: Uint8Array, contentType: string): string | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const charset =
    /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return null;
  }
}
