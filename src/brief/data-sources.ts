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
} from '#/sources/index.js';

/** The data sources, replaceable in tests. */
export interface Sources {
  weather(location: Location, now: DateTime): Promise<SourceResult<unknown>>;
  calendar(timezone: string, now: DateTime): Promise<SourceResult<unknown>>;
  todos(timezone: string, now: DateTime): Promise<SourceResult<unknown>>;
  news(now: DateTime): Promise<NewsFetchResult>;
}

export function defaultSources(config: Config, todoOptions: TodoReadOptions = {}): Sources {
  return {
    weather: (location, now) => fetchWeather(location, now),
    calendar: (timezone, now) => fetchCalendar(config.calendar.ics_urls, timezone, now),
    todos: (timezone, now) => fetchTodos(config, now.setZone(timezone).toISODate()!, todoOptions),
    news: (now) =>
      fetchNews(
        config.news.feeds,
        { maxItemsPerFeed: config.news.max_items_per_feed, maxAgeHours: config.news.max_age_hours },
        now,
      ),
  };
}
