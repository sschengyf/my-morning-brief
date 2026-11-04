import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { nextBriefTime, placeName } from './display.js';

// Tuesday 3 Nov 2026, 10:00 in Auckland.
const NOW = DateTime.fromISO('2026-11-02T21:00:00Z');

describe('parsing helpers', () => {
  it('names places without empty parts or a region that repeats the city', () => {
    expect(placeName({ city: 'Hong Kong' })).toBe('Hong Kong');
    expect(placeName({ city: 'Shanghai', region: 'Shanghai', country: 'China' })).toBe(
      'Shanghai（China）',
    );
    expect(placeName({ city: 'Wellington', region: 'Kansas', country: 'United States' })).toBe(
      'Wellington（Kansas, United States）',
    );
  });

  it('finds the next brief time in the given timezone', () => {
    expect(nextBriefTime(NOW, 'Pacific/Auckland', '08:00').toISO()).toBe(
      '2026-11-04T08:00:00.000+13:00',
    );
    expect(nextBriefTime(NOW, 'Asia/Shanghai', '08:00').toISO()).toBe(
      '2026-11-03T08:00:00.000+08:00',
    );
  });
});
