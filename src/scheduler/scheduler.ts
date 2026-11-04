import { DateTime } from 'luxon';
import { type BriefDeps, type BriefRunResult, runBrief } from '#/brief/index.js';
import {
  type Channel,
  type ChannelName,
  type ChatCore,
  SendError,
  sendToChannels,
} from '#/chat/index.js';
import { logger as defaultLogger, type Logger } from '#/infra/index.js';
import { getEffectiveLocation } from '#/location/index.js';
import {
  describeSchedule,
  dueSchedule,
  loadSchedules,
  type Schedule,
  type ScheduleWindow,
  windowsOn,
} from '#/schedules/index.js';
import { keepAwake as defaultKeepAwake } from './keep-awake.js';
import { loadState, type PendingBrief, saveState, type State } from './state.js';

const CHECK_EVERY_MS = 30_000;

export interface SchedulerDeps {
  /** Brief inputs: config, model, archive (and fakes in tests). */
  brief: BriefDeps;
  /** Tracks the brief so chat waits for it, and starts the conversation from it. */
  core: Pick<ChatCore, 'trackBrief' | 'onBrief' | 'isBriefRunning'>;
  /** The ready channels; briefs go to all of them. */
  channels: Channel[];
  logger?: Logger;
  keepAwake?: () => () => void;
  checkEveryMs?: number;
}

/**
 * Sends scheduled briefs. Polls instead of using cron, since cron misses
 * runs while a Mac sleeps; each check rereads the location, the schedules
 * and state.json, so /city and /schedule apply at once and restarts never
 * send twice.
 */
export class Scheduler {
  private readonly logger: Logger;
  private readonly clock: () => DateTime;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.logger = deps.logger ?? deps.brief.logger ?? defaultLogger;
    this.clock = deps.brief.now ?? (() => DateTime.now());
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.deps.checkEveryMs ?? CHECK_EVERY_MS);
    void this.tick();
  }

  /** Stops checking and waits for a brief in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** One check; never overlaps another. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = this.check()
      .catch((error: unknown) => this.logger.error('定时检查出错', error))
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }

  private async check(): Promise<void> {
    const { config } = this.deps.brief;
    const dataDir = config.paths.data_dir;
    const now = this.clock();
    const location = await getEffectiveLocation(config, this.logger);
    const schedules = (await loadSchedules(dataDir, this.logger)).schedules ?? [];
    const loaded = await loadState(dataDir, this.logger);
    const state = this.tidy(loaded, schedules, now.setZone(location.timezone));
    if (JSON.stringify(state) !== JSON.stringify(loaded)) await saveState(dataDir, state);

    // A /brief in progress: check again once it is done.
    if (this.deps.core.isBriefRunning()) return;
    const retryAt = Object.fromEntries(
      Object.entries(state.attempts).map(([id, attempt]) => [id, attempt.nextRetryAt]),
    );
    const window = dueSchedule({
      now,
      timezone: location.timezone,
      schedules,
      catchUpHours: config.brief.catch_up_hours,
      sent: state.sent,
      retryAt,
    });
    if (window) await this.run(window, state);
  }

  /**
   * Drops bookkeeping that no longer applies: other days, deleted schedules,
   * and retries whose window has closed (logged once, as the brief is lost).
   */
  private tidy(state: State, schedules: Schedule[], now: DateTime): State {
    const today = now.toISODate()!;
    const ids = new Set(schedules.map((s) => s.id));
    const windows = windowsOn(now, schedules, this.deps.brief.config.brief.catch_up_hours);
    const open = new Map(windows.map((w) => [w.schedule.id, w]));
    const attempts: State['attempts'] = {};
    for (const [id, attempt] of Object.entries(state.attempts)) {
      if (attempt.date !== today || !ids.has(id)) continue;
      const window = open.get(id);
      if (!window) continue; // no longer applies today (its days were changed)
      if (now >= window.end) {
        this.logger.error(
          `${describeSchedule(window.schedule)} 的早报到补发截止时间还没成功，今天不再重试`,
        );
        continue;
      }
      attempts[id] = attempt;
    }
    const pending = state.pendingBrief;
    const pendingBrief =
      pending && pending.date === today && attempts[pending.scheduleId] ? pending : null;
    const sent = Object.fromEntries(Object.entries(state.sent).filter(([id]) => ids.has(id)));
    return { ...state, sent, attempts, pendingBrief };
  }

  private async run(window: ScheduleWindow, state: State): Promise<void> {
    const { schedule, date } = window;
    const stopKeepingAwake = (this.deps.keepAwake ?? (() => defaultKeepAwake(this.logger)))();
    try {
      const pending =
        state.pendingBrief?.scheduleId === schedule.id && state.pendingBrief.date === date
          ? state.pendingBrief
          : null;
      if (pending) return await this.resend(window, state, pending);

      const failures = state.attempts[schedule.id]?.failures ?? 0;
      const retries = this.deps.brief.config.brief.retry_minutes.length;
      // Every retry used up: send the data without the model, so the day still gets something.
      const fallback = failures >= retries;
      this.logger.info(
        `开始生成 ${describeSchedule(schedule)} 的定时早报${fallback ? '（降级，不经过模型）' : ''}`,
      );
      const result = await this.deps.core.trackBrief(
        runBrief(
          {
            kind: 'scheduled',
            archive: true,
            fallback,
            schedule: { id: schedule.id, time: schedule.time, label: describeSchedule(schedule) },
            send: (text) => sendToChannels(this.deps.channels, text, this.logger),
          },
          this.deps.brief,
        ),
      );
      await this.afterRun(window, state, result);
    } finally {
      stopKeepingAwake();
    }
  }

  private async afterRun(window: ScheduleWindow, state: State, result: BriefRunResult) {
    if (result.status === 'sent') {
      this.deps.core.onBrief(result);
      return this.markSent(window, state);
    }
    if (result.status === 'llm_failed') return this.failed(window, state, null);

    // send_failed: keep the brief and resend it only where it did not arrive.
    const failedChannels = channelsFrom(result.error, this.deps.channels);
    if (failedChannels.length < this.deps.channels.length) this.deps.core.onBrief(result);
    return this.failed(window, state, {
      date: window.date,
      scheduleId: window.schedule.id,
      text: result.text!,
      channels: failedChannels,
    });
  }

  private async resend(window: ScheduleWindow, state: State, pending: PendingBrief) {
    const targets = this.deps.channels.filter((c) => pending.channels.includes(c.name));
    this.logger.info(
      `重发 ${describeSchedule(window.schedule)} 的早报到 ${pending.channels.join('、')}`,
    );
    try {
      await this.deps.core.trackBrief(sendToChannels(targets, pending.text, this.logger));
      return this.markSent(window, state);
    } catch (error) {
      return this.failed(window, state, { ...pending, channels: channelsFrom(error, targets) });
    }
  }

  private async markSent(window: ScheduleWindow, state: State): Promise<void> {
    const { config, archive } = this.deps.brief;
    const attempts = { ...state.attempts };
    delete attempts[window.schedule.id];
    await saveState(config.paths.data_dir, {
      ...state,
      sent: { ...state.sent, [window.schedule.id]: window.date },
      attempts,
      pendingBrief: null,
    });
    this.logger.info(`${describeSchedule(window.schedule)} 的定时早报已发送`);
    const removed = await archive
      .prune(config.archive.retention_days, window.date)
      .catch((error: unknown) => {
        this.logger.warn('清理过期归档失败', error);
        return [];
      });
    if (removed.length > 0) this.logger.info(`清理了 ${removed.length} 天的过期归档`);
  }

  /**
   * Counts a failed try and schedules the next. A brief that was made but not
   * delivered is kept for resending; once the retries are used up it is given
   * up (there is no way to tell the user). A model failure ends in the
   * fallback brief instead, sent right away if the next retry would miss the
   * window.
   */
  private async failed(window: ScheduleWindow, state: State, pending: PendingBrief | null) {
    const { config } = this.deps.brief;
    const retryMinutes = config.brief.retry_minutes;
    const id = window.schedule.id;
    const failures = (state.attempts[id]?.failures ?? 0) + 1;
    const now = this.clock();

    if (pending && failures > retryMinutes.length) {
      this.logger.error(
        `${describeSchedule(window.schedule)} 的早报重试用完，${pending.channels.join('、')} 仍然没有收到`,
      );
      return this.markSent(window, { ...state, pendingBrief: null });
    }
    let nextRetryAt = now.plus({ minutes: retryMinutes[failures - 1] ?? 0 });
    let counted = failures;
    if (!pending && nextRetryAt >= window.end) {
      // No time left to retry the model: go straight to the fallback brief.
      nextRetryAt = now;
      counted = retryMinutes.length;
    }
    this.logger.warn(
      `${describeSchedule(window.schedule)} 的早报第 ${failures} 次失败，${nextRetryAt <= now ? '马上' : nextRetryAt.setZone(window.start.zone).toFormat('HH:mm')} 重试`,
    );
    await saveState(config.paths.data_dir, {
      ...state,
      attempts: {
        ...state.attempts,
        [id]: { date: window.date, failures: counted, nextRetryAt: nextRetryAt.toISO()! },
      },
      pendingBrief: pending,
    });
  }
}

/** The channels a SendError names; all of them for any other error. */
function channelsFrom(error: unknown, channels: Channel[]): ChannelName[] {
  return error instanceof SendError ? error.failed : channels.map((c) => c.name);
}
