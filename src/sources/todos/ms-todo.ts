import { DateTime } from 'luxon';
import { REQUEST_TIMEOUT_MS, oneLine } from '../common.js';
import { accessToken, type MsAuthOptions } from './ms-auth.js';
import type { Todo } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_TASKS_PER_LIST = 100;

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
      url.searchParams.set('$top', String(MAX_TASKS_PER_LIST));
      const tasks = await graphAll<TodoTask>(options, url.toString(), MAX_TASKS_PER_LIST);
      return tasks.map((task) => toTodo(task, list.displayName, options.timezone));
    }),
  );
  return perList.flat().filter((todo) => todo.title);
}

/** The lists named in config (case and spacing aside), or the default list. */
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
  return names.map((name) => all.find((list) => key(list.displayName) === key(name))!);
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
 * To Do keeps a date, not a time, but sends it as a date-time in some zone
 * (midnight in the user's zone, or in UTC). Read in that zone and seen from
 * home, either way lands on the right day for timezones east of UTC; a zone
 * luxon does not know (Windows names) falls back to the date as written.
 */
export function dueDate(due: { dateTime: string; timeZone: string }, timezone: string): string {
  const parsed = DateTime.fromISO(due.dateTime, { zone: due.timeZone });
  return parsed.isValid ? parsed.setZone(timezone).toISODate()! : due.dateTime.slice(0, 10);
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
  const get = async (forceRefresh: boolean) =>
    (options.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${await accessToken(options, forceRefresh)}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  let response = await get(false);
  // The access token was revoked or rejected early: refresh once and retry.
  if (response.status === 401) response = await get(true);
  if (response.status === 429) throw new Error('Microsoft To Do 暂时限流，稍后再试');
  if (!response.ok) throw new Error(`Microsoft To Do 返回 HTTP ${response.status}`);
  return response.json();
}
