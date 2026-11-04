import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger, testConfig } from '../../test/helpers.js';
import { clearLocationOverride, getEffectiveLocation, setLocationOverride } from './effective.js';

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
