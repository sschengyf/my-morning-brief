import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { fetchCalendar } from './fetch.js';

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

describe('fetchCalendar', () => {
  const now = DateTime.fromISO('2026-11-03T08:00', { zone: AUCKLAND });
  const standup = vcal(['DTSTART:20261102T200000Z', 'DTEND:20261102T203000Z', 'SUMMARY:Standup']);

  it('says when no calendar is configured', async () => {
    expect((await fetchCalendar([], AUCKLAND, now)).text).toBe('今天没有日程');
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
