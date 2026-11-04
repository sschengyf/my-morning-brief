import {
  describeSchedule,
  loadSchedules,
  newSchedule,
  parseDays,
  parseTime,
  rejectNew,
  saveSchedules,
  sortSchedules,
  type Schedule,
} from '../../../schedules/index.js';
import type { Command, CommandContext } from '../context.js';
import { NO_SCHEDULES, nextBriefLine, SCHEDULE_PROMPT } from '../next-brief.js';

const USAGE = [
  '用法：',
  '/schedule 看所有定时',
  '/schedule add 08:00 添加（可以加“工作日”或“周末”，例如 /schedule add 07:30 工作日）',
  '/schedule remove 2 删除第 2 个（可以一次删几个，例如 /schedule remove 1 3）',
  '/schedule clear 删除全部定时',
].join('\n');

/** /schedule [add 时间 [每天|工作日|周末] | remove 序号… | clear] */
export const scheduleCommand: Command = async (args, io, ctx) => {
  const [action = '', ...rest] = args.split(/\s+/).filter(Boolean);
  const dataDir = ctx.deps.config.paths.data_dir;
  const loaded = await loadSchedules(dataDir, ctx.deps.logger);
  const current = sortSchedules(loaded.schedules ?? []);

  switch (action.toLowerCase()) {
    case '':
      return io.reply(await listing(ctx, current, loaded.schedules === null, loaded.corruptBackup));
    case 'add': {
      const [timeText, daysText, ...extra] = rest;
      const time = timeText ? parseTime(timeText) : null;
      if (!time || extra.length > 0) {
        return io.reply('时间格式不对，例如 /schedule add 08:00 或 /schedule add 07:30 工作日');
      }
      const days = parseDays(daysText);
      if (!days)
        return io.reply('最后一项可以是 每天、工作日 或 周末，例如 /schedule add 07:30 工作日');
      const rejected = rejectNew(current, time, days);
      if (rejected) return io.reply(`没有添加：${rejected}。`);
      const location = await ctx.location();
      const added = newSchedule(time, days, ctx.now(), location.timezone);
      const next = sortSchedules([...current, added]);
      await saveSchedules(dataDir, next);
      return io.reply(`已添加 ${describeSchedule(added)}。\n\n${await listing(ctx, next, false)}`);
    }
    case 'remove':
    case 'delete': {
      const numbers = rest.map(Number);
      const invalid = rest.filter(
        (_, i) => !Number.isInteger(numbers[i]) || numbers[i]! < 1 || numbers[i]! > current.length,
      );
      if (rest.length === 0 || invalid.length > 0) {
        const which =
          invalid.length > 0
            ? `没有第 ${invalid.join('、')} 个定时`
            : '要写删第几个，例如 /schedule remove 2';
        return io.reply(`${which}，先用 /schedule 看看列表。`);
      }
      const removed = current.filter((_, i) => numbers.includes(i + 1));
      const kept = current.filter((_, i) => !numbers.includes(i + 1));
      await saveSchedules(dataDir, kept);
      const names = removed.map(describeSchedule).join('、');
      return io.reply(`已删除 ${names}。\n\n${await listing(ctx, kept, false)}`);
    }
    case 'clear':
      await saveSchedules(dataDir, []);
      return io.reply('已删除全部定时。现在没有定时早报了，用 /schedule add 08:00 添加。');
    default:
      return io.reply(USAGE);
  }
};

async function listing(
  ctx: CommandContext,
  schedules: Schedule[],
  neverSet: boolean,
  corruptBackup?: string,
): Promise<string> {
  const notice = corruptBackup
    ? `⚠️ schedules.json 内容有误，已备份为 ${corruptBackup}，在重新设置之前不发定时早报。\n\n`
    : '';
  if (neverSet) return notice + SCHEDULE_PROMPT;
  if (schedules.length === 0) return notice + NO_SCHEDULES;
  const location = await ctx.location();
  const lines = schedules.map((s, i) => `${i + 1}. ${describeSchedule(s)}`);
  return `${notice}定时早报（${location.city} 时间）：\n${lines.join('\n')}\n\n${await nextBriefLine(ctx, location)}`;
}
