import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { eventsOnDay, fetchCalendar, formatEvents } from '../../src/sources/calendar.js';

const AUCKLAND = 'Pacific/Auckland';

function vcal(...events: string[][]): string {
  const body = events.flatMap((lines, index) => [
    'BEGIN:VEVENT',
    `UID:event-${index}@test`,
    'DTSTAMP:20261001T000000Z',
    ...lines,
    'END:VEVENT',
  ]);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...body, 'END:VCALENDAR'].join(
    '\r\n',
  );
}

function fixture(name: string): Promise<string> {
  return readFile(join(import.meta.dirname, '../fixtures/calendar', name), 'utf8');
}

/** The formatted schedule for one day, as the model will see it. */
function scheduleOn(ics: string, date: string, timezone = AUCKLAND): string {
  const day = DateTime.fromISO(date, { zone: timezone });
  return formatEvents(eventsOnDay(ics, timezone, day), day);
}

describe('eventsOnDay', () => {
  it('converts UTC times to the effective timezone', () => {
    const ics = vcal(['DTSTART:20261102T200000Z', 'DTEND:20261102T210000Z', 'SUMMARY:UTC standup']);
    expect(scheduleOn(ics, '2026-11-03')).toBe('09:00-10:00 UTC standup');
  });

  it('converts events from other timezones', () => {
    const ics = vcal([
      'DTSTART;TZID=America/New_York:20261102T160000',
      'DTEND;TZID=America/New_York:20261102T170000',
      'SUMMARY:NY sync',
    ]);
    expect(scheduleOn(ics, '2026-11-03')).toBe('10:00-11:00 NY sync');
  });

  it('shows the same event in Shanghai time when the user has switched city', () => {
    const ics = vcal(['DTSTART:20261103T010000Z', 'DTEND:20261103T013000Z', 'SUMMARY:Review']);
    expect(scheduleOn(ics, '2026-11-03')).toBe('14:00-14:30 Review');
    expect(scheduleOn(ics, '2026-11-03', 'Asia/Shanghai')).toBe('09:00-09:30 Review');
  });

  it('expands daily events across the NZ daylight saving change, honouring EXDATE', async () => {
    const ics = await fixture('dst-daily.ics');
    expect(scheduleOn(ics, '2026-09-26')).toBe('09:00-09:30 Daily standup');
    // 27 Sep 2026 is only 23 hours long; the event stays at 09:00 local.
    expect(scheduleOn(ics, '2026-09-27')).toBe('09:00-09:30 Daily standup');
    expect(scheduleOn(ics, '2026-09-29')).toBe('今天没有日程'); // EXDATE
    expect(scheduleOn(ics, '2026-09-30')).toBe('09:00-09:30 Daily standup');
  });

  it('applies RECURRENCE-ID overrides, including one moved to another day', async () => {
    const ics = await fixture('weekly-moved.ics');
    expect(scheduleOn(ics, '2026-10-26')).toBe('10:00-11:00 1:1 with Sam（地点：Room A）');
    expect(scheduleOn(ics, '2026-11-02')).toBe('14:30-15:30 1:1 with Sam (moved)（地点：Room B）');
    expect(scheduleOn(ics, '2026-11-09')).toBe('今天没有日程');
    expect(scheduleOn(ics, '2026-11-10')).toBe('09:00-10:00 1:1 with Sam (Tuesday)');
  });

  it('understands Outlook (Windows) timezone names', async () => {
    expect(scheduleOn(await fixture('windows-tzid.ics'), '2026-11-03')).toBe(
      '09:00-10:00 Outlook meeting',
    );
  });

  it('places floating times in the effective timezone', () => {
    const ics = vcal(['DTSTART:20261103T090000', 'DTEND:20261103T100000', 'SUMMARY:Gym']);
    expect(scheduleOn(ics, '2026-11-03')).toBe('09:00-10:00 Gym');
    expect(scheduleOn(ics, '2026-11-03', 'Asia/Shanghai')).toBe('09:00-10:00 Gym');
  });

  it('keeps all-day events on their date in any timezone', () => {
    const ics = vcal([
      'DTSTART;VALUE=DATE:20261103',
      'DTEND;VALUE=DATE:20261104',
      'SUMMARY:Public holiday',
    ]);
    for (const timezone of [AUCKLAND, 'Asia/Shanghai', 'America/Los_Angeles']) {
      expect(scheduleOn(ics, '2026-11-02', timezone)).toBe('今天没有日程');
      expect(scheduleOn(ics, '2026-11-03', timezone)).toBe('全天 Public holiday');
      expect(scheduleOn(ics, '2026-11-04', timezone)).toBe('今天没有日程'); // DTEND is exclusive
    }
  });

  it('shows multi-day all-day events on every day they cover', () => {
    const ics = vcal([
      'DTSTART;VALUE=DATE:20261102',
      'DTEND;VALUE=DATE:20261105',
      'SUMMARY:Conference',
    ]);
    expect(scheduleOn(ics, '2026-11-03')).toBe('全天 Conference（11月2日至11月4日）');
    expect(scheduleOn(ics, '2026-11-04')).toBe('全天 Conference（11月2日至11月4日）');
    expect(scheduleOn(ics, '2026-11-05')).toBe('今天没有日程');
  });

  it('includes events that started yesterday or end tomorrow', () => {
    const ics = vcal(
      [
        `DTSTART;TZID=${AUCKLAND}:20261102T220000`,
        `DTEND;TZID=${AUCKLAND}:20261103T010000`,
        'SUMMARY:Late deploy',
      ],
      [
        `DTSTART;TZID=${AUCKLAND}:20261103T230000`,
        `DTEND;TZID=${AUCKLAND}:20261104T020000`,
        'SUMMARY:Night flight',
      ],
      [
        `DTSTART;TZID=${AUCKLAND}:20261102T090000`,
        `DTEND;TZID=${AUCKLAND}:20261102T100000`,
        'SUMMARY:Yesterday only',
      ],
    );
    expect(scheduleOn(ics, '2026-11-03')).toBe(
      ['昨天 22:00-今天 01:00 Late deploy', '今天 23:00-明天 02:00 Night flight'].join('\n'),
    );
  });

  it('lists all-day events first, then by start time, and skips cancelled ones', () => {
    const ics = vcal(
      ['DTSTART:20261103T030000Z', 'SUMMARY:Lunch', 'LOCATION:Cafe\\nupstairs'],
      ['DTSTART:20261102T200000Z', 'DTEND:20261102T203000Z', 'SUMMARY:Standup'],
      ['DTSTART;VALUE=DATE:20261103', 'SUMMARY:Birthday'],
      ['DTSTART:20261102T210000Z', 'STATUS:CANCELLED', 'SUMMARY:Cancelled'],
    );
    expect(scheduleOn(ics, '2026-11-03')).toBe(
      ['全天 Birthday', '09:00-09:30 Standup', '16:00 Lunch（地点：Cafe upstairs）'].join('\n'),
    );
  });

  it('rejects files that are not calendars, such as an HTML login page', () => {
    expect(() => eventsOnDay('<html>Sign in</html>', AUCKLAND, DateTime.now())).toThrow(
      '不是有效的日历文件',
    );
  });
});

describe('fetchCalendar', () => {
  const now = DateTime.fromISO('2026-11-03T08:00', { zone: AUCKLAND });
  const standup = vcal(['DTSTART:20261102T200000Z', 'DTEND:20261102T203000Z', 'SUMMARY:Standup']);

  it('says when no calendar is configured', async () => {
    expect((await fetchCalendar([], AUCKLAND, now)).text).toBe('（未配置日历）');
  });

  it('turns webcal:// into https://', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(standup));
    const result = await fetchCalendar(
      ['webcal://example.com/private.ics'],
      AUCKLAND,
      now,
      fetchMock,
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.com/private.ics');
    expect(result).toMatchObject({ text: '09:00-09:30 Standup', ok: true });
  });

  it('keeps working calendars when one fails, without revealing its link', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('broken')
        ? new Response('gone', { status: 404 })
        : new Response(standup),
    );
    const urls = ['https://example.com/ok.ics', 'https://example.com/broken-secret.ics'];
    const result = await fetchCalendar(urls, AUCKLAND, now, fetchMock);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('09:00-09:30 Standup\n（第 2 个日历获取失败：HTTP 404）');
    expect(result.text).not.toContain('broken-secret');
    expect(result.raw.failures).toEqual(['（第 2 个日历获取失败：HTTP 404）']);
  });

  it('is not ok when every calendar fails', async () => {
    const result = await fetchCalendar(
      ['https://example.com/a.ics'],
      AUCKLAND,
      now,
      vi.fn<typeof fetch>(async () => new Response('<html>login</html>')),
    );
    expect(result).toMatchObject({ text: '（日历获取失败：不是有效的日历文件）', ok: false });
  });

  it('shows an event once when two calendars contain it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(standup));
    const result = await fetchCalendar(
      ['https://example.com/a.ics', 'https://example.com/b.ics'],
      AUCKLAND,
      now,
      fetchMock,
    );
    expect(result.raw.events).toHaveLength(1);
  });
});
