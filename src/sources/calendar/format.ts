import { DateTime } from 'luxon';
import type { CalendarEvent } from './types.js';

export function formatEvents(events: CalendarEvent[], day: DateTime): string {
  if (events.length === 0) return '今天没有日程';
  const today = day.toISODate()!;
  return events.map((event) => formatEvent(event, today, day.zone.name)).join('\n');
}

function formatEvent(event: CalendarEvent, today: string, timezone: string): string {
  const where = event.location ? `（地点：${event.location}）` : '';
  if (event.allDay) {
    const lastDay = isoDay(event.end).minus({ days: 1 }).toISODate()!;
    const span =
      lastDay === event.start ? '' : `（${monthDay(event.start)}至${monthDay(lastDay)}）`;
    return `全天 ${event.title}${span}${where}`;
  }

  const start = DateTime.fromISO(event.start, { zone: timezone });
  const end = DateTime.fromISO(event.end, { zone: timezone });
  const withinToday = start.toISODate() === today && end.toISODate() === today;
  const label = (time: DateTime) =>
    withinToday
      ? time.toFormat('HH:mm')
      : `${relativeDay(time.toISODate()!, today)} ${time.toFormat('HH:mm')}`;
  const when = end > start ? `${label(start)}-${label(end)}` : label(start);
  return `${when} ${event.title}${where}`;
}

function relativeDay(date: string, today: string): string {
  const days = isoDay(date).diff(isoDay(today), 'days').days;
  if (days === 0) return '今天';
  if (days === -1) return '昨天';
  if (days === 1) return '明天';
  return monthDay(date);
}

function monthDay(isoDate: string): string {
  const date = isoDay(isoDate);
  return `${date.month}月${date.day}日`;
}

/** Date-only values are compared in UTC so DST in the machine's zone cannot shift them. */
export function isoDay(isoDate: string): DateTime {
  return DateTime.fromISO(isoDate, { zone: 'utc' });
}
