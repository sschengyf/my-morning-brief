import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  logger as defaultLogger,
  isNotFound,
  type Logger,
  writeFileAtomic,
} from '#/infra/index.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const fields = {
  /** Schedule id → the last date (effective timezone) its brief counts as sent. */
  sent: z.record(z.string(), isoDate),
  /** Schedule id → retry bookkeeping for that schedule's brief of `date`. */
  attempts: z.record(
    z.string(),
    z.object({ date: isoDate, failures: z.number().int().positive(), nextRetryAt: z.string() }),
  ),
  /** A generated brief some channels did not get yet; resent to them without regenerating. */
  pendingBrief: z
    .object({
      date: isoDate,
      scheduleId: z.string(),
      text: z.string(),
      channels: z.array(z.string()).min(1),
    })
    .nullable(),
  /** The "set a schedule" reminder went out; it is sent once, not on every restart. */
  schedulePromptSent: z.boolean(),
};

export type State = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> };
export type PendingBrief = NonNullable<State['pendingBrief']>;

export const STATE_FILE = 'state.json';

export function emptyState(): State {
  return { sent: {}, attempts: {}, pendingBrief: null, schedulePromptSent: false };
}

/**
 * A missing file means a fresh install. Fields from an older format (such as
 * the single lastBriefDate before several schedules) are dropped one by one.
 * A file that is not JSON at all is moved aside and replaced by an empty
 * state: at worst a brief is sent twice, which beats refusing to start.
 */
export async function loadState(dataDir: string, logger: Logger = defaultLogger): Promise<State> {
  const path = join(dataDir, STATE_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return emptyState();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(path, backup);
    logger.warn(`state.json 不是有效的 JSON，已改名为 ${backup} 保留，按空状态继续运行`);
    return emptyState();
  }

  const record = parsed as Record<string, unknown>;
  const state = emptyState();
  for (const key of Object.keys(fields) as (keyof State)[]) {
    if (!(key in record)) continue;
    const result = fields[key].safeParse(record[key]);
    if (result.success) (state as Record<keyof State, unknown>)[key] = result.data;
  }
  return state;
}

export async function saveState(dataDir: string, state: State): Promise<void> {
  await writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}
