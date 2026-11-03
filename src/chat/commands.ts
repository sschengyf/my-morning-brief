import { DateTime } from 'luxon';
import { runBrief, defaultSources, type BriefDeps, type BriefRunResult } from '../brief.js';
import { LlmError, type ChatMessage } from '../llm.js';
import {
  clearLocationOverride,
  getEffectiveLocation,
  homeLocation,
  searchCity as defaultSearchCity,
  setLocationOverride,
  type CityMatch,
  type Location,
} from '../location.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { gatherText } from '../sources/gather.js';
import { formatNews, type NumberedNews } from '../sources/news.js';
import { addTodo, completeTodo, formatTodos, listTodos } from '../sources/todos.js';
import type { ChatIO } from './channel.js';

/** The menu both platforms register. `arg` names the optional/required argument. */
export const COMMANDS = [
  { name: 'brief', description: '立即生成并发送早报' },
  { name: 'todo', description: '列出未完成的待办' },
  {
    name: 'add',
    description: '添加待办',
    arg: { name: 'text', description: '待办内容', required: true },
  },
  {
    name: 'done',
    description: '完成待办',
    arg: { name: 'number', description: '待办序号', required: true },
  },
  { name: 'refresh', description: '重新获取今天的天气、日程和待办' },
  {
    name: 'history',
    description: '查看历史早报',
    arg: { name: 'date', description: '日期，例如 11-02、昨天', required: false },
  },
  {
    name: 'city',
    description: '切换城市（英文名）',
    arg: {
      name: 'name',
      description: '城市名，可以加国家，例如 Wellington New Zealand',
      required: true,
    },
  },
  { name: 'where', description: '当前城市和下次早报时间' },
  { name: 'home', description: '恢复为家里的位置' },
  { name: 'clear', description: '清空对话记忆' },
  { name: 'help', description: '帮助' },
] as const;

export const HELP_TEXT = `我是你的早报助手。每天早上把天气、日程、待办和新闻整理好发给你，有问题可以直接问我。

/brief 立即生成一份早报
/todo 看待办
/add 内容 添加待办
/done 序号 完成待办
/refresh 重新获取今天的天气、日程和待办
/history 最近有早报的日期
/history 11-02 看那天的早报
/city Shanghai 切换城市（英文名，可以加国家，例如 /city Wellington New Zealand）
/where 当前城市和下次早报时间
/home 回到家里的位置
/clear 清空对话记忆

其他文字都会当成问题，比如“今天要带伞吗”“第二条新闻展开讲讲”。`;

const DATA_TTL_MS = 30 * 60 * 1000;
/** Ten rounds of question and answer. */
const MAX_HISTORY = 20;
const HISTORY_LIST_DAYS = 14;

export interface ChatDeps extends BriefDeps {
  searchCity?: (name: string, country?: string) => Promise<CityMatch[]>;
}

interface TodayBrief {
  date: string;
  /** Epoch ms, to tell whether the archive holds a newer brief. */
  generatedAt: number;
  /** The brief with links turned back into ids, as the model wrote it. */
  text: string;
  news: NumberedNews[];
}

interface CachedData {
  key: string;
  at: number;
  weather: string;
  calendar: string;
  todos: string;
}

/**
 * Everything the bot does, independent of the platform: commands, chat with
 * the model, and the context it answers from. Adapters only check the sender
 * and pass text in; replies come back through ChatIO as Markdown.
 */
export class ChatCore {
  private readonly logger: Logger;
  private readonly clock: () => DateTime;
  private today: TodayBrief | null = null;
  private history: ChatMessage[] = [];
  private cache: CachedData | null = null;
  private briefInFlight: Promise<unknown> | null = null;

  constructor(private readonly deps: ChatDeps) {
    this.logger = deps.logger ?? defaultLogger;
    this.clock = deps.now ?? (() => DateTime.now());
  }

  /** Loads today's brief from the archive, so a restart can still answer about it. */
  async restore(): Promise<void> {
    const location = await this.location();
    const date = this.clock().setZone(location.timezone).toISODate()!;
    await this.loadToday(date);
  }

  /** Called after any brief is delivered (scheduled, /brief or brief:once). */
  onBrief(result: BriefRunResult): void {
    if (result.text === undefined) return;
    const text = linksToIds(result.text, result.news);
    const generatedAt = DateTime.fromISO(result.generatedAt).toMillis();
    this.today = { date: result.date, generatedAt, text, news: result.news };
    this.history = [{ role: 'assistant', content: text }];
  }

  /**
   * Marks a brief as running until `work` settles (/brief here; the scheduler
   * in stage 6). Questions asked meanwhile wait for it, so they are answered
   * after the brief arrives and from its news.
   */
  trackBrief<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => {
      if (this.briefInFlight === tracked) this.briefInFlight = null;
    });
    this.briefInFlight = tracked;
    return tracked;
  }

  async handle(text: string, io: ChatIO): Promise<void> {
    try {
      const command = parseCommand(text);
      if (command) await this.command(command.name, command.args, io);
      else await this.chat(text.trim(), io);
    } catch (error) {
      this.logger.error('处理消息失败', error);
      await io.reply(
        `出错了：${error instanceof LlmError ? error.message : '请稍后再试，详情见日志'}`,
      );
    }
  }

  private async command(name: string, args: string, io: ChatIO): Promise<void> {
    switch (name) {
      case 'start':
      case 'help':
        return io.reply(HELP_TEXT);
      case 'brief':
        return this.brief(io);
      case 'todo': {
        const items = await listTodos(this.deps.config.todo.file);
        return io.reply(
          items.length ? `未完成的待办：\n${formatTodos(items)}` : '没有未完成的待办 🎉',
        );
      }
      case 'add': {
        if (!args) return io.reply('用法：/add 待办内容，例如 /add 交水费');
        const item = await addTodo(this.deps.config.todo.file, args);
        this.cache = null;
        return io.reply(`已添加：${item.text}（第 ${item.number} 项）`);
      }
      case 'done': {
        const number = Number(args);
        const done =
          Number.isInteger(number) && number > 0
            ? await completeTodo(this.deps.config.todo.file, number)
            : null;
        if (done === null) return io.reply('没有这个序号，先用 /todo 看看列表');
        this.cache = null;
        return io.reply(`已完成：${done}`);
      }
      case 'refresh':
        return this.refresh(io);
      case 'history':
        return this.historyCommand(args, io);
      case 'city':
        return this.city(args, io);
      case 'where':
        return io.reply(await this.where());
      case 'home': {
        await clearLocationOverride(this.deps.config);
        this.cache = null;
        const home = homeLocation(this.deps.config);
        return io.reply(
          `已恢复为 ${home.city}，时区 ${home.timezone}。下次早报：${this.nextBriefText(home)}。`,
        );
      }
      case 'clear':
        this.history = this.today ? [{ role: 'assistant', content: this.today.text }] : [];
        return io.reply('对话记忆已清空');
      default:
        return io.reply('不认识这个命令，发 /help 看看能做什么');
    }
  }

  private async brief(io: ChatIO): Promise<void> {
    // A second brief right now would only repeat the first, and both would be archived.
    if (this.briefInFlight) {
      await io.reply('早报正在生成，好了会发到发起的那个对话里');
      return;
    }
    await this.noticeIfBusy(io);
    const stop = io.typing();
    let result: BriefRunResult;
    try {
      result = await this.trackBrief(
        runBrief({ kind: 'manual', archive: true, send: (text) => io.reply(text) }, this.deps),
      );
    } finally {
      stop();
    }
    if (result.status === 'llm_failed') {
      const reason = result.error instanceof LlmError ? result.error.message : '详情见日志';
      await io.reply(`早报生成失败：${reason}`);
      return;
    }
    if (result.status === 'sent') this.onBrief(result);
  }

  private async chat(question: string, io: ChatIO): Promise<void> {
    if (!question) return;
    await this.noticeIfBusy(io);
    const stop = io.typing();
    let reply: string;
    try {
      await this.briefInFlight?.catch(() => undefined);
      const context = await this.context();
      reply = await this.deps.llm.answer(context, this.history, question);
      this.history.push(
        { role: 'user', content: question },
        { role: 'assistant', content: linksToIds(reply, context.news) },
      );
      this.trimHistory();
    } finally {
      stop();
    }
    await io.reply(reply);
  }

  private async noticeIfBusy(io: ChatIO): Promise<void> {
    if (!this.briefInFlight && !this.deps.llm.isBusy()) return;
    await io.reply(
      this.briefInFlight || this.deps.llm.currentTask() === 'brief'
        ? '正在生成早报，稍后回复你'
        : '上一个问题还在处理，稍等',
    );
  }

  /** Keeps the brief that opened the conversation, plus the latest rounds. */
  private trimHistory(): void {
    const pinned = this.today && this.history[0]?.content === this.today.text ? 1 : 0;
    const rest = this.history.slice(pinned);
    if (rest.length > MAX_HISTORY) {
      this.history = [...this.history.slice(0, pinned), ...rest.slice(-MAX_HISTORY)];
    }
  }

  /** Today's data plus the news of today's brief, never refetched or reselected. */
  private async context(): Promise<{ text: string; news: NumberedNews[] }> {
    const now = this.clock();
    const location = await this.location();
    const date = now.setZone(location.timezone).toISODate()!;
    await this.loadToday(date);
    const data = await this.data(now, location, date);
    const news = this.today?.news ?? [];
    const text = gatherText({
      now,
      location,
      weather: data.weather,
      calendar: data.calendar,
      todos: data.todos,
      news: this.today ? formatNews(news, []) : '今天的早报还没生成',
    });
    return { text, news };
  }

  private async data(now: DateTime, location: Location, date: string, force = false) {
    const key = `${location.timezone}|${location.latitude},${location.longitude}|${date}`;
    const cached = this.cache;
    if (!force && cached?.key === key && now.toMillis() - cached.at < DATA_TTL_MS) {
      return { ...cached, ok: null };
    }
    const sources = this.deps.sources ?? defaultSources(this.deps.config);
    const [weather, calendar, todos] = await Promise.all([
      sources.weather(location, now),
      sources.calendar(location.timezone, now),
      sources.todos(),
    ]);
    this.cache = {
      key,
      at: now.toMillis(),
      weather: weather.text,
      calendar: calendar.text,
      todos: todos.text,
    };
    return { ...this.cache, ok: { weather: weather.ok, calendar: calendar.ok, todos: todos.ok } };
  }

  private async refresh(io: ChatIO): Promise<void> {
    const now = this.clock();
    const location = await this.location();
    const date = now.setZone(location.timezone).toISODate()!;
    const result = await this.data(now, location, date, true);
    const mark = (ok: boolean | undefined) => (ok ? '✓' : '✗ 获取失败');
    await io.reply(
      `已重新获取今天的数据：天气 ${mark(result.ok?.weather)}，日程 ${mark(result.ok?.calendar)}，待办 ${mark(result.ok?.todos)}`,
    );
  }

  /**
   * Makes `today` the latest brief of `date`: keeps the one in memory unless
   * the archive has a newer one (brief:once runs in another process), and
   * drops it once the date has moved on.
   */
  private async loadToday(date: string): Promise<void> {
    const stored = await this.deps.archive.latestBrief(date);
    const current = this.today?.date === date ? this.today : null;
    const storedAt = stored ? DateTime.fromISO(stored.raw.generatedAt).toMillis() : -Infinity;
    if (!stored || (current && current.generatedAt >= storedAt)) {
      this.today = current;
      return;
    }
    const news = stored.raw.news?.selected ?? [];
    const text = linksToIds(stored.text, news);
    this.today = { date, generatedAt: storedAt, text, news };
    if (this.history[0]?.content !== text) this.history = [{ role: 'assistant', content: text }];
  }

  private async historyCommand(args: string, io: ChatIO): Promise<void> {
    const location = await this.location();
    const today = this.clock().setZone(location.timezone).startOf('day');
    const { archive } = this.deps;
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
    return io.reply(`📜 ${date} 的早报\n\n${stored.text}`);
  }

  private async city(args: string, io: ChatIO): Promise<void> {
    if (!args)
      return io.reply(
        '用法：/city 城市英文名，例如 /city Shanghai 或 /city Wellington New Zealand',
      );
    const search = this.deps.searchCity ?? defaultSearchCity;
    let matches: CityMatch[] = [];
    for (const query of cityQueries(args)) {
      matches = await search(query.name, query.country);
      if (matches.length > 0) break;
    }
    const chosen = matches[0];
    if (!chosen) {
      return io.reply('没找到这个城市，检查一下拼写，或者加上国家，比如 /city Chengdu China');
    }
    await setLocationOverride(this.deps.config, chosen);
    this.cache = null;

    const location: Location = { ...chosen, isHome: false };
    const lines = [
      `已切换到 ${placeName(chosen)}，时区 ${chosen.timezone}。下次早报：${this.nextBriefText(location)}。`,
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
    return io.reply(lines.join('\n'));
  }

  private async where(): Promise<string> {
    const location = await this.location();
    const local = this.clock().setZone(location.timezone);
    const place = location.isHome ? `${location.city}（家）` : placeName(location);
    return [
      `当前位置：${place}，时区 ${location.timezone}，当地时间 ${formatTime(local)}。`,
      `下次早报：${this.nextBriefText(location)}。`,
      ...(location.isHome ? [] : ['回家后用 /home 恢复。']),
    ].join('\n');
  }

  /** "当地时间 11月3日 08:00（Auckland 时间 11月3日 13:00）" */
  private nextBriefText(location: Location): string {
    const next = nextBriefTime(this.clock(), location.timezone, this.deps.config.brief.time);
    const home = homeLocation(this.deps.config);
    if (location.timezone === home.timezone) return `当地时间 ${formatTime(next)}`;
    return `当地时间 ${formatTime(next)}（${home.city} 时间 ${formatTime(next.setZone(home.timezone))}）`;
  }

  private location(): Promise<Location> {
    return getEffectiveLocation(this.deps.config, this.logger);
  }
}

/** "/add@MyBot buy milk" → { name: 'add', args: 'buy milk' } */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() } : null;
}

/**
 * Ways to read "/city" arguments, most likely first. "Los Angeles, United
 * States" is explicit; otherwise "Wellington New Zealand" is tried as one
 * name, then with the trailing words as the country.
 */
export function cityQueries(args: string): { name: string; country?: string }[] {
  const comma = args.indexOf(',');
  if (comma >= 0) {
    const name = args.slice(0, comma).trim();
    const country = args.slice(comma + 1).trim();
    return [{ name, ...(country && { country }) }];
  }
  const words = args.trim().split(/\s+/).slice(0, 6);
  const queries = [];
  for (let k = words.length; k >= 1; k--) {
    const country = words.slice(k).join(' ');
    queries.push({ name: words.slice(0, k).join(' '), ...(country && { country }) });
  }
  return queries;
}

/** "Wellington（Wellington Region, New Zealand）"; empty parts and a region equal to the city are skipped. */
export function placeName(match: { city: string; region?: string; country?: string }): string {
  const parts = [match.region !== match.city ? match.region : undefined, match.country].filter(
    (part): part is string => !!part,
  );
  return parts.length ? `${match.city}（${parts.join(', ')}）` : match.city;
}

/** The next brief.time in `timezone` after `now` (today's if it is still ahead). */
export function nextBriefTime(now: DateTime, timezone: string, time: string): DateTime {
  const [hour, minute] = time.split(':').map(Number);
  const local = now.setZone(timezone);
  const today = local.set({ hour, minute, second: 0, millisecond: 0 });
  return today > local ? today : today.plus({ days: 1 });
}

function formatTime(time: DateTime): string {
  return `${time.month}月${time.day}日 ${time.toFormat('HH:mm')}`;
}

/** 2026-11-02, 11-02, 11/2, 昨天, 前天, 今天 → ISO date; null when unreadable. */
export function parseHistoryDate(text: string, today: DateTime): string | null {
  const relative: Record<string, number> = { 今天: 0, 昨天: 1, 前天: 2 };
  const trimmed = text.trim();
  if (Object.hasOwn(relative, trimmed))
    return today.minus({ days: relative[trimmed]! }).toISODate();

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (match) {
    const date = DateTime.fromObject(
      { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
      { zone: 'utc' },
    );
    return date.isValid ? date.toISODate() : null;
  }
  match = /^(\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (match) {
    let date = DateTime.fromObject(
      { year: today.year, month: Number(match[1]), day: Number(match[2]) },
      { zone: 'utc' },
    );
    if (!date.isValid) return null;
    // A date later this year has not happened yet; mean last year's.
    if (date.toISODate()! > today.toISODate()!) date = date.minus({ years: 1 });
    return date.toISODate();
  }
  return null;
}

/**
 * Turns "[原文](link)" back into "[N2]" for the conversation history, so the
 * model sees its own ids rather than links it was told never to write.
 */
export function linksToIds(text: string, news: NumberedNews[]): string {
  const ids = new Map(news.map((item) => [item.link, item.id]));
  return text.replace(/\[原文\]\(<?([^)\s>]+)>?\)/g, (whole, link: string) => {
    const id = ids.get(link);
    return id ? `[${id}]` : whole;
  });
}
