import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { cityQueries, parseCommand, parseHistoryDate } from './parse.js';

describe('parsing helpers', () => {
  it('parses commands, with or without the bot name', () => {
    expect(parseCommand('/add@brief_bot  交水费 ')).toEqual({ name: 'add', args: '交水费' });
    expect(parseCommand('/TODO')).toEqual({ name: 'todo', args: '' });
    expect(parseCommand('今天/明天')).toBeNull();
  });

  it('reads /city arguments as a name, then a name plus country', () => {
    expect(cityQueries('Los Angeles, United States')).toEqual([
      { name: 'Los Angeles', country: 'United States' },
    ]);
    expect(cityQueries('Wellington New Zealand')).toEqual([
      { name: 'Wellington New Zealand' },
      { name: 'Wellington New', country: 'Zealand' },
      { name: 'Wellington', country: 'New Zealand' },
    ]);
  });

  it('parses history dates relative to today', () => {
    const today = DateTime.fromISO('2026-11-03', { zone: 'Pacific/Auckland' });
    expect(parseHistoryDate('昨天', today)).toBe('2026-11-02');
    expect(parseHistoryDate('前天', today)).toBe('2026-11-01');
    expect(parseHistoryDate('2026-10-30', today)).toBe('2026-10-30');
    expect(parseHistoryDate('11-02', today)).toBe('2026-11-02');
    expect(parseHistoryDate('11/2', today)).toBe('2026-11-02');
    expect(parseHistoryDate('12-25', today)).toBe('2025-12-25'); // not yet this year
    expect(parseHistoryDate('02-30', today)).toBeNull();
    expect(parseHistoryDate('last week', today)).toBeNull();
    expect(parseHistoryDate('constructor', today)).toBeNull();
  });
});
