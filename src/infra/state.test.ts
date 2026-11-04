import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../test/helpers.js';
import { emptyState, loadState, saveState } from './state.js';

describe('state', () => {
  it('starts empty when there is no state file', async () => {
    const dir = await makeTempDir();
    expect(await loadState(dir, recordingLogger())).toEqual(emptyState());
  });

  it('round-trips through disk', async () => {
    const dir = await makeTempDir();
    const state = {
      lastBriefDate: '2026-11-02',
      attempt: { date: '2026-11-03', failures: 1, nextRetryAt: '2026-11-03T08:02:00+13:00' },
      pendingBrief: { date: '2026-11-03', text: '早上好' },
    };
    await saveState(dir, state);
    expect(await loadState(dir, recordingLogger())).toEqual(state);
  });

  it.each([
    ['broken JSON', '{"lastBriefDate": "2026-11'],
    ['wrong shape', '{"lastBriefDate": 20261102}'],
  ])('keeps running with an empty state and preserves a file with %s', async (_label, content) => {
    const dir = await makeTempDir();
    await writeFile(join(dir, 'state.json'), content);
    const logger = recordingLogger();

    expect(await loadState(dir, logger)).toEqual(emptyState());

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^state\.json\.corrupt-/);
    expect(await readFile(join(dir, files[0]!), 'utf8')).toBe(content);
    expect(logger.warnings[0]).toContain('已改名为');
  });
});
