// Public API of sources/: other modules import from here, never from its files.
export { fetchCalendar } from './calendar/fetch.js';
export { describeError } from './common.js';
export type { SourceResult } from './common.js';
export { dateLine, gatherText, includeNews, wrapData } from './gather.js';
export type { GatherInput } from './gather.js';
export { fetchNews } from './news/fetch.js';
export { formatNews, numberNews } from './news/format.js';
export type {
  FeedFailure,
  FeedSource,
  NewsFetchResult,
  NewsItem,
  NumberedNews,
} from './news/types.js';
export { fetchTodos, formatTodos } from './todos/source.js';
export { addTodo, completeTodo, listTodos } from './todos/store.js';
export { fetchWeather } from './weather/fetch.js';
