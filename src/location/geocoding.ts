import { IANAZone } from 'luxon';
import { z } from 'zod';
import type { LocationOverride } from './effective.js';

export type CityMatch = LocationOverride;

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REQUEST_TIMEOUT_MS = 20_000;

const geocodingSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Looks up a city by (English) name via Open-Meteo geocoding. When a country
 * is given, only results whose country name or code matches are kept. Results
 * keep the API's order, which puts the most populous match first.
 */
export async function searchCity(
  name: string,
  country?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CityMatch[]> {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'en');

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`城市查询失败：HTTP ${response.status}`);
  const { results = [] } = geocodingSchema.parse(await response.json());

  const wanted = country?.trim().toLowerCase();
  return results
    .filter((result) => result.timezone && IANAZone.isValidZone(result.timezone))
    .filter(
      (result) =>
        !wanted ||
        result.country?.toLowerCase() === wanted ||
        result.country_code?.toLowerCase() === wanted,
    )
    .map((result) => ({
      city: result.name,
      region: result.admin1,
      country: result.country,
      timezone: result.timezone!,
      latitude: result.latitude,
      longitude: result.longitude,
    }));
}
