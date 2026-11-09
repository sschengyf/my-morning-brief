import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../../test/helpers.js';
import { dueDate, listMsTodos, pickLists } from './ms-todo.js';

const LISTS = [
  { id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' },
  { id: 'L2', displayName: 'Work', wellknownListName: 'none' },
  { id: 'L3', displayName: 'Shopping', wellknownListName: 'none' },
];

async function options(lists: string[], fetchMock: typeof fetch) {
  const tokenFile = join(await makeTempDir(), 'ms-token.json');
  await writeFile(
    tokenFile,
    JSON.stringify({ refresh_token: 'r', access_token: 'a1', expires_at: Date.now() + 3_600_000 }),
  );
  return {
    clientId: '00000000-0000-0000-0000-000000000001',
    tokenFile,
    fetch: fetchMock,
    lists,
    timezone: 'Pacific/Auckland',
  };
}

describe('pickLists', () => {
  it('takes the default list when none is configured', () => {
    expect(pickLists(LISTS, []).map((list) => list.id)).toEqual(['L1']);
  });

  it('matches configured names regardless of case and spacing, in config order', () => {
    expect(pickLists(LISTS, [' work', 'TASKS']).map((list) => list.id)).toEqual(['L2', 'L1']);
  });

  it('names the missing lists and the ones that exist', () => {
    expect(() => pickLists(LISTS, ['Work', 'Home'])).toThrow(
      '找不到列表 Home，现有列表：Tasks、Work、Shopping',
    );
  });
});

describe('dueDate', () => {
  it('lands on the right day whether To Do sends local or UTC midnight', () => {
    const local = { dateTime: '2026-11-04T11:00:00.0000000', timeZone: 'UTC' };
    const utc = { dateTime: '2026-11-05T00:00:00.0000000', timeZone: 'UTC' };
    expect(dueDate(local, 'Pacific/Auckland')).toBe('2026-11-05');
    expect(dueDate(utc, 'Pacific/Auckland')).toBe('2026-11-05');
  });

  it('falls back to the written date for a zone luxon does not know', () => {
    const windows = {
      dateTime: '2026-11-05T00:00:00.0000000',
      timeZone: 'New Zealand Standard Time',
    };
    expect(dueDate(windows, 'Pacific/Auckland')).toBe('2026-11-05');
  });
});

describe('listMsTodos', () => {
  it('reads open tasks of each list, following pages, with the token', async () => {
    const auth: string[] = [];
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const href = String(url);
      urls.push(href);
      auth.push(new Headers(init?.headers).get('Authorization') ?? '');
      if (href.endsWith('/me/todo/lists')) return Response.json({ value: LISTS });
      if (href.includes('/lists/L2/tasks') && !href.includes('page=2')) {
        return Response.json({
          value: [{ title: 'Report', importance: 'normal' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/L2/tasks?page=2',
        });
      }
      if (href.includes('page=2'))
        return Response.json({ value: [{ title: 'Slides', importance: 'high' }] });
      return Response.json({
        value: [{ title: '  Buy\nmilk ', importance: 'low' }, { title: '' }],
      });
    });
    const todos = await listMsTodos(await options(['Work', 'Tasks'], fetchMock));
    expect(todos).toEqual([
      { title: 'Report', due: null, important: false, list: 'Work' },
      { title: 'Slides', due: null, important: true, list: 'Work' },
      { title: 'Buy milk', due: null, important: false, list: 'Tasks' },
    ]);
    expect(new Set(auth)).toEqual(new Set(['Bearer a1']));
    const tasksUrl = new URL(urls.find((u) => u.includes('/lists/L1/tasks'))!);
    expect(tasksUrl.searchParams.get('$filter')).toBe("status ne 'completed'");
  });

  it('refreshes the token once when Graph rejects it', async () => {
    let graphCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      if (href.includes('login.microsoftonline.com')) {
        return Response.json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 });
      }
      graphCalls++;
      if (graphCalls === 1) return new Response('', { status: 401 });
      return href.endsWith('/me/todo/lists')
        ? Response.json({ value: LISTS })
        : Response.json({ value: [] });
    });
    expect(await listMsTodos(await options([], fetchMock))).toEqual([]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('login.')).length).toBe(1);
  });

  it('explains throttling and other errors in Chinese', async () => {
    const throttled = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    await expect(listMsTodos(await options([], throttled))).rejects.toThrow(
      'Microsoft To Do 暂时限流',
    );
    const broken = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
    await expect(listMsTodos(await options([], broken))).rejects.toThrow(
      'Microsoft To Do 返回 HTTP 503',
    );
  });
});
