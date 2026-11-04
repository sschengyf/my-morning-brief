import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { formatTime, placeName } from './display.js';

describe('display helpers', () => {
  it('names places without empty parts or a region that repeats the city', () => {
    expect(placeName({ city: 'Hong Kong' })).toBe('Hong Kong');
    expect(placeName({ city: 'Shanghai', region: 'Shanghai', country: 'China' })).toBe(
      'Shanghai（China）',
    );
    expect(placeName({ city: 'Wellington', region: 'Kansas', country: 'United States' })).toBe(
      'Wellington（Kansas, United States）',
    );
  });

  it('formats a time as month, day and clock time', () => {
    expect(formatTime(DateTime.fromISO('2026-11-03T08:05', { zone: 'Asia/Shanghai' }))).toBe(
      '11月3日 08:05',
    );
  });
});
