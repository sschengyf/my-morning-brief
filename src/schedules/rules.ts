import type { DateTime } from 'luxon';
import type { Days, Schedule } from './types.js';

export const MAX_SCHEDULES = 6;
/** Closer schedules would leave the earlier one no room to catch up or retry. */
export const MIN_GAP_MINUTES = 30;

const DAYS_LABELS: Record<Days, string> = { daily: '每天', weekdays: '工作日', weekends: '周末' };
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function daysLabel(days: Days): string {
  return DAYS_LABELS[days];
}

/** "08:00 每天" */
export function describeSchedule(schedule: Pick<Schedule, 'time' | 'days'>): string {
  return `${schedule.time} ${daysLabel(schedule.days)}`;
}

/** "每天" / "工作日" / "周末" (also a few English words); undefined means daily. */
export function parseDays(text: string | undefined): Days | null {
  if (text === undefined || text === '') return 'daily';
  const normalized = text.trim().toLowerCase();
  const found = (Object.entries(DAYS_LABELS) as [Days, string][]).find(
    ([days, label]) => label === normalized || days === normalized,
  );
  return found ? found[0] : null;
}

/** "8:00" → "08:00"; null when it is not a time. */
export function parseTime(text: string): string | null {
  const match = TIME.exec(text.trim());
  return match ? `${match[1]!.padStart(2, '0')}:${match[2]}` : null;
}

/** Whether a schedule applies on a day, by that day's weekday in the effective timezone. */
export function appliesOn(days: Days, day: DateTime): boolean {
  const weekend = day.weekday >= 6;
  return days === 'daily' || (days === 'weekends') === weekend;
}

function daysOverlap(a: Days, b: Days): boolean {
  return a === 'daily' || b === 'daily' || a === b;
}

function minutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour! * 60 + minute!;
}

/** By time, then daily before weekdays before weekends. */
export function sortSchedules(schedules: Schedule[]): Schedule[] {
  const order: Days[] = ['daily', 'weekdays', 'weekends'];
  return [...schedules].sort(
    (a, b) => a.time.localeCompare(b.time) || order.indexOf(a.days) - order.indexOf(b.days),
  );
}

/** Why a new schedule cannot be added, or null when it can. */
export function rejectNew(existing: Schedule[], time: string, days: Days): string | null {
  if (existing.length >= MAX_SCHEDULES) return `最多只能设 ${MAX_SCHEDULES} 个定时`;
  for (const other of existing) {
    if (!daysOverlap(other.days, days)) continue;
    if (other.time === time) return `已经有 ${describeSchedule(other)}，同一天不能在同一时间发两份`;
    if (Math.abs(minutes(other.time) - minutes(time)) < MIN_GAP_MINUTES) {
      return `和 ${describeSchedule(other)} 离得太近，同一天的两个定时至少要隔 ${MIN_GAP_MINUTES} 分钟`;
    }
  }
  return null;
}
