import { DateTime } from 'luxon';
import { appliesOn, sortSchedules } from './rules.js';
import type { Schedule } from './types.js';

export interface ScheduleWindow {
  schedule: Schedule;
  /** ISO date in the effective timezone. */
  date: string;
  start: DateTime;
  /** Exclusive. */
  end: DateTime;
}

function at(day: DateTime, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/**
 * The send windows of `day` (any time on it, in the effective timezone): each
 * schedule that applies that day, from its time for `catchUpHours`, but never
 * past the next schedule of that day or past midnight. So at most one window
 * is open at any moment.
 */
export function windowsOn(
  day: DateTime,
  schedules: Schedule[],
  catchUpHours: number,
): ScheduleWindow[] {
  const start = day.startOf('day');
  const midnight = start.plus({ days: 1 });
  const today = sortSchedules(schedules).filter((s) => appliesOn(s.days, start));
  return today.map((schedule, index) => {
    const opens = at(start, schedule.time);
    const next = today[index + 1];
    const limits = [opens.plus({ minutes: Math.round(catchUpHours * 60) }), midnight];
    if (next) limits.push(at(start, next.time));
    return {
      schedule,
      date: start.toISODate()!,
      start: opens,
      end: DateTime.min(...limits)!,
    };
  });
}

export interface DueInput {
  now: DateTime;
  timezone: string;
  schedules: Schedule[];
  catchUpHours: number;
  /** Schedule id → last date (in the effective timezone) it was sent. */
  sent: Record<string, string>;
  /** Schedule id → ISO time before which it must not be retried. */
  retryAt: Record<string, string>;
}

/**
 * The schedule to send now, or null. A schedule is due inside its window,
 * when it was not sent today, the window opened after the schedule was
 * created (adding 08:00 at 10:30 does not send at once), and no retry is
 * pending.
 */
export function dueSchedule(input: DueInput): ScheduleWindow | null {
  const now = input.now.setZone(input.timezone);
  const open = windowsOn(now, input.schedules, input.catchUpHours).find(
    (w) => w.start <= now && now < w.end,
  );
  if (!open) return null;
  const { schedule } = open;
  if (input.sent[schedule.id] === open.date) return null;
  if (open.start < DateTime.fromISO(schedule.createdAt)) return null;
  const retryAt = input.retryAt[schedule.id];
  if (retryAt && now < DateTime.fromISO(retryAt)) return null;
  return open;
}

/** The next time any schedule fires after `now`, within a week; null when there are none. */
export function nextOccurrence(
  now: DateTime,
  timezone: string,
  schedules: Schedule[],
): { schedule: Schedule; at: DateTime } | null {
  const local = now.setZone(timezone);
  for (let offset = 0; offset <= 7; offset++) {
    const day = local.plus({ days: offset }).startOf('day');
    for (const schedule of sortSchedules(schedules)) {
      if (!appliesOn(schedule.days, day)) continue;
      const time = at(day, schedule.time);
      if (time > local && time >= DateTime.fromISO(schedule.createdAt))
        return { schedule, at: time };
    }
  }
  return null;
}
