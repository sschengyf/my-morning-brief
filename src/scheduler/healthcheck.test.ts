import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import { createHealthcheck, failUrl } from './healthcheck.js';

const URL = 'https://hc-ping.test/abc-123';

describe('createHealthcheck', () => {
  it('posts the message to the URL on success and to /fail when given up', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('OK'));
    const ping = createHealthcheck(URL, recordingLogger(), fetchMock);
    await ping('success', '08:00 每天 的定时早报已发送');
    await ping('fail', '重试用完');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [URL, 'POST', '08:00 每天 的定时早报已发送'],
      [`${URL}/fail`, 'POST', '重试用完'],
    ]);
  });

  it('sends nothing without a URL', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await createHealthcheck('', recordingLogger(), fetchMock)('success', 'x');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only warns when the request fails or the service answers with an error', async () => {
    const logger = recordingLogger();
    const down = createHealthcheck(URL, logger, async () => {
      throw new Error('timeout');
    });
    await expect(down('success', 'x')).resolves.toBeUndefined();
    const notFound = createHealthcheck(URL, logger, async () => new Response('', { status: 404 }));
    await notFound('fail', 'x');
    expect(logger.warnings).toEqual(['健康检查请求失败', '健康检查请求失败：HTTP 404']);
  });
});

describe('failUrl', () => {
  it('appends /fail to the path, with or without a trailing slash', () => {
    expect(failUrl(URL)).toBe(`${URL}/fail`);
    expect(failUrl(`${URL}/`)).toBe(`${URL}/fail`);
    expect(failUrl(`${URL}?create=1`)).toBe(`${URL}/fail?create=1`);
  });
});
