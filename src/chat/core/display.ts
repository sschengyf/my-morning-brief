import type { DateTime } from 'luxon';

/** "Wellington（Wellington Region, New Zealand）"; empty parts and a region equal to the city are skipped. */
export function placeName(match: { city: string; region?: string; country?: string }): string {
  const parts = [match.region !== match.city ? match.region : undefined, match.country].filter(
    (part): part is string => !!part,
  );
  return parts.length ? `${match.city}（${parts.join(', ')}）` : match.city;
}

export function formatTime(time: DateTime): string {
  return `${time.month}月${time.day}日 ${time.toFormat('HH:mm')}`;
}
