import { DateTime } from 'luxon';
import ical, { type DateWithTimeZone, type ParameterValue } from 'node-ical';
import { describeError, fetchOk, oneLine, type SourceResult } from './common.js';

export interface CalendarEvent {
  title: string;
  location?: string;
  allDay: boolean;
  /** All-day: ISO date. Timed: ISO date-time with offset in the effective timezone. */
  start: string;
  /** All-day: exclusive ISO date. Timed: ISO date-time. */
  end: string;
}

export interface CalendarRaw {
  date: string;
  events: CalendarEvent[];
  failures: string[];
}

export async function fetchCalendar(
  urls: string[],
  timezone: string,
  now: DateTime,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResult<CalendarRaw>> {
  const day = now.setZone(timezone);
  const date = day.toISODate()!;
  if (urls.length === 0) {
    return { text: '（未配置日历）', raw: { date, events: [], failures: [] }, ok: true };
  }

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const response = await fetchOk(url.replace(/^webcal:\/\//i, 'https://'), fetchImpl);
      return eventsOnDay(await response.text(), timezone, day);
    }),
  );

  const events: CalendarEvent[] = [];
  const failures: string[] = [];
  results.forEach((result, index) => {
    // Never name the calendar by its URL: it is a secret link.
    const label = urls.length > 1 ? `第 ${index + 1} 个日历` : '日历';
    if (result.status === 'fulfilled') events.push(...result.value);
    else failures.push(`（${label}获取失败：${describeError(result.reason)}）`);
  });

  const merged = sortEvents(dedupe(events));
  const lines =
    failures.length === urls.length ? failures : [formatEvents(merged, day), ...failures];
  return {
    text: lines.join('\n'),
    raw: { date, events: merged, failures },
    ok: failures.length < urls.length,
  };
}

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
function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = `${event.title}|${event.start}|${event.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** All-day first, then by start time. */
function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return a.start.localeCompare(b.start) || a.title.localeCompare(b.title);
    return DateTime.fromISO(a.start).toMillis() - DateTime.fromISO(b.start).toMillis();
  });
}

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
function isoDay(isoDate: string): DateTime {
  return DateTime.fromISO(isoDate, { zone: 'utc' });
}
