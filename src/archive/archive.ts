import { DateTime } from 'luxon';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  logger as defaultLogger,
  isNotFound,
  type Logger,
  writeFileAtomic,
} from '../infra/index.js';
import { frontMatter, stripFrontMatter } from './front-matter.js';
import type { ArchiveEntry, ArchiveRaw, BriefKind, StoredBrief } from './types.js';

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
/** Parsed raw.json files kept in memory; chat checks today's on every question. */
const RAW_CACHE_SIZE = 50;
const MANUAL_BRIEF = /^brief-manual-(\d{6}(?:-\d+)?)\.md$/;

/**
 * Daily folders of plain files, e.g. archive/2026-11-03/brief.md. Scheduled
 * briefs use fixed names; manual ones (/brief, brief:once) carry their time,
 * so they never pass for the scheduled one or overwrite each other.
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
    const suffix =
      entry.raw.kind === 'scheduled' ? '' : await this.freeManualSuffix(dayDir, entry.raw);

    const briefPath = join(dayDir, `brief${suffix}.md`);
    await writeFileAtomic(
      join(dayDir, `raw${suffix}.json`),
      `${JSON.stringify(entry.raw, null, 2)}\n`,
    );
    await writeFileAtomic(join(dayDir, `input${suffix}.txt`), entry.input);
    await writeFileAtomic(briefPath, `${frontMatter(entry.raw)}${entry.brief}\n`);
    return briefPath;
  }

  /** "-manual-093015", or "-manual-093015-2" when that second is taken. */
  private async freeManualSuffix(dayDir: string, raw: ArchiveRaw): Promise<string> {
    const time = DateTime.fromISO(raw.generatedAt, { setZone: true }).toFormat('HHmmss');
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? `-manual-${time}` : `-manual-${time}-${n}`;
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

  /** The scheduled brief of a date, or else that day's latest manual one. */
  async readBrief(date: string): Promise<StoredBrief | null> {
    const found = await this.findFile(date, 'brief', '.md');
    if (!found) return null;
    const text = await readFile(found.path, 'utf8');
    return { date, kind: found.kind, text: stripFrontMatter(text).trim(), file: found.path };
  }

  /** raw.json of the same brief readBrief picks; null if missing or unreadable. */
  async readRaw(date: string): Promise<ArchiveRaw | null> {
    const found = await this.findFile(date, 'raw', '.json');
    if (!found) return null;
    return this.parseRaw(found.path);
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

  /** The readable raw.json files of a day folder: the scheduled one, then manual ones oldest first. */
  private async rawsOfDay(dayDir: string): Promise<{ suffix: string; raw: ArchiveRaw }[]> {
    const found: { suffix: string; raw: ArchiveRaw }[] = [];
    for (const suffix of ['', ...(await this.manualSuffixes(dayDir))]) {
      const raw = await this.parseRaw(join(dayDir, `raw${suffix}.json`));
      if (raw) found.push({ suffix, raw });
    }
    return found;
  }

  private async findFile(
    date: string,
    prefix: 'brief' | 'raw',
    extension: string,
  ): Promise<{ path: string; kind: BriefKind } | null> {
    if (!DATE_DIR.test(date)) return null;
    const dayDir = join(this.dir, date);
    const scheduled = join(dayDir, `${prefix}${extension}`);
    if (await exists(scheduled)) return { path: scheduled, kind: 'scheduled' };

    const latest = (await this.manualSuffixes(dayDir)).at(-1);
    return latest ? { path: join(dayDir, `${prefix}${latest}${extension}`), kind: 'manual' } : null;
  }

  /** Suffixes of the day's manual briefs, oldest first. */
  private async manualSuffixes(dayDir: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(dayDir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return names
      .flatMap((name) => {
        const match = MANUAL_BRIEF.exec(name);
        return match ? [match[1]!] : [];
      })
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((time) => `-manual-${time}`);
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
   * Links of news that briefs from the `days` days before `today` actually
   * used, scheduled and manual alike. Unreadable files are skipped.
   */
  async recentUsedNewsLinks(days: number, today: string): Promise<Set<string>> {
    const links = new Set<string>();
    if (days <= 0) return links;
    const from = DateTime.fromISO(today, { zone: 'utc' }).minus({ days }).toISODate()!;

    for (const date of await this.listDates()) {
      if (date >= today || date < from) continue;
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
