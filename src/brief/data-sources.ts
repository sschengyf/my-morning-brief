import { DateTime } from 'luxon';
import type { Config } from '#/infra/index.js';
import type { Location } from '#/location/index.js';
import {
  fetchCalendar,
  fetchNews,
  fetchTodos,
  fetchWeather,
  type NewsFetchResult,
  type SourceResult,
  type TodoReadOptions,
  type TodosResult,
} from '#/sources/index.js';

/** The data sources, replaceable in tests. */
export interface Sources {
  weather(location: Location, now: DateTime): Promise<SourceResult<unknown>>;
  calendar(timezone: string, now: DateTime): Promise<SourceResult<unknown>>;
  /** `brief` leaves out todos due later (except the weekly review); chat gets them all. */
  todos(timezone: string, now: DateTime, scope?: 'brief' | 'all'): Promise<TodosResult>;
  news(now: DateTime): Promise<NewsFetchResult>;
}

export function defaultSources(config: Config, todoOptions: TodoReadOptions = {}): Sources {
  return {
    weather: (location, now) => fetchWeather(location, now),
    calendar: (timezone, now) => fetchCalendar(config.calendar.ics_urls, timezone, now),
    todos: (timezone, now, scope) =>
      fetchTodos(config, now.setZone(timezone).toISODate()!, todoOptions, scope),
    news: (now) =>
      fetchNews(
        config.news.feeds,
        { maxItemsPerFeed: config.news.max_items_per_feed, maxAgeHours: config.news.max_age_hours },
        now,
      ),
  };
}
