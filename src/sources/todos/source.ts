import { join } from 'node:path';
import type { Config } from '#/infra/index.js';
import { describeError, type SourceResult } from '../common.js';
import { formatByQuadrant, formatTodos } from './format.js';
import type { MsAuthOptions } from './ms-auth.js';
import { listMsTodos } from './ms-todo.js';
import { listTodos } from './store.js';
import type { Todo, TodosRaw } from './types.js';

export type TodoConfig = Pick<Config, 'todo' | 'microsoft' | 'paths'> & {
  brief: Pick<Config['brief'], 'timezone'>;
};

export interface TodoReadOptions {
  fetch?: typeof fetch;
  /** False for brief:dry, which must not write back refreshed tokens. */
  saveTokens?: boolean;
}

/** Where Microsoft tokens live, and how to reach Microsoft. */
export function msAuthOptions(config: TodoConfig, options: TodoReadOptions = {}): MsAuthOptions {
  return {
    clientId: config.microsoft.client_id,
    tokenFile: join(config.paths.data_dir, 'ms-token.json'),
    fetch: options.fetch,
    save: options.saveTokens,
  };
}

/** Open todos from the configured backend. Throws with a Chinese reason. */
export async function readTodos(
  config: TodoConfig,
  options: TodoReadOptions = {},
): Promise<Todo[]> {
  if (config.todo.backend === 'ms_todo') {
    return listMsTodos({
      ...msAuthOptions(config, options),
      lists: config.todo.lists,
      timezone: config.brief.timezone,
    });
  }
  const items = await listTodos(config.todo.file);
  return items.map(({ number, text }) => ({
    title: text,
    due: null,
    important: false,
    list: null,
    number,
  }));
}

/**
 * How todos are shown. todo.md: one numbered list. Microsoft To Do: grouped
 * by Eisenhower quadrant; the brief (`scope: 'brief'`) keeps only the urgent
 * quadrants (1 and 3), so it does not repeat later and undated todos every day.
 */
export function todoText(
  config: Pick<TodoConfig, 'todo'>,
  todos: Todo[],
  today: string,
  scope: 'brief' | 'all' = 'all',
): string {
  // todo.md has no stars or due dates: everything would land in quadrant 4.
  if (config.todo.backend !== 'ms_todo') return formatTodos(todos, today);
  const days = config.todo.urgent_days;
  const text = formatByQuadrant(todos, today, days, scope === 'brief' ? [1, 3] : undefined);
  if (text) return text;
  return scope === 'brief' ? `近 ${days} 天没有要截止的待办` : '没有未完成的待办';
}

/**
 * The todos for the brief or chat (see `todoText`); `today` (YYYY-MM-DD) is
 * in the effective timezone. The archive gets every open todo either way.
 */
export async function fetchTodos(
  config: TodoConfig,
  today: string,
  options: TodoReadOptions = {},
  scope: 'brief' | 'all' = 'all',
): Promise<SourceResult<TodosRaw>> {
  try {
    const open = await readTodos(config, options);
    return { text: todoText(config, open, today, scope), raw: { open }, ok: true };
  } catch (error) {
    return { text: `（待办获取失败：${describeError(error)}）`, raw: { open: [] }, ok: false };
  }
}
