import type { Command } from '../context.js';
import { parseHistoryDate } from '../parse.js';

const HISTORY_LIST_DAYS = 14;

/** /history lists recent dates; /history 日期 resends that day's brief. */
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
  const stored = await archive.readBrief(date);
  if (!stored) return io.reply(`${date} 没有归档的早报`);
  await io.reply(`📜 ${date} 的早报\n\n${stored.text}`);
};
