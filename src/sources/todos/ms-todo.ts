import { DateTime } from 'luxon';
import { REQUEST_TIMEOUT_MS, oneLine } from '../common.js';
import { accessToken, type MsAuthOptions } from './ms-auth.js';
import type { Todo } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 100;
// The brief filters by due date afterwards, so a cut-off must be far above any real list.
const MAX_TASKS_PER_LIST = 1000;

export interface MsTodoOptions extends MsAuthOptions {
  /** List names to read; empty means the default list. */
  lists: string[];
  /** Home timezone, for reading due dates. */
  timezone: string;
}

interface TodoList {
  id: string;
  displayName: string;
  wellknownListName?: string;
}

interface TodoTask {
  title?: string;
  importance?: string;
  dueDateTime?: { dateTime: string; timeZone: string };
}

/** Open tasks of the configured lists, in To Do's order. Throws with a Chinese reason. */
export async function listMsTodos(options: MsTodoOptions): Promise<Todo[]> {
  const lists = pickLists(
    await graphAll<TodoList>(options, `${GRAPH}/me/todo/lists`),
    options.lists,
  );
  const perList = await Promise.all(
    lists.map(async (list) => {
      const url = new URL(`${GRAPH}/me/todo/lists/${encodeURIComponent(list.id)}/tasks`);
      url.searchParams.set('$filter', "status ne 'completed'");
      url.searchParams.set('$top', String(PAGE_SIZE));
      const tasks = await graphAll<TodoTask>(options, url.toString(), MAX_TASKS_PER_LIST);
      return tasks.map((task) => toTodo(task, list.displayName, options.timezone));
    }),
  );
  return perList.flat().filter((todo) => todo.title);
}

/** The lists named in config (case and spacing aside, each once), or the default list. */
export function pickLists(all: TodoList[], names: string[]): TodoList[] {
  if (names.length === 0) {
    const fallback = all.find((list) => list.wellknownListName === 'defaultList') ?? all[0];
    return fallback ? [fallback] : [];
  }
  const key = (name: string) => name.trim().toLowerCase();
  const missing = names.filter((name) => !all.some((list) => key(list.displayName) === key(name)));
  if (missing.length > 0) {
    throw new Error(
      `找不到列表 ${missing.join('、')}，现有列表：${all.map((list) => list.displayName).join('、')}`,
    );
  }
  const lists = names.map((name) => all.find((list) => key(list.displayName) === key(name))!);
  return [...new Set(lists)];
}

export function toTodo(task: TodoTask, list: string, timezone: string): Todo {
  return {
    title: oneLine(task.title ?? ''),
    due: task.dueDateTime ? dueDate(task.dueDateTime, timezone) : null,
    important: task.importance === 'high',
    list,
  };
}

/**
 * To Do keeps a date, not a time, but sends it as a date-time: midnight in
 * that zone (the date as written), or the user's local midnight converted to
 * UTC (Auckland's 5 Nov arrives as 4 Nov 11:00 UTC). Midnight is taken as
 * written; anything else is seen from home, which is right on either side of
 * UTC. A zone luxon does not know (Windows names) falls back to the date as
 * written.
 */
export function dueDate(due: { dateTime: string; timeZone: string }, timezone: string): string {
  const written = due.dateTime.slice(0, 10);
  if (due.dateTime.slice(11, 19) === '00:00:00') return written;
  const parsed = DateTime.fromISO(due.dateTime, { zone: due.timeZone });
  return parsed.isValid ? parsed.setZone(timezone).toISODate()! : written;
}

/** GETs every page of a Graph collection, up to `limit` items. */
async function graphAll<T>(options: MsTodoOptions, url: string, limit = Infinity): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined = url;
  while (next && items.length < limit) {
    const page = (await graphGet(options, next)) as { value?: T[]; '@odata.nextLink'?: string };
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items.slice(0, limit);
}

async function graphGet(options: MsTodoOptions, url: string): Promise<unknown> {
  const get = (token: string) =>
    (options.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const token = await accessToken(options);
  let response = await get(token);
  // The access token was revoked or rejected early: refresh once and retry.
  if (response.status === 401) response = await get(await accessToken(options, token));
  if (response.status === 429) throw new Error('Microsoft To Do 暂时限流，稍后再试');
  if (!response.ok) throw new Error(`Microsoft To Do 返回 HTTP ${response.status}`);
  return response.json();
}
