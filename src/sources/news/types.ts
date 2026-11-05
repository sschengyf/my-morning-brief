export interface FeedSource {
  url: string;
  /** Shown instead of the feed's own title. */
  name?: string;
}

export interface NewsItem {
  /** The name shown for the feed: its configured name, else its title. */
  source: string;
  /** The feed's URL; several feeds may share a name, so selection groups by this. */
  feed: string;
  title: string;
  link: string;
  /** ISO date-time, or null when the feed gives none. */
  publishedAt: string | null;
  summary: string;
  /** The feed carried no usable summary (e.g. hnrss), so the model only gets the title. */
  titleOnly: boolean;
}

export interface FeedFailure {
  source: string;
  reason: string;
}

export interface NewsFetchResult {
  items: NewsItem[];
  /** Dropped for being older than max_age_hours; kept for the archive. */
  tooOld: NewsItem[];
  failures: FeedFailure[];
  /** False only when every feed failed. */
  ok: boolean;
}

export interface NewsOptions {
  maxItemsPerFeed: number;
  maxAgeHours: number;
}

export interface NumberedNews extends NewsItem {
  id: string;
}
