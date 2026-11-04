import { redact } from '#/infra/index.js';

/** What every data source returns; see PLAN.md stage 2. */
export interface SourceResult<Raw> {
  /** Plain text for the model. */
  text: string;
  /** Structured data for the archive. */
  raw: Raw;
  ok: boolean;
}

export const REQUEST_TIMEOUT_MS = 20_000;
export const USER_AGENT = 'my-morning-brief/0.1 (personal news reader)';

/** GETs a URL with the shared timeout and User-Agent; non-2xx responses throw `HTTP <status>`. */
export async function fetchOk(url: string | URL, fetchImpl: typeof fetch): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/**
 * A short Chinese reason for a failed fetch. It ends up in the brief and in
 * Telegram, so it is redacted: fetch errors can carry private calendar links.
 */
export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '请求超时';
  if (error instanceof Error) {
    const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    if (error.message === 'fetch failed') return code ? `网络错误（${code}）` : '网络错误';
    return redact(error.message);
  }
  return redact(String(error));
}

/** Collapses whitespace, including newlines that would break one-line formats. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
