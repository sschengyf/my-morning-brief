import { DateTime } from 'luxon';
import type { Todo } from './types.js';

/**
 * Due ones first, by date (so overdue lead), then starred ones, then the
 * rest; each group keeps the backend's order.
 */
export function sortTodos(todos: Todo[]): Todo[] {
  const group = (todo: Todo) => (todo.due ? 0 : todo.important ? 1 : 2);
  return [...todos].sort(
    (a, b) => group(a) - group(b) || (a.due && b.due ? a.due.localeCompare(b.due) : 0),
  );
}

const day = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

/** Whole days from `today` to `due` (both YYYY-MM-DD); negative when overdue. */
function daysUntil(due: string, today: string): number {
  return Math.round(day(due).diff(day(today), 'days').days);
}

/**
 * What the brief lists: overdue, due today and due within `days`. Todos due
 * later or never stay out, so the brief does not repeat them every day.
 */
export function briefTodos(todos: Todo[], today: string, days: number): Todo[] {
  return todos.filter((todo) => todo.due !== null && daysUntil(todo.due, today) <= days);
}

/** "截止 11月5日，还有 3 天", "今天截止" or "已过期 2 天", counted from `today` (YYYY-MM-DD). */
export function describeDue(due: string, today: string): string {
  const days = daysUntil(due, today);
  if (days === 0) return '今天截止';
  if (days < 0) return `已过期 ${-days} 天`;
  const date = day(due);
  const shown =
    date.year === day(today).year ? date.toFormat('M月d日') : date.toFormat('yyyy年M月d日');
  return `截止 ${shown}，还有 ${days} 天`;
}

/**
 * One line per todo, sorted: for the model, the chat context and /todo.
 * todo.md items keep the numbers /done takes; list names are shown only when
 * the todos come from more than one list.
 */
export function formatTodos(todos: Todo[], today: string): string {
  if (todos.length === 0) return '没有未完成的待办';
  const severalLists = new Set(todos.map((todo) => todo.list)).size > 1;
  return sortTodos(todos)
    .map((todo) => {
      const bullet = todo.number === undefined ? '- ' : `${todo.number}. `;
      const star = todo.important ? '⭐ ' : '';
      const list = severalLists && todo.list ? `[${todo.list}] ` : '';
      const due = todo.due ? `（${describeDue(todo.due, today)}）` : '';
      return `${bullet}${star}${list}${todo.title}${due}`;
    })
    .join('\n');
}
