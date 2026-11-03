import { DateTime } from 'luxon';
import ical, { type DateWithTimeZone, type ParameterValue } from 'node-ical';
import { oneLine } from '../common.js';
import { isoDay } from './format.js';
import type { CalendarEvent } from './types.js';

/**
 * Events from one .ics file that overlap `day` (00:00 to the next 00:00 in
 * `timezone`). node-ical reads all-day dates and floating times in the
 * machine's timezone, so those are reinterpreted here: the result must not
 * depend on where the program runs.
 */
export function eventsOnDay(icsText: string, timezone: string, day: DateTime): CalendarEvent[] {
  if (!icsText.includes('BEGIN:VCALENDAR')) throw new Error('不是有效的日历文件');

  const dayStart = day.setZone(timezone).startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const today = dayStart.toISODate()!;
  // Wide margins: all-day and floating instances sit at machine-local times.
  const window = {
    from: dayStart.minus({ days: 2 }).toJSDate(),
    to: dayEnd.plus({ days: 2 }).toJSDate(),
    expandOngoing: true,
  };

  const events: CalendarEvent[] = [];
  for (const component of Object.values(ical.sync.parseICS(icsText))) {
    // Overrides (RECURRENCE-ID) are applied by expandRecurringEvent via their master.
    if (component?.type !== 'VEVENT' || component.recurrenceid) continue;
    for (const instance of ical.expandRecurringEvent(component, window)) {
      const event = instance.event;
      if (event.status === 'CANCELLED') continue;

      const base = {
        title: oneLine(paramText(event.summary)) || '（无标题）',
        ...(event.location && { location: oneLine(paramText(event.location)) }),
      };

      if (instance.isFullDay) {
        const start = localDate(instance.start);
        // DTEND is exclusive; a missing or non-advancing end means a single day.
        let end = instance.end ? localDate(instance.end) : start;
        if (end <= start) end = isoDay(start).plus({ days: 1 }).toISODate()!;
        if (start <= today && today < end) events.push({ ...base, allDay: true, start, end });
        continue;
      }

      const floating = event.start.tz === undefined;
      const start = toZoned(instance.start, timezone, floating);
      const end = instance.end ? toZoned(instance.end, timezone, floating) : start;
      const overlaps =
        end > start ? start < dayEnd && end > dayStart : start >= dayStart && start < dayEnd;
      if (overlaps) {
        events.push({ ...base, allDay: false, start: start.toISO()!, end: end.toISO()! });
      }
    }
  }
  return sortEvents(dedupe(events));
}

function paramText(value: ParameterValue | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.val;
}

/** The calendar date node-ical stored as machine-local midnight. */
function localDate(date: DateWithTimeZone): string {
  return DateTime.fromObject({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  }).toISODate()!;
}

/** Floating times are wall-clock times: read them in machine-local fields, place them in `timezone`. */
function toZoned(date: Date, timezone: string, floating: boolean): DateTime {
  if (!floating) return DateTime.fromJSDate(date, { zone: timezone });
  return DateTime.fromObject(
    {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    },
    { zone: timezone },
  );
}

/** The same calendar subscribed twice, or an event in two calendars, appears once. */
export function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.title}|${event.start}|${event.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** All-day first, then by start time. */
export function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    return DateTime.fromISO(a.start).toMillis() - DateTime.fromISO(b.start).toMillis();
  });
}
