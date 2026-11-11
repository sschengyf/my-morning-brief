import { join } from 'node:path';
import type { Config } from '#/infra/index.js';
import { describeError, type SourceResult } from '../common.js';
import { formatByQuadrant, formatTodos, isReviewDay } from './format.js';
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
  if (scope === 'all') return formatByQuadrant(todos, today, days) || '没有未完成的待办';
  return formatByQuadrant(todos, today, days, [1, 3]) || `近 ${days} 天没有要截止的待办`;
}

/**
 * The weekly review (`todo.review_day`): quadrant 2, which the daily brief
 * leaves out. Empty on other days, with nothing to review, or for todo.md.
 */
export function reviewText(config: Pick<TodoConfig, 'todo'>, todos: Todo[], today: string): string {
  const { backend, review_day, urgent_days } = config.todo;
  if (backend !== 'ms_todo' || !isReviewDay(today, review_day)) return '';
  return formatByQuadrant(todos, today, urgent_days, [2]);
}

export interface TodosResult extends SourceResult<TodosRaw> {
  /** The brief's weekly review (see `reviewText`), a section of its own; only when there is one. */
  review?: string;
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
): Promise<TodosResult> {
  try {
    const open = await readTodos(config, options);
    const text = todoText(config, open, today, scope);
    const review = scope === 'brief' ? reviewText(config, open, today) : '';
    return { text, raw: { open }, ok: true, ...(review && { review }) };
  } catch (error) {
    return { text: `（待办获取失败：${describeError(error)}）`, raw: { open: [] }, ok: false };
  }
}
