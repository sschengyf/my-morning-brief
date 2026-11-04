import { DateTime } from 'luxon';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  logger as defaultLogger,
  isNotFound,
  type Logger,
  writeFileAtomic,
} from '#/infra/index.js';
import { frontMatter, stripFrontMatter } from './front-matter.js';
import type { ArchiveEntry, ArchiveRaw, BriefKind, StoredBrief } from './types.js';

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** Parsed raw.json files kept in memory; chat checks today's on every question. */
const RAW_CACHE_SIZE = 50;
// brief-scheduled-0800.md, brief-manual-093015.md, brief-manual-093015-2.md; plain brief.md
// is a scheduled brief from before there could be several a day.
const BRIEF_FILE = /^brief(?:-(scheduled|manual)-(\d{4}|\d{6})(-\d+)?)?\.md$/;

interface BriefFile {
  /** "" for brief.md, else e.g. "-scheduled-0800"; shared by raw, input and brief. */
  suffix: string;
  kind: BriefKind;
}

/**
 * Daily folders of plain files, e.g. archive/2026-11-03/brief-scheduled-0800.md.
 * Every brief's files carry its kind and time, so a day can hold several
 * scheduled briefs and any number of manual ones (/brief, brief:once), and
 * none overwrites another.
 */
export class Archive {
  private readonly rawCache = new Map<
    string,
    { ino: number; mtimeMs: number; size: number; raw: ArchiveRaw | null }
  >();

  constructor(
    readonly dir: string,
    private readonly logger: Logger = defaultLogger,
  ) {}

  /** Writes raw.json, input.txt and brief.md. Returns the brief's path. */
  async write(entry: ArchiveEntry): Promise<string> {
    const dayDir = join(this.dir, entry.date);
    await mkdir(dayDir, { recursive: true });
    const suffix = await this.freeSuffix(dayDir, entry.raw);

    const briefPath = join(dayDir, `brief${suffix}.md`);
    await writeFileAtomic(
      join(dayDir, `raw${suffix}.json`),
      `${JSON.stringify(entry.raw, null, 2)}\n`,
    );
    await writeFileAtomic(join(dayDir, `input${suffix}.txt`), entry.input);
    await writeFileAtomic(briefPath, `${frontMatter(entry.raw)}${entry.brief}\n`);
    return briefPath;
  }

  /**
   * "-scheduled-0800" (the schedule's time) or "-manual-093015" (the time it
   * was made), with "-2" and so on when the name is taken: the same schedule
   * deleted and added again can send twice in a day.
   */
  private async freeSuffix(dayDir: string, raw: ArchiveRaw): Promise<string> {
    const generated = DateTime.fromISO(raw.generatedAt, { setZone: true });
    const base =
      raw.kind === 'scheduled'
        ? `-scheduled-${(raw.schedule?.time ?? generated.toFormat('HH:mm')).replace(':', '')}`
        : `-manual-${generated.toFormat('HHmmss')}`;
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? base : `${base}-${n}`;
      if (!(await exists(join(dayDir, `brief${suffix}.md`)))) return suffix;
    }
  }

  /** Archived dates, newest first. */
  async listDates(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return names
      .filter((name) => DATE_DIR.test(name))
      .sort()
      .reverse();
  }

  /** The first scheduled brief of a date, or else that day's latest manual one. */
  async readBrief(date: string): Promise<StoredBrief | null> {
    const found = await this.pick(date);
    return found ? this.stored(date, found) : null;
  }

  /** raw.json of the same brief readBrief picks; null if missing or unreadable. */
  async readRaw(date: string): Promise<ArchiveRaw | null> {
    const found = await this.pick(date);
    return found ? this.parseRaw(join(this.dir, date, `raw${found.suffix}.json`)) : null;
  }

  /** Every brief of a date, in the order they were made. */
  async briefsOfDay(date: string): Promise<StoredBrief[]> {
    if (!DATE_DIR.test(date)) return [];
    const briefs = await Promise.all(
      (await this.briefFiles(join(this.dir, date))).map((file) => this.stored(date, file)),
    );
    // Unreadable raws have no time; they keep their place by file name.
    return briefs
      .map((brief, index) => ({ brief, index }))
      .sort((a, b) => {
        const at = (x: StoredBrief) =>
          x.generatedAt ? DateTime.fromISO(x.generatedAt).toMillis() : NaN;
        const diff = at(a.brief) - at(b.brief);
        return Number.isNaN(diff) ? a.index - b.index : diff;
      })
      .map(({ brief }) => brief);
  }

  private async pick(date: string): Promise<BriefFile | null> {
    if (!DATE_DIR.test(date)) return null;
    const files = await this.briefFiles(join(this.dir, date));
    return (
      files.find((f) => f.kind === 'scheduled') ??
      files.filter((f) => f.kind === 'manual').at(-1) ??
      null
    );
  }

  private async stored(date: string, file: BriefFile): Promise<StoredBrief> {
    const dayDir = join(this.dir, date);
    const path = join(dayDir, `brief${file.suffix}.md`);
    const [text, raw] = await Promise.all([
      readFile(path, 'utf8'),
      this.parseRaw(join(dayDir, `raw${file.suffix}.json`)),
    ]);
    return {
      date,
      kind: file.kind,
      text: stripFrontMatter(text).trim(),
      file: path,
      ...(raw && { generatedAt: raw.generatedAt }),
      ...(raw?.schedule && { schedule: raw.schedule.label }),
    };
  }

  /**
   * The most recently generated brief of a date, scheduled or manual, with its
   * raw.json. Chat uses this, so a brief:once run from another process counts.
   */
  async latestBrief(date: string): Promise<{ text: string; raw: ArchiveRaw } | null> {
    if (!DATE_DIR.test(date)) return null;
    const dayDir = join(this.dir, date);
    const newestFirst = (await this.rawsOfDay(dayDir)).sort(
      (a, b) =>
        DateTime.fromISO(b.raw.generatedAt).toMillis() -
        DateTime.fromISO(a.raw.generatedAt).toMillis(),
    );
    for (const { suffix, raw } of newestFirst) {
      try {
        const text = await readFile(join(dayDir, `brief${suffix}.md`), 'utf8');
        return { text: stripFrontMatter(text).trim(), raw };
      } catch (error) {
        // raw.json is written first: a write cut short leaves it without its brief.
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  }

  /** The readable raw.json files of a day folder's briefs, in briefFiles order. */
  private async rawsOfDay(dayDir: string): Promise<{ suffix: string; raw: ArchiveRaw }[]> {
    const found: { suffix: string; raw: ArchiveRaw }[] = [];
    for (const { suffix } of await this.briefFiles(dayDir)) {
      const raw = await this.parseRaw(join(dayDir, `raw${suffix}.json`));
      if (raw) found.push({ suffix, raw });
    }
    return found;
  }

  /** A day's briefs: scheduled ones by time (old brief.md first), then manual ones by time. */
  private async briefFiles(dayDir: string): Promise<BriefFile[]> {
    let names: string[];
    try {
      names = await readdir(dayDir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const files = names.flatMap((name) => {
      const match = BRIEF_FILE.exec(name);
      if (!match) return [];
      const [, kind, time, n] = match;
      const file: BriefFile = kind
        ? { suffix: `-${kind}-${time}${n ?? ''}`, kind: kind as BriefKind }
        : { suffix: '', kind: 'scheduled' };
      return [file];
    });
    const rank = (f: BriefFile) => (f.kind === 'scheduled' ? 0 : 1);
    return files.sort(
      (a, b) => rank(a) - rank(b) || a.suffix.localeCompare(b.suffix, 'en', { numeric: true }),
    );
  }

  /**
   * A raw.json, or null when it is missing or unreadable (with one warning).
   * Parsed files are cached by inode, size and mtime, so rereading today's archive
   * for every chat question costs a stat per file.
   */
  private async parseRaw(path: string): Promise<ArchiveRaw | null> {
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    const cached = this.rawCache.get(path);
    const unchanged =
      cached?.ino === info.ino && cached.mtimeMs === info.mtimeMs && cached.size === info.size;
    if (cached && unchanged) return cached.raw;

    let raw: ArchiveRaw | null;
    try {
      raw = JSON.parse(await readFile(path, 'utf8')) as ArchiveRaw;
      if (raw?.version !== 1) throw new Error('不认识的格式');
    } catch (error) {
      if (isNotFound(error)) return null;
      this.logger.warn(`归档文件 ${path} 读取失败，已跳过`, error);
      raw = null;
    }
    this.rawCache.delete(path);
    this.rawCache.set(path, { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size, raw });
    if (this.rawCache.size > RAW_CACHE_SIZE)
      this.rawCache.delete(this.rawCache.keys().next().value!);
    return raw;
  }

  /**
   * Links of news that briefs actually used, scheduled and manual alike: those
   * of `today` so far (a day can have several briefs) and of the `days` days
   * before. Unreadable files are skipped.
   */
  async recentUsedNewsLinks(days: number, today: string): Promise<Set<string>> {
    const links = new Set<string>();
    if (days <= 0) return links;
    const from = DateTime.fromISO(today, { zone: 'utc' }).minus({ days }).toISODate()!;

    for (const date of await this.listDates()) {
      if (date > today || date < from) continue;
      for (const { raw } of await this.rawsOfDay(join(this.dir, date))) {
        const news = raw.news;
        if (!news) continue;
        const used = new Set(news.usedIds);
        for (const item of news.selected) if (used.has(item.id)) links.add(item.link);
      }
    }
    return links;
  }

  /** Deletes date folders older than `retentionDays` before `today`; 0 keeps everything. */
  async prune(retentionDays: number, today: string): Promise<string[]> {
    if (retentionDays <= 0) return [];
    const keepFrom = DateTime.fromISO(today, { zone: 'utc' })
      .minus({ days: retentionDays })
      .toISODate()!;
    const removed: string[] = [];
    for (const date of await this.listDates()) {
      if (date >= keepFrom) continue;
      await rm(join(this.dir, date), { recursive: true, force: true });
      removed.push(date);
    }
    return removed;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
