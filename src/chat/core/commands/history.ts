import { DateTime } from 'luxon';
import type { StoredBrief } from '../../../archive/index.js';
import type { Command } from '../context.js';
import { parseHistoryDate } from '../parse.js';

const HISTORY_LIST_DAYS = 14;

/** /history lists recent dates; /history 日期 resends that day's briefs. */
export const historyCommand: Command = async (args, io, ctx) => {
  const location = await ctx.location();
  const today = ctx.now().setZone(location.timezone).startOf('day');
  const { archive } = ctx.deps;
  if (!args) {
    const from = today.minus({ days: HISTORY_LIST_DAYS }).toISODate()!;
    const dates = (await archive.listDates()).filter((date) => date >= from);
    if (dates.length === 0) return io.reply(`最近 ${HISTORY_LIST_DAYS} 天没有归档的早报`);
    return io.reply(
      `最近有早报的日期：\n${dates.join('\n')}\n\n用 /history 日期 查看，例如 /history ${dates[0]!.slice(5)}`,
    );
  }
  const date = parseHistoryDate(args, today);
  if (!date) return io.reply('日期格式不对，可以写 2026-11-02、11-02、昨天 或 前天');
  const briefs = await archive.briefsOfDay(date);
  if (briefs.length === 0) return io.reply(`${date} 没有归档的早报`);
  // Several a day are sent one by one, in the order they were made.
  for (const brief of briefs) await io.reply(`${heading(date, brief)}\n\n${brief.text}`);
};

/** "📜 11月2日 08:00 定时早报" / "📜 11月2日 09:30 手动早报" */
function heading(date: string, brief: StoredBrief): string {
  const day = DateTime.fromISO(date);
  const time =
    brief.schedule?.slice(0, 5) ??
    (brief.generatedAt
      ? DateTime.fromISO(brief.generatedAt, { setZone: true }).toFormat('HH:mm')
      : '');
  const kind = brief.kind === 'scheduled' ? '定时早报' : '手动早报';
  return `📜 ${day.month}月${day.day}日 ${time ? `${time} ` : ''}${kind}`;
}
