import { DateTime } from 'luxon';
import { defaultSources, runBrief, type BriefRunResult } from '#/brief/index.js';
import { logger as defaultLogger, type Logger } from '#/infra/index.js';
import { LlmError } from '#/llm/index.js';
import { getEffectiveLocation, type Location } from '#/location/index.js';
import { formatNews, gatherText, type NumberedNews } from '#/sources/index.js';
import type { ChatIO } from '../channel.js';
import { historyCommand } from './commands/history.js';
import { scheduleCommand } from './commands/schedule.js';
import { cityCommand, homeCommand, whereCommand } from './commands/location.js';
import { moreCommand } from './commands/more.js';
import { addCommand, doneCommand, todoCommand, todoLoginCommand } from './commands/todo.js';
import type { ChatDeps, Command, CommandContext } from './context.js';
import { Conversation } from './conversation.js';
import { DayDataCache } from './day-data.js';
import { linksToIds } from './links.js';
import { helpText } from './menu.js';
import { parseCommand } from './parse.js';

/**
 * Everything the bot does, independent of the platform: commands, chat with
 * the model, and the context it answers from. Adapters only check the sender
 * and pass text in; replies come back through ChatIO as Markdown.
 */
export class ChatCore {
  private readonly logger: Logger;
  private readonly clock: () => DateTime;
  private readonly conversation: Conversation;
  private readonly dayData: DayDataCache;
  private readonly ctx: CommandContext;
  private readonly commands: Record<string, Command>;
  private briefInFlight: Promise<unknown> | null = null;
  private readonly handling = new Set<Promise<void>>();

  constructor(private readonly deps: ChatDeps) {
    this.logger = deps.logger ?? defaultLogger;
    this.clock = deps.now ?? (() => DateTime.now());
    this.conversation = new Conversation(deps.archive);
    this.dayData = new DayDataCache(() => deps.sources ?? defaultSources(deps.config));
    this.ctx = {
      deps,
      now: this.clock,
      location: () => this.location(),
      invalidateData: () => this.dayData.invalidate(),
    };
    const help: Command = (_args, io) => io.reply(helpText(deps.config.todo.backend));
    this.commands = {
      start: help,
      help,
      brief: (_args, io) => this.brief(io),
      refresh: (_args, io) => this.refresh(io),
      clear: async (_args, io) => {
        this.conversation.clear();
        await io.reply('对话记忆已清空');
      },
      todo: todoCommand,
      add: addCommand,
      done: doneCommand,
      todo_login: todoLoginCommand,
      history: historyCommand,
      schedule: scheduleCommand,
      city: cityCommand,
      where: whereCommand,
      home: homeCommand,
      more: (args, io) => this.more(args, io),
    };
  }

  /** Loads today's brief from the archive, so a restart can still answer about it. */
  async restore(): Promise<void> {
    await this.conversation.sync(await this.today());
  }

  /** Called after any brief is delivered (scheduled, /brief or brief:once). */
  onBrief(result: BriefRunResult): void {
    this.conversation.startWith(result);
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

  /** Whether a brief (scheduled or /brief) is being made right now. */
  isBriefRunning(): boolean {
    return this.briefInFlight !== null;
  }

  /** Resolves once the messages being handled now, and any brief, are done; for shutdown. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.handling, this.briefInFlight]);
  }

  handle(text: string, io: ChatIO): Promise<void> {
    const work = this.handleNow(text, io);
    this.handling.add(work);
    return work.finally(() => this.handling.delete(work));
  }

  private async handleNow(text: string, io: ChatIO): Promise<void> {
    try {
      const command = parseCommand(text);
      if (!command) return await this.chat(text.trim(), io);
      const run = Object.hasOwn(this.commands, command.name) ? this.commands[command.name]! : null;
      if (!run) return await io.reply('不认识这个命令，发 /help 看看能做什么');
      await run(command.args, io, this.ctx);
    } catch (error) {
      this.logger.error('处理消息失败', error);
      await io.reply(
        `出错了：${error instanceof LlmError ? error.message : '请稍后再试，详情见日志'}`,
      );
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

  /** /more, answered from the news of today's latest brief, like a question. */
  private async more(args: string, io: ChatIO): Promise<void> {
    // One busy notice at most: waiting for a brief already said so.
    let noticed = false;
    const noticeIfBusy = async () => {
      if (noticed) return;
      noticed = true;
      await this.noticeIfBusy(io);
    };
    await moreCommand(args, io, this.deps, {
      // The brief being written may be the one /more picks from.
      news: async () => {
        if (this.briefInFlight) {
          await noticeIfBusy();
          await this.briefInFlight.catch(() => undefined);
        }
        const location = await this.location();
        await this.conversation.sync(this.clock().setZone(location.timezone).toISODate()!);
        return this.conversation.today?.news ?? null;
      },
      noticeIfBusy,
      remember: (question, answer) => this.conversation.add(question, answer),
    });
  }

  private async chat(question: string, io: ChatIO): Promise<void> {
    if (!question) return;
    await this.noticeIfBusy(io);
    const stop = io.typing();
    let reply: string;
    try {
      await this.briefInFlight?.catch(() => undefined);
      const context = await this.context();
      reply = await this.deps.llm.answer(context, this.conversation.history, question);
      this.conversation.add(question, linksToIds(reply, context.news));
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

  /** Today's data plus the news of today's brief, never refetched or reselected. */
  private async context(): Promise<{ text: string; news: NumberedNews[] }> {
    const now = this.clock();
    const location = await this.location();
    const date = now.setZone(location.timezone).toISODate()!;
    await this.conversation.sync(date);
    const data = await this.dayData.get(now, location, date);
    const today = this.conversation.today;
    const news = today?.news ?? [];
    const text = gatherText({
      now,
      location,
      weather: data.weather,
      calendar: data.calendar,
      todos: data.todos,
      news: today ? formatNews(news, []) : '今天的早报还没生成',
    });
    return { text, news };
  }

  private async refresh(io: ChatIO): Promise<void> {
    const now = this.clock();
    const location = await this.location();
    const date = now.setZone(location.timezone).toISODate()!;
    const { ok } = await this.dayData.get(now, location, date, true);
    const mark = (success: boolean | undefined) => (success ? '✓' : '✗ 获取失败');
    await io.reply(
      `已重新获取今天的数据：天气 ${mark(ok?.weather)}，日程 ${mark(ok?.calendar)}，待办 ${mark(ok?.todos)}`,
    );
  }

  private async today(): Promise<string> {
    const location = await this.location();
    return this.clock().setZone(location.timezone).toISODate()!;
  }

  private location(): Promise<Location> {
    return getEffectiveLocation(this.deps.config, this.logger);
  }
}
