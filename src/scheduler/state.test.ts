import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../test/helpers.js';
import { emptyState, loadState, saveState, type State } from './state.js';

describe('state', () => {
  it('starts empty when there is no state file', async () => {
    const dir = await makeTempDir();
    expect(await loadState(dir, recordingLogger())).toEqual(emptyState());
  });

  it('round-trips through disk', async () => {
    const dir = await makeTempDir();
    const state: State = {
      sent: { a1b2c3d4: '2026-11-03' },
      attempts: {
        e5f6a7b8: { date: '2026-11-03', failures: 1, nextRetryAt: '2026-11-03T18:02:00.000+13:00' },
      },
      pendingBrief: {
        date: '2026-11-03',
        scheduleId: 'e5f6a7b8',
        text: '早上好',
        channels: ['discord'],
      },
      schedulePromptSent: true,
    };
    await saveState(dir, state);
    expect(await loadState(dir, recordingLogger())).toEqual(state);
  });

  it('drops fields from the single-schedule format and keeps the rest', async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        lastBriefDate: '2026-11-02',
        attempt: null,
        pendingBrief: { date: '2026-11-03', text: '旧格式' },
        schedulePromptSent: true,
      }),
    );
    expect(await loadState(dir, recordingLogger())).toEqual({
      ...emptyState(),
      schedulePromptSent: true,
    });
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it.each([
    ['broken JSON', '{"sent": {"a": "2026-11'],
    ['not an object', '[1, 2]'],
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
