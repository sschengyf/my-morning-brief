import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, recordingLogger, testConfig } from '../helpers.js';
import {
  clearLocationOverride,
  getEffectiveLocation,
  setLocationOverride,
} from '../../src/location/effective.js';
import { searchCity } from '../../src/location/geocoding.js';

const SHANGHAI = {
  city: 'Shanghai',
  country: 'China',
  region: 'Shanghai',
  timezone: 'Asia/Shanghai',
  latitude: 31.22222,
  longitude: 121.45806,
};

describe('effective location', () => {
  it('uses home from config when there is no override', async () => {
    const config = testConfig(await makeTempDir());
    expect(await getEffectiveLocation(config, recordingLogger())).toEqual({
      city: 'Auckland',
      timezone: 'Pacific/Auckland',
      latitude: -36.85,
      longitude: 174.76,
      isHome: true,
    });
  });

  it('uses the override once set and returns home after clearing it', async () => {
    const config = testConfig(await makeTempDir());
    await setLocationOverride(config, SHANGHAI);
    expect(await getEffectiveLocation(config, recordingLogger())).toEqual({
      ...SHANGHAI,
      isHome: false,
    });

    await clearLocationOverride(config);
    expect((await getEffectiveLocation(config, recordingLogger())).isHome).toBe(true);
    await clearLocationOverride(config); // clearing twice is fine
  });

  it('falls back to home with a warning when location.json is corrupt', async () => {
    const config = testConfig(await makeTempDir());
    const logger = recordingLogger();
    await writeFile(
      join(config.paths.data_dir, 'location.json'),
      '{"city": "Shanghai", "timezone": "Mars/Base"}',
    );

    expect((await getEffectiveLocation(config, logger)).city).toBe('Auckland');
    expect(logger.warnings[0]).toContain('location.json 内容有误');
  });

  it('refuses to store an invalid timezone', async () => {
    const config = testConfig(await makeTempDir());
    await expect(
      setLocationOverride(config, { ...SHANGHAI, timezone: 'Shanghai' }),
    ).rejects.toThrow();
  });

  it('writes the override atomically as readable JSON', async () => {
    const config = testConfig(await makeTempDir());
    await setLocationOverride(config, SHANGHAI);
    const text = await readFile(join(config.paths.data_dir, 'location.json'), 'utf8');
    expect(JSON.parse(text)).toEqual(SHANGHAI);
  });
});

async function fixtureFetch(name: string) {
  const body = await readFile(join(import.meta.dirname, '../fixtures', name), 'utf8');
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
