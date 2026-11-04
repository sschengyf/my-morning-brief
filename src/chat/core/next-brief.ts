import { homeLocation, type Location } from '#/location/index.js';
import { loadSchedules, nextOccurrence } from '#/schedules/index.js';
import type { CommandContext } from './context.js';
import { formatTime } from './display.js';

export const SCHEDULE_PROMPT =
  '还没有设置定时早报。用 /schedule add 08:00 设置一个，也可以加上“工作日”或“周末”，例如 /schedule add 07:30 工作日。';
export const NO_SCHEDULES = '现在没有定时早报，用 /schedule add 08:00 添加。';

/**
 * "下次早报：当地时间 11月3日 08:00（Auckland 时间 11月3日 13:00）。", or why
 * there is none. `location` defaults to the effective one; /city passes the new one.
 */
export async function nextBriefLine(ctx: CommandContext, location?: Location): Promise<string> {
  const where = location ?? (await ctx.location());
  const { schedules } = await loadSchedules(ctx.deps.config.paths.data_dir, ctx.deps.logger);
  if (schedules === null) return SCHEDULE_PROMPT;
  const next = nextOccurrence(ctx.now(), where.timezone, schedules);
  if (!next) return NO_SCHEDULES;
  const home = homeLocation(ctx.deps.config);
  const local = `当地时间 ${formatTime(next.at)}`;
  if (where.timezone === home.timezone) return `下次早报：${local}。`;
  return `下次早报：${local}（${home.city} 时间 ${formatTime(next.at.setZone(home.timezone))}）。`;
}
