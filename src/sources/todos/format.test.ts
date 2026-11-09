import { describe, expect, it } from 'vitest';
import { briefTodos, describeDue, formatTodos, sortTodos } from './format.js';
import type { Todo } from './types.js';

const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
  title,
  due: null,
  important: false,
  list: 'Tasks',
  ...extra,
});

describe('describeDue', () => {
  it('counts days from today', () => {
    expect(describeDue('2026-11-05', '2026-11-02')).toBe('截止 11月5日，还有 3 天');
    expect(describeDue('2026-11-02', '2026-11-02')).toBe('今天截止');
    expect(describeDue('2026-10-31', '2026-11-02')).toBe('已过期 2 天');
  });

  it('counts across a month, a year and a DST change', () => {
    expect(describeDue('2026-12-01', '2026-11-30')).toBe('截止 12月1日，还有 1 天');
    expect(describeDue('2027-01-02', '2026-12-31')).toBe('截止 2027年1月2日，还有 2 天');
    // New Zealand daylight saving starts on 27 Sep 2026; a date is still a whole day.
    expect(describeDue('2026-09-28', '2026-09-26')).toBe('截止 9月28日，还有 2 天');
  });
});

describe('briefTodos', () => {
  it('keeps overdue, today and the next few days, counting the last day in', () => {
    const todos = [
      todo('overdue', { due: '2026-10-30' }),
      todo('today', { due: '2026-11-02' }),
      todo('in 3 days', { due: '2026-11-05' }),
      todo('in 4 days', { due: '2026-11-06', important: true }),
      todo('starred, no date', { important: true }),
      todo('no date'),
    ];
    expect(briefTodos(todos, '2026-11-02', 3).map((t) => t.title)).toEqual([
      'overdue',
      'today',
      'in 3 days',
    ]);
    expect(briefTodos(todos, '2026-11-02', 0).map((t) => t.title)).toEqual(['overdue', 'today']);
  });
});

describe('sortTodos', () => {
  it('puts due ones first by date, then starred, then the rest, keeping order within each', () => {
    const todos = [
      todo('plain 1'),
      todo('starred'),
      todo('later', { due: '2026-11-09' }),
      todo('plain 2'),
      todo('overdue', { due: '2026-10-30', important: true }),
    ].map((t) => (t.title === 'starred' ? { ...t, important: true } : t));
    expect(sortTodos(todos).map((t) => t.title)).toEqual([
      'overdue',
      'later',
      'starred',
      'plain 1',
      'plain 2',
    ]);
    expect(todos[0]!.title).toBe('plain 1'); // the input is not sorted in place
  });
});

describe('formatTodos', () => {
  it('writes due dates and stars, without list names from a single list', () => {
    const text = formatTodos(
      [todo('Pay water bill', { due: '2026-11-05', important: true }), todo('Call mum')],
      '2026-11-02',
    );
    expect(text).toBe('- ⭐ Pay water bill（截止 11月5日，还有 3 天）\n- Call mum');
  });

  it('names the list when todos come from several', () => {
    const text = formatTodos([todo('A'), todo('B', { list: 'Shopping' })], '2026-11-02');
    expect(text).toBe('- [Tasks] A\n- [Shopping] B');
  });

  it('keeps the numbers /done takes for todo.md', () => {
    const items = [todo('A', { list: null, number: 1 }), todo('B', { list: null, number: 2 })];
    expect(formatTodos(items, '2026-11-02')).toBe('1. A\n2. B');
  });

  it('says when there is nothing to do', () => {
    expect(formatTodos([], '2026-11-02')).toBe('没有未完成的待办');
  });
});
