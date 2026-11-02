import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import type { Config } from './config.js';
import { isNotFound, writeFileAtomic } from './fsUtil.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export interface Location {
  city: string;
  region?: string;
  country?: string;
  timezone: string;
  latitude: number;
  longitude: number;
  /** True when this is the home location from config.toml rather than a /city override. */
  isHome: boolean;
}

export type LocationOverride = Omit<Location, 'isHome'>;

export const LOCATION_FILE = 'location.json';

const overrideSchema = z.object({
  city: z.string().min(1),
  region: z.string().optional(),
  country: z.string().optional(),
  timezone: z.string().refine((value) => IANAZone.isValidZone(value)),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export function homeLocation(config: Config): Location {
  const { city, timezone, latitude, longitude } = config.brief;
  return { city, timezone, latitude, longitude, isHome: true };
}

/**
 * The location every "today" calculation uses: the /city override if one is
 * set, otherwise home from config.toml. Never the system timezone, which stays
 * in Auckland while the user travels and is UTC on servers.
 */
export async function getEffectiveLocation(
  config: Config,
  logger: Logger = defaultLogger,
): Promise<Location> {
  const path = join(config.paths.data_dir, LOCATION_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!isNotFound(error))
      logger.warn('读取 location.json 失败，使用 config.toml 里的位置', error);
    return homeLocation(config);
  }

  try {
    const override = overrideSchema.parse(JSON.parse(text));
    return { ...override, isHome: false };
  } catch {
    logger.warn('location.json 内容有误，使用 config.toml 里的位置；可以用 /home 清除');
    return homeLocation(config);
  }
}

export async function setLocationOverride(config: Config, location: LocationOverride) {
  const override = overrideSchema.parse(location);
  const path = join(config.paths.data_dir, LOCATION_FILE);
  await writeFileAtomic(path, `${JSON.stringify(override, null, 2)}\n`);
}

export async function clearLocationOverride(config: Config): Promise<void> {
  try {
    await unlink(join(config.paths.data_dir, LOCATION_FILE));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

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
