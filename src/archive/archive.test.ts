import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../test/helpers.js';
import type { NumberedNews } from '../sources/news/types.js';
import { Archive } from './archive.js';
import type { ArchiveEntry, ArchiveRaw, BriefKind } from './types.js';

function news(id: string, link: string): NumberedNews {
  return { id, source: 'RNZ', title: id, link, publishedAt: null, summary: '', titleOnly: true };
}

function entry(
  date: string,
  kind: BriefKind,
  time = '08:00:00',
  newsRecord: { selected: NumberedNews[]; usedIds: string[] } | null = null,
): ArchiveEntry {
  const raw: ArchiveRaw = {
    version: 1,
    kind,
    generatedAt: `${date}T${time}.000+13:00`,
    location: { city: 'Auckland', timezone: 'Pacific/Auckland', isHome: true },
    model: 'qwen3:32b',
    fallback: false,
    sources: {
      weather: { ok: true, text: '晴', data: null },
      calendar: { ok: true, text: '今天没有日程', data: null },
      todos: { ok: true, text: '1. A', data: null },
    },
    news: newsRecord && {
      ok: true,
      failures: [],
      candidates: [],
      tooOld: [],
      dedupExcluded: [],
      method: 'round_robin',
      ...newsRecord,
    },
  };
  return { date, raw, input: `prompt + data ${kind} ${time}`, brief: `早报 ${kind} ${time}` };
}

async function archiveIn(): Promise<Archive> {
  return new Archive(join(await makeTempDir(), 'archive'), recordingLogger());
}

describe('Archive', () => {
  it('writes a scheduled brief as raw.json, input.txt and brief.md with front matter', async () => {
    const archive = await archiveIn();
    const path = await archive.write(entry('2026-11-03', 'scheduled'));

    const dayDir = join(archive.dir, '2026-11-03');
    expect(path).toBe(join(dayDir, 'brief.md'));
    expect((await readdir(dayDir)).sort()).toEqual(['brief.md', 'input.txt', 'raw.json']);
    expect(await readFile(path, 'utf8')).toBe(
      [
        '---',
        'generated_at: 2026-11-03T08:00:00.000+13:00',
        'kind: scheduled',
        'city: "Auckland"',
        'timezone: Pacific/Auckland',
        'model: "qwen3:32b"',
        'fallback: false',
        '---',
        '',
        '早报 scheduled 08:00:00',
        '',
      ].join('\n'),
    );
    expect(await readFile(join(dayDir, 'input.txt'), 'utf8')).toBe(
      'prompt + data scheduled 08:00:00',
    );
    expect(JSON.parse(await readFile(join(dayDir, 'raw.json'), 'utf8')).model).toBe('qwen3:32b');
  });

  it('names manual briefs by time, never reusing a name within the same second', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2026-11-03', 'manual', '09:30:15'));
    await archive.write(entry('2026-11-03', 'manual', '09:30:15'));
    await archive.write(entry('2026-11-03', 'manual', '10:00:00'));
    expect((await readdir(join(archive.dir, '2026-11-03'))).sort()).toEqual([
      'brief-manual-093015-2.md',
      'brief-manual-093015.md',
      'brief-manual-100000.md',
      'input-manual-093015-2.txt',
      'input-manual-093015.txt',
      'input-manual-100000.txt',
      'raw-manual-093015-2.json',
      'raw-manual-093015.json',
      'raw-manual-100000.json',
    ]);
  });

  it('reads the latest manual brief when there is no scheduled one', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2026-11-03', 'manual', '10:00:00'));
    await archive.write(entry('2026-11-03', 'manual', '09:30:15'));
    expect(await archive.readBrief('2026-11-03')).toMatchObject({
      kind: 'manual',
      text: '早报 manual 10:00:00',
    });
    expect((await archive.readRaw('2026-11-03'))?.generatedAt).toContain('T10:00:00');
  });

  it('prefers the scheduled brief over manual ones', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2026-11-03', 'manual', '07:00:00'));
    await archive.write(entry('2026-11-03', 'scheduled', '08:00:00'));
    await archive.write(entry('2026-11-03', 'manual', '09:00:00'));
    expect(await archive.readBrief('2026-11-03')).toMatchObject({
      kind: 'scheduled',
      text: '早报 scheduled 08:00:00',
    });
    expect((await archive.readRaw('2026-11-03'))?.kind).toBe('scheduled');
  });

  it('finds the most recently generated brief, scheduled or manual', async () => {
    const archive = await archiveIn();
    expect(await archive.latestBrief('2026-11-03')).toBeNull();
    await archive.write(entry('2026-11-03', 'manual', '07:00:00'));
    await archive.write(entry('2026-11-03', 'scheduled', '08:00:00'));
    expect((await archive.latestBrief('2026-11-03'))?.text).toBe('早报 scheduled 08:00:00');
    await archive.write(entry('2026-11-03', 'manual', '10:00:00'));
    const latest = await archive.latestBrief('2026-11-03');
    expect(latest?.text).toBe('早报 manual 10:00:00');
    expect(latest?.raw.kind).toBe('manual');
  });

  it('skips a brief whose write was cut short, falling back to the one before', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2026-11-03', 'scheduled', '08:00:00'));
    await archive.write(entry('2026-11-03', 'manual', '09:30:15'));
    // Killed between raw.json and brief.md.
    await rm(join(archive.dir, '2026-11-03', 'brief-manual-093015.md'));
    expect((await archive.latestBrief('2026-11-03'))?.text).toBe('早报 scheduled 08:00:00');
  });

  it('parses each raw.json once until it changes, and warns about a broken one once', async () => {
    const logger = recordingLogger();
    const archive = new Archive(join(await makeTempDir(), 'archive'), logger);
    await archive.write(entry('2026-11-03', 'scheduled', '08:00:00'));
    const dayDir = join(archive.dir, '2026-11-03');
    await writeFile(join(dayDir, 'raw-manual-093015.json'), '{ broken');
    await writeFile(join(dayDir, 'brief-manual-093015.md'), '坏的');
    for (let i = 0; i < 3; i++) await archive.latestBrief('2026-11-03');
    expect(logger.warnings).toHaveLength(1);

    // A rewritten file is read again.
    const fixed = entry('2026-11-03', 'manual', '09:30:15');
    await writeFile(join(dayDir, 'raw-manual-093015.json'), JSON.stringify(fixed.raw));
    await writeFile(join(dayDir, 'brief-manual-093015.md'), '修好的');
    expect((await archive.latestBrief('2026-11-03'))?.text).toBe('修好的');
  });

  it('returns null for dates without a brief, or that are not dates', async () => {
    const archive = await archiveIn();
    expect(await archive.readBrief('2026-11-03')).toBeNull();
    expect(await archive.readBrief('../../etc')).toBeNull();
    expect(await archive.listDates()).toEqual([]);
  });

  it('lists dates newest first and ignores other folders', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2026-11-01', 'scheduled'));
    await archive.write(entry('2026-11-03', 'scheduled'));
    await mkdir(join(archive.dir, 'notes'));
    expect(await archive.listDates()).toEqual(['2026-11-03', '2026-11-01']);
  });

  it('prunes folders older than retention_days and keeps the rest', async () => {
    const archive = await archiveIn();
    for (const date of ['2026-08-04', '2026-08-05', '2026-11-02']) {
      await archive.write(entry(date, 'scheduled'));
    }
    // 90 days before 2026-11-03 is 2026-08-05, which is kept.
    expect(await archive.prune(90, '2026-11-03')).toEqual(['2026-08-04']);
    expect(await archive.listDates()).toEqual(['2026-11-02', '2026-08-05']);
  });

  it('keeps everything when retention_days is 0', async () => {
    const archive = await archiveIn();
    await archive.write(entry('2020-01-01', 'scheduled'));
    expect(await archive.prune(0, '2026-11-03')).toEqual([]);
    expect(await archive.listDates()).toEqual(['2020-01-01']);
  });

  it('collects links the recent briefs actually used, skipping broken files', async () => {
    const logger = recordingLogger();
    const archive = new Archive(join(await makeTempDir(), 'archive'), logger);
    const shown = { selected: [news('N1', 'https://a.test/1'), news('N2', 'https://a.test/2')] };
    await archive.write(
      entry('2026-11-02', 'scheduled', '08:00:00', { ...shown, usedIds: ['N2'] }),
    );
    await archive.write(
      entry('2026-11-01', 'manual', '09:00:00', {
        selected: [news('N1', 'https://b.test/1')],
        usedIds: ['N1'],
      }),
    );
    // Today's brief and briefs older than `days` do not count.
    await archive.write(
      entry('2026-11-03', 'manual', '07:00:00', {
        selected: [news('N1', 'https://today.test')],
        usedIds: ['N1'],
      }),
    );
    await archive.write(
      entry('2026-10-30', 'scheduled', '08:00:00', {
        selected: [news('N1', 'https://old.test')],
        usedIds: ['N1'],
      }),
    );
    await mkdir(join(archive.dir, '2026-10-31'));
    await writeFile(join(archive.dir, '2026-10-31', 'raw.json'), '{ broken');

    const links = await archive.recentUsedNewsLinks(3, '2026-11-03');
    expect([...links].sort()).toEqual(['https://a.test/2', 'https://b.test/1']);
    expect(logger.warnings).toEqual([expect.stringContaining('读取失败，已跳过')]);
    expect(await archive.recentUsedNewsLinks(0, '2026-11-03')).toEqual(new Set());
  });
});
