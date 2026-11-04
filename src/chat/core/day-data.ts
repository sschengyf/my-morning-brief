import type { DateTime } from 'luxon';
import type { Sources } from '#/brief/index.js';
import type { Location } from '#/location/index.js';

const DATA_TTL_MS = 30 * 60 * 1000;

export interface DayData {
  weather: string;
  calendar: string;
  todos: string;
  /** Which sources succeeded; null when served from the cache. */
  ok: { weather: boolean; calendar: boolean; todos: boolean } | null;
}

/**
 * Today's weather, calendar and todos for chat, cached for 30 minutes. The key
 * holds the timezone, coordinates and date, so midnight or a city switch
 * fetches fresh data on its own.
 */
export class DayDataCache {
  private cached: { key: string; at: number; data: DayData } | null = null;

  constructor(private readonly sources: () => Sources) {}

  async get(now: DateTime, location: Location, date: string, force = false): Promise<DayData> {
    const key = `${location.timezone}|${location.latitude},${location.longitude}|${date}`;
    const cached = this.cached;
    if (!force && cached?.key === key && now.toMillis() - cached.at < DATA_TTL_MS) {
      return { ...cached.data, ok: null };
    }
    const sources = this.sources();
    const [weather, calendar, todos] = await Promise.all([
      sources.weather(location, now),
      sources.calendar(location.timezone, now),
      sources.todos(),
    ]);
    const data: DayData = {
      weather: weather.text,
      calendar: calendar.text,
      todos: todos.text,
      ok: { weather: weather.ok, calendar: calendar.ok, todos: todos.ok },
    };
    this.cached = { key, at: now.toMillis(), data };
    return data;
  }

  invalidate(): void {
    this.cached = null;
  }
}
