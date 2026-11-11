import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, testConfig } from '../../../test/helpers.js';
import { parseConfig } from '#/infra/config/parse.js';
import { minimalRawConfig } from '../../../test/helpers.js';
import { fetchTodos, readTodos, reviewText, todoText } from './source.js';
import type { Todo } from './types.js';

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';

async function msConfig() {
  const dataDir = await makeTempDir();
  return parseConfig({
    ...minimalRawConfig(),
    paths: { data_dir: dataDir },
    todo: { backend: 'ms_todo' },
    microsoft: { client_id: CLIENT_ID },
  });
}

describe('fetchTodos', () => {
  it('reads todo.md with the numbers /done takes', async () => {
    const config = testConfig(await makeTempDir());
    await writeFile(config.todo.file, '- [ ] A\n- [ ] B\n');
    expect(await fetchTodos(config, '2026-11-02')).toEqual({
      text: '1. A\n2. B',
      raw: {
        open: [
          { title: 'A', due: null, important: false, list: null, number: 1 },
          { title: 'B', due: null, important: false, list: null, number: 2 },
        ],
      },
      ok: true,
    });
  });

  it('reports a read failure instead of throwing', async () => {
    const dir = await makeTempDir();
    const config = { ...testConfig(dir), todo: { ...testConfig(dir).todo, file: dir } };
    const result = await fetchTodos(config, '2026-11-02');
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^（待办获取失败：/);
  });

  it('asks to log in when Microsoft To Do has no token yet, without any request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await fetchTodos(await msConfig(), '2026-11-02', { fetch: fetchMock });
    expect(result).toMatchObject({
      ok: false,
      text: '（待办获取失败：还没有登录 Microsoft To Do，在聊天里发 /todo_login）',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives the brief only the urgent quadrants from Microsoft To Do, and chat all of them', async () => {
    const config = await msConfig();
    await writeFile(
      join(config.paths.data_dir, 'ms-token.json'),
      JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 }),
    );
    const due = (date: string) => ({ dateTime: `${date}T00:00:00.0000000`, timeZone: 'UTC' });
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/me/todo/lists')
        ? Response.json({
            value: [{ id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' }],
          })
        : Response.json({
            value: [
              { title: 'Soon', dueDateTime: due('2026-11-04') },
              { title: 'Later', dueDateTime: due('2026-11-20') },
              { title: 'Someday', importance: 'high' },
            ],
          }),
    );
    const brief = await fetchTodos(config, '2026-11-02', { fetch: fetchMock }, 'brief');
    expect(brief.text).toBe('⚡ 紧急不重要\n- Soon（截止 11月4日，还有 2 天）');
    expect(brief).not.toHaveProperty('review');
    expect(brief.raw.open).toHaveLength(3); // the archive keeps them all
    const chat = await fetchTodos(config, '2026-11-02', { fetch: fetchMock });
    expect(chat.text).toBe(
      '📅 重要不紧急\n- ⭐ Someday\n\n⚡ 紧急不重要\n- Soon（截止 11月4日，还有 2 天）\n\n💤 其他\n- Later（截止 11月20日，还有 18 天）',
    );

    // 2026-11-02 is a Monday.
    const review = { ...config, todo: { ...config.todo, review_day: 'mon' as const } };
    const reviewed = await fetchTodos(review, '2026-11-02', { fetch: fetchMock }, 'brief');
    expect(reviewed.text).toBe(brief.text);
    expect(reviewed.review).toBe('📅 重要不紧急\n- ⭐ Someday');
    const chatOnReviewDay = await fetchTodos(review, '2026-11-02', { fetch: fetchMock });
    expect(chatOnReviewDay).not.toHaveProperty('review');

    const nothingSoon = { ...config, todo: { ...config.todo, urgent_days: 1 } };
    const empty = await fetchTodos(nothingSoon, '2026-11-02', { fetch: fetchMock }, 'brief');
    expect(empty.text).toBe('近 1 天没有要截止的待办');
  });

  it('does not filter todo.md for the brief, which has no due dates', async () => {
    const config = testConfig(await makeTempDir());
    await writeFile(config.todo.file, '- [ ] A\n');
    expect((await fetchTodos(config, '2026-11-02', {}, 'brief')).text).toBe('1. A');
  });

  it('reads Microsoft To Do with a stored token, dates seen from home', async () => {
    const config = await msConfig();
    await writeFile(
      join(config.paths.data_dir, 'ms-token.json'),
      JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_at: Date.now() + 3_600_000 }),
    );
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/me/todo/lists')
        ? Response.json({
            value: [{ id: 'L1', displayName: 'Tasks', wellknownListName: 'defaultList' }],
          })
        : Response.json({
            value: [
              {
                title: 'Pay water bill',
                importance: 'high',
                dueDateTime: { dateTime: '2026-11-04T11:00:00.0000000', timeZone: 'UTC' },
              },
            ],
          }),
    );
    const todos = await readTodos(config, { fetch: fetchMock });
    expect(todos).toEqual([
      { title: 'Pay water bill', due: '2026-11-05', important: true, list: 'Tasks' },
    ]);
  });
});

describe('reviewText', () => {
  const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
    title,
    due: null,
    important: false,
    list: 'Tasks',
    ...extra,
  });
  const todos = [
    todo('Plain'),
    todo('Learn Spanish', { important: true }),
    todo('Reply landlord', { due: '2026-11-09' }),
    todo('Pay rent', { due: '2026-11-10', important: true }),
  ];
  const config = (review_day: '' | 'mon' | 'sun', backend: 'ms_todo' | 'markdown' = 'ms_todo') => ({
    todo: { backend, file: 'todo.md', lists: [], urgent_days: 3, review_day },
  });
  const SUNDAY = '2026-11-08';

  it('lists the important, not urgent todos on the review day', () => {
    expect(reviewText(config('sun'), todos, SUNDAY)).toBe('📅 重要不紧急\n- ⭐ Learn Spanish');
  });

  it('is empty with nothing to review, on other days, without review_day, or for todo.md', () => {
    expect(
      reviewText(
        config('sun'),
        todos.filter((t) => t.due),
        SUNDAY,
      ),
    ).toBe('');
    expect(reviewText(config('mon'), todos, SUNDAY)).toBe('');
    expect(reviewText(config(''), todos, SUNDAY)).toBe('');
    expect(reviewText(config('sun', 'markdown'), todos, SUNDAY)).toBe('');
  });

  it('leaves the brief todos and /todo as they are on the review day', () => {
    expect(todoText(config('sun'), todos, SUNDAY, 'brief')).toBe(
      todoText(config(''), todos, SUNDAY, 'brief'),
    );
    expect(todoText(config('sun'), todos, SUNDAY, 'brief')).not.toContain('重要不紧急');
    expect(todoText(config('sun'), todos, SUNDAY)).toBe(todoText(config(''), todos, SUNDAY));
  });
});
