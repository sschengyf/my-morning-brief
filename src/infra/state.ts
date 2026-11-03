import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isNotFound, writeFileAtomic } from './fs.js';
import { logger as defaultLogger, type Logger } from './logger.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const stateSchema = z.object({
  /** Date (in the effective timezone) of the last scheduled brief that counts as sent. */
  lastBriefDate: isoDate.nullable().default(null),
  /** Retry bookkeeping for today's scheduled brief. */
  attempt: z
    .object({
      date: isoDate,
      failures: z.number().int().nonnegative(),
      nextRetryAt: z.string().nullable(),
    })
    .nullable()
    .default(null),
  /** A generated brief that could not be delivered yet; resent without regenerating. */
  pendingBrief: z.object({ date: isoDate, text: z.string() }).nullable().default(null),
});

export type State = z.infer<typeof stateSchema>;

export const STATE_FILE = 'state.json';

export function emptyState(): State {
  return { lastBriefDate: null, attempt: null, pendingBrief: null };
}

/**
 * A missing file means a fresh install. A corrupt file is moved aside for
 * inspection and replaced by an empty state: at worst today's brief is sent
 * twice, which beats refusing to start.
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

  let reason: string;
  try {
    const result = stateSchema.safeParse(JSON.parse(text));
    if (result.success) return result.data;
    reason = '内容格式不对';
  } catch {
    reason = '不是有效的 JSON';
  }

  const backup = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(path, backup);
  logger.warn(`state.json ${reason}，已改名为 ${backup} 保留，按空状态继续运行`);
  return emptyState();
}

export async function saveState(dataDir: string, state: State): Promise<void> {
  await writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}
