import {
  clearLocationOverride,
  searchCity as defaultSearchCity,
  homeLocation,
  setLocationOverride,
  type CityMatch,
  type Location,
} from '../../../location/index.js';
import type { Command } from '../context.js';
import { formatTime, placeName } from '../display.js';
import { nextBriefLine } from '../next-brief.js';
import { cityQueries } from '../parse.js';

export const cityCommand: Command = async (args, io, ctx) => {
  if (!args) {
    return io.reply('用法：/city 城市英文名，例如 /city Shanghai 或 /city Wellington New Zealand');
  }
  const search = ctx.deps.searchCity ?? defaultSearchCity;
  let matches: CityMatch[] = [];
  for (const query of cityQueries(args)) {
    matches = await search(query.name, query.country);
    if (matches.length > 0) break;
  }
  const chosen = matches[0];
  if (!chosen) {
    return io.reply('没找到这个城市，检查一下拼写，或者加上国家，比如 /city Chengdu China');
  }
  await setLocationOverride(ctx.deps.config, chosen);
  ctx.invalidateData();

  const location: Location = { ...chosen, isHome: false };
  const lines = [
    `已切换到 ${placeName(chosen)}，时区 ${chosen.timezone}。${await nextBriefLine(ctx, location)}`,
  ];
  const others = matches
    .slice(1)
    .filter((m) => m.timezone !== chosen.timezone)
    .slice(0, 3);
  if (others.length > 0) {
    lines.push(
      '',
      '同名的其他地方：',
      ...others.map((m) => `- ${placeName(m)}，${m.timezone}`),
      '',
      `不是你要的？用 /city 城市名 国家 指定，例如 /city ${others[0]!.city} ${others[0]!.country ?? ''}`.trimEnd(),
    );
  }
  await io.reply(lines.join('\n'));
};

export const whereCommand: Command = async (_args, io, ctx) => {
  const location = await ctx.location();
  const local = ctx.now().setZone(location.timezone);
  const place = location.isHome ? `${location.city}（家）` : placeName(location);
  await io.reply(
    [
      `当前位置：${place}，时区 ${location.timezone}，当地时间 ${formatTime(local)}。`,
      await nextBriefLine(ctx, location),
      ...(location.isHome ? [] : ['回家后用 /home 恢复。']),
    ].join('\n'),
  );
};

export const homeCommand: Command = async (_args, io, ctx) => {
  await clearLocationOverride(ctx.deps.config);
  ctx.invalidateData();
  const home = homeLocation(ctx.deps.config);
  await io.reply(`已恢复为 ${home.city}，时区 ${home.timezone}。${await nextBriefLine(ctx, home)}`);
};
