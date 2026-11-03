import { DateTime } from 'luxon';
import type { Config } from '../infra/index.js';
import type { Location } from '../location/index.js';
import {
  fetchCalendar,
  fetchNews,
  fetchTodos,
  fetchWeather,
  type NewsFetchResult,
  type SourceResult,
} from '../sources/index.js';

/** The data sources, replaceable in tests. */
export interface Sources {
  weather(location: Location, now: DateTime): Promise<SourceResult<unknown>>;
  calendar(timezone: string, now: DateTime): Promise<SourceResult<unknown>>;
  todos(): Promise<SourceResult<unknown>>;
  news(now: DateTime): Promise<NewsFetchResult>;
}

export function defaultSources(config: Config): Sources {
  return {
    weather: (location, now) => fetchWeather(location, now),
    calendar: (timezone, now) => fetchCalendar(config.calendar.ics_urls, timezone, now),
    todos: () => fetchTodos(config.todo.file),
    news: (now) =>
      fetchNews(
        config.news.feeds,
        { maxItemsPerFeed: config.news.max_items_per_feed, maxAgeHours: config.news.max_age_hours },
        now,
      ),
  };
}
