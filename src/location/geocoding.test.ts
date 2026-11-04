import { describe, expect, it, vi } from 'vitest';
import { searchCity } from './geocoding.js';
import { readFixture } from '../../test/helpers.js';

async function fixtureFetch(name: string) {
  const body = await readFixture(name);
  return vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
}

describe('searchCity', () => {
  it('queries Open-Meteo in English and keeps the API order', async () => {
    const fetchMock = await fixtureFetch('geocoding-wellington.json');
    const matches = await searchCity('Wellington', undefined, fetchMock);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(url.searchParams.get('name')).toBe('Wellington');
    expect(url.searchParams.get('language')).toBe('en');

    expect(matches[0]).toMatchObject({
      city: 'Wellington',
      country: 'New Zealand',
      timezone: 'Pacific/Auckland',
    });
    expect(matches).toHaveLength(5);
  });

  it('filters by country name or code, case-insensitively', async () => {
    const byName = await searchCity(
      'Wellington',
      'united kingdom',
      await fixtureFetch('geocoding-wellington.json'),
    );
    expect(byName.map((m) => m.timezone)).toEqual(['Europe/London']);

    const byCode = await searchCity(
      'Wellington',
      'NZ',
      await fixtureFetch('geocoding-wellington.json'),
    );
    expect(byCode.map((m) => m.country)).toEqual(['New Zealand']);
  });

  it('handles results without a country, such as Hong Kong', async () => {
    const matches = await searchCity(
      'Hong Kong',
      undefined,
      await fixtureFetch('geocoding-hong-kong.json'),
    );
    expect(matches[0]).toMatchObject({ city: 'Hong Kong', timezone: 'Asia/Hong_Kong' });
    expect(matches[0]?.country).toBeUndefined();
  });

  it('returns nothing when the city is unknown', async () => {
    // Open-Meteo omits "results" entirely when nothing matches.
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"generationtime_ms":0.5}'));
    expect(await searchCity('Xyzzyville', undefined, fetchMock)).toEqual([]);
  });

  it('throws on HTTP errors so the bot can report them', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('busy', { status: 503 }));
    await expect(searchCity('Shanghai', undefined, fetchMock)).rejects.toThrow('HTTP 503');
  });
});
