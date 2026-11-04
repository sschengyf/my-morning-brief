import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../test/helpers.js';
import { loadSchedules, newSchedule, saveSchedules, SCHEDULES_FILE } from './store.js';

const NOW = DateTime.fromISO('2026-11-03T10:30:00', { zone: 'Pacific/Auckland' });

describe('schedules store', () => {
  it('tells "never set" (no file) apart from "cleared" (empty list)', async () => {
    const dir = await makeTempDir();
    expect(await loadSchedules(dir)).toEqual({ schedules: null });
    await saveSchedules(dir, []);
    expect(await loadSchedules(dir)).toEqual({ schedules: [] });
  });

  it('saves and loads schedules with their creation time', async () => {
    const dir = await makeTempDir();
    const schedule = newSchedule('08:00', 'weekdays', NOW, 'Pacific/Auckland');
    expect(schedule).toMatchObject({
      time: '08:00',
      days: 'weekdays',
      createdAt: '2026-11-03T10:30:00.000+13:00',
    });
    await saveSchedules(dir, [schedule]);
    expect((await loadSchedules(dir)).schedules).toEqual([schedule]);
  });

  it('moves a corrupt file aside, sends nothing, and remembers to say so', async () => {
    const dir = await makeTempDir();
    const logger = recordingLogger();
    await writeFile(join(dir, SCHEDULES_FILE), '{ "schedules": [{ "time": "8am" }] }');
    const loaded = await loadSchedules(dir, logger);
    expect(loaded.schedules).toEqual([]);
    expect(loaded.corruptBackup).toContain('schedules.json.corrupt-');
    expect(logger.warnings[0]).toContain('schedules.json 内容有误');
    expect((await readdir(dir)).some((name) => name.startsWith('schedules.json.corrupt-'))).toBe(
      true,
    );

    // Still cleared (not "never set") on the next read, until the user edits the list.
    expect(await loadSchedules(dir, logger)).toEqual(loaded);
    await saveSchedules(dir, []);
    expect(JSON.parse(await readFile(join(dir, SCHEDULES_FILE), 'utf8'))).toEqual({
      schedules: [],
    });
  });
});
