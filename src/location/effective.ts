import { IANAZone } from 'luxon';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type Config,
  logger as defaultLogger,
  isNotFound,
  type Logger,
  writeFileAtomic,
} from '#/infra/index.js';

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
