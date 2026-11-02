import type { DateTime } from 'luxon';
import type { Location } from '../location.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export interface GatherInput {
  now: DateTime;
  location: Location;
  weather: string;
  calendar: string;
  todos: string;
  /** Omitted when news is skipped (weekend with weekend_news = false). */
  news?: string;
}

/** Whether to fetch and include news today, in the effective timezone. */
export function includeNews(now: DateTime, location: Location, weekendNews: boolean): boolean {
  return weekendNews || now.setZone(location.timezone).weekday < 6;
}

export function dateLine(now: DateTime, location: Location): string {
  const local = now.setZone(location.timezone);
  const zone = location.isHome ? '' : `（${location.city} 时间）`;
  return `${local.year}年${local.month}月${local.day}日 星期${WEEKDAYS[local.weekday - 1]}，现在 ${local.toFormat('HH:mm')}${zone}`;
}

/**
 * The text the model reads. Each section is wrapped in <数据> tags, which the
 * prompt says to treat as data only. Section contents come from outside
 * (anyone can send a calendar invite), so tags inside them are defused first;
 * otherwise a title containing "</数据>" could end the section early.
 */
export function gatherText(input: GatherInput): string {
  const sections: [string, string][] = [
    ['天气', input.weather],
    ['日程', input.calendar],
    ['待办', input.todos],
  ];
  if (input.news !== undefined) sections.push(['新闻', input.news]);

  return [
    dateLine(input.now, input.location),
    ...sections.map(([type, body]) => `<数据 类型="${type}">\n${defuseTags(body)}\n</数据>`),
  ].join('\n\n');
}

function defuseTags(text: string): string {
  return text.replace(/<(\s*\/?\s*数据)/g, '＜$1');
}
