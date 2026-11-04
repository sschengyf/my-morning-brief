import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { appliesOn, parseDays, parseTime, rejectNew, sortSchedules } from './rules.js';
import type { Days, Schedule } from './types.js';

function schedule(time: string, days: Days = 'daily'): Schedule {
  return { id: `${time}-${days}`, time, days, createdAt: '2026-11-01T00:00:00.000+13:00' };
}

describe('schedule rules', () => {
  it('parses days in Chinese, defaulting to daily', () => {
    expect(parseDays(undefined)).toBe('daily');
    expect(parseDays('每天')).toBe('daily');
    expect(parseDays('工作日')).toBe('weekdays');
    expect(parseDays('周末')).toBe('weekends');
    expect(parseDays('Weekends')).toBe('weekends');
    expect(parseDays('周一')).toBeNull();
  });

  it('parses times and pads the hour', () => {
    expect(parseTime('8:05')).toBe('08:05');
    expect(parseTime('18:00')).toBe('18:00');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('8am')).toBeNull();
  });

  it('applies weekdays and weekends by the weekday of the given day', () => {
    const tuesday = DateTime.fromISO('2026-11-03', { zone: 'Pacific/Auckland' });
    const saturday = DateTime.fromISO('2026-11-07', { zone: 'Pacific/Auckland' });
    expect(appliesOn('weekdays', tuesday)).toBe(true);
    expect(appliesOn('weekends', tuesday)).toBe(false);
    expect(appliesOn('weekends', saturday)).toBe(true);
    expect(appliesOn('daily', saturday)).toBe(true);
  });

  it('sorts by time, then daily, weekdays, weekends', () => {
    const sorted = sortSchedules([
      schedule('09:00', 'weekends'),
      schedule('07:30', 'weekdays'),
      schedule('09:00'),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['07:30-weekdays', '09:00-daily', '09:00-weekends']);
  });

  it('rejects a clash on a shared day, but allows the same time on separate days', () => {
    expect(rejectNew([schedule('08:00')], '08:00', 'weekdays')).toContain(
      '同一天不能在同一时间发两份',
    );
    expect(rejectNew([schedule('08:00', 'weekdays')], '08:00', 'weekends')).toBeNull();
  });

  it('rejects schedules less than 30 minutes apart on a shared day', () => {
    expect(rejectNew([schedule('08:00')], '08:05', 'daily')).toContain('至少要隔 30 分钟');
    expect(rejectNew([schedule('08:00')], '07:31', 'weekends')).toContain('至少要隔 30 分钟');
    expect(rejectNew([schedule('08:00')], '08:30', 'daily')).toBeNull();
    expect(rejectNew([schedule('08:00', 'weekdays')], '08:10', 'weekends')).toBeNull();
  });

  it('allows at most six schedules', () => {
    const six = ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00'].map((t) => schedule(t));
    expect(rejectNew(six, '20:00', 'daily')).toBe('最多只能设 6 个定时');
  });
});
