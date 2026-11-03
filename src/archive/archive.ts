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
const MANUAL_BRIEF = /^brief-manual-(\d{6}(?:-\d+)?)\.md$/;

/**
 * Daily folders of plain files, e.g. archive/2026-11-03/brief.md. Scheduled
 * briefs use fixed names; manual ones (/brief, brief:once) carry their time,
 * so they never pass for the scheduled one or overwrite each other.
 */
export class Archive {
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
    let latest: { suffix: string; raw: ArchiveRaw; at: number } | null = null;
    for (const suffix of ['', ...(await this.manualSuffixes(dayDir))]) {
      const path = join(dayDir, `raw${suffix}.json`);
      if (!(await exists(path))) continue;
      const raw = await this.parseRaw(path);
      if (!raw) continue;
      const at = DateTime.fromISO(raw.generatedAt).toMillis();
      if (!latest || at > latest.at) latest = { suffix, raw, at };
    }
    if (!latest) return null;
    try {
      const text = await readFile(join(dayDir, `brief${latest.suffix}.md`), 'utf8');
      return { text: stripFrontMatter(text).trim(), raw: latest.raw };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
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

  private async parseRaw(path: string): Promise<ArchiveRaw | null> {
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as ArchiveRaw;
      if (raw?.version !== 1) throw new Error('不认识的格式');
      return raw;
    } catch (error) {
      this.logger.warn(`归档文件 ${path} 读取失败，已跳过`, error);
      return null;
    }
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
      const dayDir = join(this.dir, date);
      const suffixes = ['', ...(await this.manualSuffixes(dayDir))];
      for (const suffix of suffixes) {
        const path = join(dayDir, `raw${suffix}.json`);
        if (!(await exists(path))) continue;
        const raw = await this.parseRaw(path);
        const news = raw?.news;
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
