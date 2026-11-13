import { describe, expect, it, vi } from 'vitest';
import { readFixture, readFixtureBytes } from '../../../test/helpers.js';
import { decode, fetchArticle, MAX_PAGE_BYTES } from './fetch.js';

const URL = 'https://www.rnz.co.nz/news/politics/1';

function page(
  body: ConstructorParameters<typeof Response>[0],
  type = 'text/html; charset=utf-8',
  status = 200,
) {
  return vi.fn<typeof fetch>(
    async () => new Response(body, { status, headers: { 'content-type': type } }),
  );
}

describe('fetchArticle', () => {
  it('reads the article text with our User-Agent', async () => {
    const fetchMock = page(await readFixture('article/news-page.html'));
    const result = await fetchArticle(URL, fetchMock);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.text).toContain('Vanessa Weenink');
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get('User-Agent')).toMatch(/^my-morning-brief/);
  });

  it('decodes a GBK page by its <meta http-equiv> or its Content-Type charset', async () => {
    const bytes = await readFixtureBytes('article/news-page-gbk.html');
    for (const type of ['text/html', 'text/html; charset=GBK']) {
      const result = await fetchArticle(URL, page(bytes, type));
      expect(result.ok && result.text).toContain('美国政府周二宣布');
    }
  });

  it('gives a reason instead of throwing', async () => {
    const reason = async (fetchMock: typeof fetch, url = URL) => {
      const result = await fetchArticle(url, fetchMock);
      return result.ok ? null : result.reason;
    };
    expect(await reason(page('', 'text/html', 403))).toBe('HTTP 403');
    expect(await reason(page('{}', 'application/json'))).toBe('不是网页');
    expect(await reason(page(await readFixture('article/teaser-page.html')))).toMatch(/^正文太短/);
    expect(await reason(page('x'), 'ftp://example.com/a')).toBe('链接不是网页');
    expect(await reason(page('x', 'text/html; charset=x-made-up'))).toBe('编码不支持');
    const timeout = vi.fn<typeof fetch>(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await reason(timeout)).toBe('请求超时');
  });

  it('stops reading a page over 2 MB, even without Content-Length', async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });
    const result = await fetchArticle(URL, page(endless));
    expect(result).toEqual({ ok: false, reason: '网页太大' });
    expect(sent).toBeLessThan(MAX_PAGE_BYTES + 256 * 1024);
  });
});

describe('decode', () => {
  const bytes = new TextEncoder().encode('<p>hi</p>');

  it('prefers the Content-Type charset, then falls back to UTF-8', () => {
    expect(decode(bytes, 'text/html; charset=utf-8')).toBe('<p>hi</p>');
    expect(decode(bytes, 'text/html')).toBe('<p>hi</p>');
  });

  it('reads a <meta charset> near the top', () => {
    const latin = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1252"><p>caf'),
      0xe9,
    ]);
    expect(decode(latin, 'text/html')).toBe('<meta charset="windows-1252"><p>café');
  });

  it('gives up on an encoding it does not know', () => {
    expect(decode(bytes, 'text/html; charset=x-made-up')).toBeNull();
  });
});
