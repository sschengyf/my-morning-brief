import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { Days, Schedule } from './types.js';
import { dueSchedule, nextOccurrence, windowsOn, type DueInput } from './windows.js';

const AKL = 'Pacific/Auckland';
const CREATED = '2026-09-01T00:00:00.000+12:00';

function schedule(id: string, time: string, days: Days = 'daily', createdAt = CREATED): Schedule {
  return { id, time, days, createdAt };
}

/** A time in Auckland, e.g. local('2026-11-03T08:30'). */
function local(iso: string, zone = AKL): DateTime {
  return DateTime.fromISO(iso, { zone });
}

function due(overrides: Partial<DueInput> & { now: DateTime }) {
  const result = dueSchedule({
    timezone: AKL,
    schedules: [schedule('morning', '08:00')],
    catchUpHours: 4,
    sent: {},
    retryAt: {},
    ...overrides,
  });
  return result && `${result.schedule.id}@${result.date}`;
}

describe('windowsOn', () => {
  it('closes each window after catch_up_hours, at the next schedule, or at midnight', () => {
    const windows = windowsOn(
      local('2026-11-03T12:00'),
      [schedule('a', '08:00'), schedule('b', '10:00'), schedule('c', '22:00')],
      4,
    );
    expect(
      windows.map((w) => [w.schedule.id, w.start.toFormat('HH:mm'), w.end.toFormat('MM-dd HH:mm')]),
    ).toEqual([
      ['a', '08:00', '11-03 10:00'],
      ['b', '10:00', '11-03 14:00'],
      ['c', '22:00', '11-04 00:00'],
    ]);
  });

  it('is not cut short by a schedule that does not apply that day', () => {
    const tuesday = windowsOn(
      local('2026-11-03T12:00'),
      [schedule('weekday', '07:30', 'weekdays'), schedule('weekend', '09:00', 'weekends')],
      4,
    );
    expect(tuesday.map((w) => [w.schedule.id, w.end.toFormat('HH:mm')])).toEqual([
      ['weekday', '11:30'],
    ]);
  });
});

describe('dueSchedule', () => {
  it.each([
    ['before the time', '2026-11-03T07:59', null],
    ['at the time', '2026-11-03T08:00', 'morning@2026-11-03'],
    ['catching up after sleeping through it', '2026-11-03T11:59', 'morning@2026-11-03'],
    ['after catch_up_hours', '2026-11-03T12:00', null],
  ])('%s', (_label, now, expected) => {
    expect(due({ now: local(now) })).toBe(expected);
  });

  it('sends once a day', () => {
    expect(due({ now: local('2026-11-03T09:00'), sent: { morning: '2026-11-03' } })).toBeNull();
    // After midnight the date is new again.
    expect(due({ now: local('2026-11-04T08:00'), sent: { morning: '2026-11-03' } })).toBe(
      'morning@2026-11-04',
    );
  });

  it('after sleeping through two schedules, sends only the latest', () => {
    const schedules = [schedule('a', '08:00'), schedule('b', '10:00')];
    expect(due({ now: local('2026-11-03T10:30'), schedules })).toBe('b@2026-11-03');
  });

  it('never runs a window past midnight', () => {
    const schedules = [schedule('late', '22:00')];
    expect(due({ now: local('2026-11-03T23:59'), schedules })).toBe('late@2026-11-03');
    expect(due({ now: local('2026-11-04T00:30'), schedules })).toBeNull();
  });

  it('follows weekdays and weekends in the effective timezone', () => {
    const schedules = [
      schedule('weekday', '07:30', 'weekdays'),
      schedule('weekend', '09:00', 'weekends'),
    ];
    expect(due({ now: local('2026-11-06T07:45'), schedules })).toBe('weekday@2026-11-06'); // Friday
    expect(due({ now: local('2026-11-07T07:45'), schedules })).toBeNull(); // Saturday
    expect(due({ now: local('2026-11-07T09:15'), schedules })).toBe('weekend@2026-11-07');
    // 09:15 Saturday in Auckland is still Friday 20:15 in Shanghai.
    expect(
      due({ now: local('2026-11-07T09:15'), schedules, timezone: 'Asia/Shanghai' }),
    ).toBeNull();
  });

  it('does not send a schedule added after its time today', () => {
    const added = schedule('new', '08:00', 'daily', '2026-11-03T10:30:00.000+13:00');
    expect(due({ now: local('2026-11-03T10:31'), schedules: [added] })).toBeNull();
    expect(due({ now: local('2026-11-04T08:00'), schedules: [added] })).toBe('new@2026-11-04');
  });

  it('waits for a pending retry', () => {
    const retryAt = { morning: local('2026-11-03T08:05').toISO()! };
    expect(due({ now: local('2026-11-03T08:02'), retryAt })).toBeNull();
    expect(due({ now: local('2026-11-03T08:05'), retryAt })).toBe('morning@2026-11-03');
  });

  it('sends at 08:00 Shanghai time after /city Shanghai (13:00 in Auckland)', () => {
    const now = local('2026-11-03T13:00');
    expect(due({ now, timezone: 'Asia/Shanghai' })).toBe('morning@2026-11-03');
  });

  it('does not repeat after moving west into a day already sent', () => {
    // Sent at 08:00 Tuesday in Auckland; then /city Los Angeles, where it is still Monday 11:00.
    const now = local('2026-11-03T08:30');
    const sent = { morning: '2026-11-02' };
    expect(due({ now, timezone: 'America/Los_Angeles', sent })).toBeNull(); // 11:30 Monday: past the window
    expect(due({ now: local('2026-11-03T08:30'), sent: { morning: '2026-11-03' } })).toBeNull();
  });

  it('sends normally after moving back east into a new day', () => {
    // Last sent Monday in Los Angeles; back home it is already Wednesday 08:00.
    expect(due({ now: local('2026-11-04T08:00'), sent: { morning: '2026-11-02' } })).toBe(
      'morning@2026-11-04',
    );
  });

  it('handles the day DST starts in Auckland (02:00 jumps to 03:00 on 27 Sep 2026)', () => {
    const early = [schedule('early', '02:30')];
    // 02:30 does not exist that day; luxon moves it to 03:30.
    expect(due({ now: local('2026-09-27T03:30'), schedules: early })).toBe('early@2026-09-27');
    expect(due({ now: local('2026-09-27T08:00') })).toBe('morning@2026-09-27');
  });

  it('sends nothing when there are no schedules', () => {
    expect(due({ now: local('2026-11-03T08:00'), schedules: [] })).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('finds the next schedule that applies, skipping days it does not', () => {
    const schedules = [
      schedule('weekday', '07:30', 'weekdays'),
      schedule('weekend', '09:00', 'weekends'),
    ];
    const friday = nextOccurrence(local('2026-11-06T08:00'), AKL, schedules);
    expect(friday?.schedule.id).toBe('weekend');
    expect(friday?.at.toISO()).toBe('2026-11-07T09:00:00.000+13:00');
  });

  it('is null without schedules', () => {
    expect(nextOccurrence(local('2026-11-06T08:00'), AKL, [])).toBeNull();
  });
});
