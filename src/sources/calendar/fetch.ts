import { DateTime } from 'luxon';
import { describeError, fetchOk, type SourceResult } from '../common.js';
import { dedupe, eventsOnDay, sortEvents } from './expand.js';
import { formatEvents } from './format.js';
import type { CalendarEvent, CalendarRaw } from './types.js';

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
