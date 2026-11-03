import { DateTime } from 'luxon';

/** "Wellington（Wellington Region, New Zealand）"; empty parts and a region equal to the city are skipped. */
export function placeName(match: { city: string; region?: string; country?: string }): string {
  const parts = [match.region !== match.city ? match.region : undefined, match.country].filter(
    (part): part is string => !!part,
  );
  return parts.length ? `${match.city}（${parts.join(', ')}）` : match.city;
}

/** The next brief.time in `timezone` after `now` (today's if it is still ahead). */
export function nextBriefTime(now: DateTime, timezone: string, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number);
  const local = now.setZone(timezone);
  const today = local.set({ hour, minute, second: 0, millisecond: 0 });
  return today > local ? today : today.plus({ days: 1 });
}

export function formatTime(time: DateTime): string {
  return `${time.month}月${time.day}日 ${time.toFormat('HH:mm')}`;
}
