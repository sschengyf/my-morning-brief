import { join } from 'node:path';
import type { Config } from '#/infra/index.js';
import { describeError, type SourceResult } from '../common.js';
import { briefTodos, formatTodos } from './format.js';
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
 * The todos for the brief (`scope: 'brief'`: Microsoft To Do keeps only those
 * due soon) or for chat (all of them); `today` (YYYY-MM-DD) is in the
 * effective timezone. The archive gets every open todo either way.
 */
export async function fetchTodos(
  config: TodoConfig,
  today: string,
  options: TodoReadOptions = {},
  scope: 'brief' | 'all' = 'all',
): Promise<SourceResult<TodosRaw>> {
  try {
    const open = await readTodos(config, options);
    // todo.md has no due dates yet, so filtering would leave nothing.
    if (scope === 'all' || config.todo.backend !== 'ms_todo') {
      return { text: formatTodos(open, today), raw: { open }, ok: true };
    }
    const days = config.todo.brief_days;
    const soon = briefTodos(open, today, days);
    const text = soon.length > 0 ? formatTodos(soon, today) : `近 ${days} 天没有要截止的待办`;
    return { text, raw: { open }, ok: true };
  } catch (error) {
    return { text: `（待办获取失败：${describeError(error)}）`, raw: { open: [] }, ok: false };
  }
}
