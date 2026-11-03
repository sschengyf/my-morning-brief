import { describeError, type SourceResult } from '../common.js';
import { listTodos, type TodoItem } from './store.js';

export interface TodosRaw {
  open: TodoItem[];
}

export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return '没有未完成的待办';
  return items.map((item) => `${item.number}. ${item.text}`).join('\n');
}

export async function fetchTodos(file: string): Promise<SourceResult<TodosRaw>> {
  try {
    const open = await listTodos(file);
    return { text: formatTodos(open), raw: { open }, ok: true };
  } catch (error) {
    return { text: `（待办读取失败：${describeError(error)}）`, raw: { open: [] }, ok: false };
  }
}
