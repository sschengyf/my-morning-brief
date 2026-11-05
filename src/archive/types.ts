import type { FeedFailure, NewsItem, NumberedNews } from '#/sources/index.js';

export type BriefKind = 'scheduled' | 'manual';

export interface SourceRecord<Data> {
  ok: boolean;
  /** The text the model saw for this source. */
  text: string;
  data: Data;
}

export interface NewsRecord {
  ok: boolean;
  failures: FeedFailure[];
  /** Every item fetched and young enough, before cross-day dedup. */
  candidates: NewsItem[];
  /** Dropped for being older than max_age_hours. */
  tooOld: NewsItem[];
  /** Candidate links dropped because a recent brief already used them. */
  dedupExcluded: string[];
  method: SelectionMethod;
  /** How many round-robin candidates the selection chose from; absent in older archives. */
  poolSize?: number;
  /** What the model saw, with ids. Maps each id to its link. */
  selected: NumberedNews[];
  /** Ids the final brief mentions. */
  usedIds: string[];
}

/** raw.json: the key facts behind one brief, readable without the program. */
export interface ArchiveRaw {
  version: 1;
  kind: BriefKind;
  generatedAt: string;
  location: { city: string; timezone: string; isHome: boolean };
  model: string;
  fallback: boolean;
  sources: {
    weather: SourceRecord<unknown>;
    calendar: SourceRecord<unknown>;
    todos: SourceRecord<unknown>;
  };
  /** Null when news was skipped (weekend with weekend_news = false). */
  news: NewsRecord | null;
  /** The schedule a scheduled brief was sent for; absent for manual briefs. */
  schedule?: ScheduleRef;
}

export interface ScheduleRef {
  id: string;
  /** "HH:MM" */
  time: string;
  /** "08:00 每天" */
  label: string;
}

export interface ArchiveEntry {
  /** Date in the effective timezone, e.g. 2026-11-03. */
  date: string;
  raw: ArchiveRaw;
  /** System prompt plus data, exactly as sent to the model (empty for a fallback brief). */
  input: string;
  /** The brief as sent, links already replaced. */
  brief: string;
}

export interface StoredBrief {
  date: string;
  kind: BriefKind;
  /** The brief without its front matter. */
  text: string;
  file: string;
  /** From raw.json; absent when it is unreadable. */
  generatedAt?: string;
  /** "08:00 每天" for a scheduled brief. */
  schedule?: string;
}

/**
 * model: picked by the model (topped up from the round-robin order if short).
 * round_robin: the model was not asked (few candidates, or a fallback brief).
 * round_robin_fallback: the model failed, so the first round-robin items were used.
 */
export type SelectionMethod = 'model' | 'round_robin' | 'round_robin_fallback';
