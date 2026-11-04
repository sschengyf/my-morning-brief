import { randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  logger as defaultLogger,
  isNotFound,
  type Logger,
  writeFileAtomic,
} from '#/infra/index.js';
import type { Days, Schedule } from './types.js';

export const SCHEDULES_FILE = 'schedules.json';

const scheduleSchema = z.object({
  id: z.string().min(1),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.enum(['daily', 'weekdays', 'weekends']),
  createdAt: z.string().refine((value) => DateTime.fromISO(value).isValid),
});

const fileSchema = z.object({
  schedules: z.array(scheduleSchema),
  /** Set when a corrupt file was moved aside; shown once in /schedule. */
  corruptBackup: z.string().optional(),
});

export type SchedulesFile = z.infer<typeof fileSchema>;

/**
 * `null` schedules: never set (no file), so the user is asked to set one.
 * An empty list: cleared on purpose, so nothing is sent and nobody is nagged.
 */
export interface LoadedSchedules {
  schedules: Schedule[] | null;
  corruptBackup?: string;
}

/**
 * Reads schedules.json fresh each time; the user may have edited it. A corrupt
 * file is moved aside and replaced by an empty list: no brief is sent, and
 * /schedule says what happened, rather than asking again as if never set.
 */
export async function loadSchedules(
  dataDir: string,
  logger: Logger = defaultLogger,
): Promise<LoadedSchedules> {
  const path = join(dataDir, SCHEDULES_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { schedules: null };
    throw error;
  }
  try {
    const parsed = fileSchema.parse(JSON.parse(text));
    return {
      schedules: parsed.schedules,
      ...(parsed.corruptBackup && { corruptBackup: parsed.corruptBackup }),
    };
  } catch {
    const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(path, backup);
    logger.warn(`schedules.json 内容有误，已改名为 ${backup} 保留；在修好之前不发定时早报`);
    await writeSchedulesFile(dataDir, { schedules: [], corruptBackup: backup });
    return { schedules: [], corruptBackup: backup };
  }
}

/** Saves the list; any notice about a corrupt file is dropped once the user has edited the list. */
export function saveSchedules(dataDir: string, schedules: Schedule[]): Promise<void> {
  return writeSchedulesFile(dataDir, { schedules });
}

function writeSchedulesFile(dataDir: string, file: SchedulesFile): Promise<void> {
  return writeFileAtomic(join(dataDir, SCHEDULES_FILE), `${JSON.stringify(file, null, 2)}\n`);
}

export function newSchedule(time: string, days: Days, now: DateTime, timezone: string): Schedule {
  return {
    id: randomBytes(4).toString('hex'),
    time,
    days,
    createdAt: now.setZone(timezone).toISO()!,
  };
}
