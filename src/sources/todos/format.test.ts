import { describe, expect, it } from 'vitest';
import { describeDue, formatByQuadrant, formatTodos, quadrant, sortTodos } from './format.js';
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

describe('quadrant', () => {
  it('uses the star for important and urgent_days for urgent, counting the last day in', () => {
    const at = (extra: Partial<Todo>) => quadrant(todo('x', extra), '2026-11-02', 3);
    expect(at({ important: true, due: '2026-11-05' })).toBe(1);
    expect(at({ important: true, due: '2026-10-30' })).toBe(1); // overdue
    expect(at({ important: true, due: '2026-11-06' })).toBe(2); // starred but far off
    expect(at({ important: true })).toBe(2); // starred, no date
    expect(at({ due: '2026-11-02' })).toBe(3); // due today
    expect(at({ due: '2026-11-06' })).toBe(4);
    expect(at({})).toBe(4);
    expect(quadrant(todo('x', { due: '2026-11-03' }), '2026-11-02', 0)).toBe(4);
  });
});

describe('formatByQuadrant', () => {
  const todos = [
    todo('Plain'),
    todo('Pay rent', { due: '2026-11-03', important: true }),
    todo('Reply landlord', { due: '2026-11-04' }),
    todo('Learn Spanish', { important: true }),
  ];

  it('groups every quadrant under a heading, leaving out empty ones', () => {
    expect(formatByQuadrant(todos, '2026-11-02', 3)).toBe(
      [
        '🔥 重要且紧急',
        '- ⭐ Pay rent（截止 11月3日，还有 1 天）',
        '',
        '📅 重要不紧急',
        '- ⭐ Learn Spanish',
        '',
        '⚡ 紧急不重要',
        '- Reply landlord（截止 11月4日，还有 2 天）',
        '',
        '💤 其他',
        '- Plain',
      ].join('\n'),
    );
    expect(formatByQuadrant([todos[0]!], '2026-11-02', 3)).toBe('💤 其他\n- Plain');
  });

  it('keeps only the quadrants asked for, in that order', () => {
    expect(formatByQuadrant(todos, '2026-11-02', 3, [1, 3])).toBe(
      '🔥 重要且紧急\n- ⭐ Pay rent（截止 11月3日，还有 1 天）\n\n⚡ 紧急不重要\n- Reply landlord（截止 11月4日，还有 2 天）',
    );
    expect(formatByQuadrant([todos[0]!], '2026-11-02', 3, [1, 3])).toBe('');
  });

  it('names lists across groups when the todos come from several', () => {
    const mixed = [todo('A', { important: true }), todo('B', { list: 'Shopping' })];
    expect(formatByQuadrant(mixed, '2026-11-02', 3)).toBe(
      '📅 重要不紧急\n- ⭐ [Tasks] A\n\n💤 其他\n- [Shopping] B',
    );
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
