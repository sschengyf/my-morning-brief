import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, minimalRawConfig, recordingLogger } from '../../test/helpers.js';
import { Archive } from '#/archive/archive.js';
import type { Sources } from '#/brief/data-sources.js';
import type { BriefRunResult } from '#/brief/run.js';
import type { Channel, ChannelName } from '#/chat/channel.js';
import { parseConfig } from '#/infra/config/parse.js';
import { LlmService } from '#/llm/service.js';
import type { LlmClient } from '#/llm/types.js';
import { saveSchedules } from '#/schedules/store.js';
import type { Schedule } from '#/schedules/types.js';
import { Scheduler } from './scheduler.js';
import { loadState } from './state.js';

/** Tuesday 3 Nov 2026 in Auckland. */
function at(time: string): DateTime {
  return DateTime.fromISO(`2026-11-03T${time}`, { zone: 'Pacific/Auckland' });
}

const MORNING: Schedule = {
  id: 'morning',
  time: '08:00',
  days: 'daily',
  createdAt: '2026-10-01T00:00:00.000+13:00',
};

const sources: Sources = {
  weather: async () => ({ text: '晴', raw: null, ok: true }),
  calendar: async () => ({ text: '今天没有日程', raw: null, ok: true }),
  todos: async () => ({ text: '没有未完成的待办', raw: null, ok: true }),
  news: async () => ({
    items: [
      {
        source: 'RNZ',
        feed: 'https://rnz.test/rss',
        title: 'Story',
        link: 'https://rnz.test/1',
        publishedAt: null,
        summary: 'S',
        titleOnly: false,
      },
    ],
    tooOld: [],
    failures: [],
    ok: true,
  }),
};

function fakeChannel(name: ChannelName) {
  const channel = {
    name,
    ready: true,
    received: [] as string[],
    failing: false,
    start: async () => undefined,
    stop: async () => undefined,
    send: async (text: string) => {
      if (channel.failing) throw new Error(`${name} down`);
      channel.received.push(text);
    },
  };
  return channel satisfies Channel;
}

async function setup(
  options: { schedules?: Schedule[]; replies?: (string | Error)[]; config?: object } = {},
) {
  const dataDir = await makeTempDir();
  const config = parseConfig({
    ...minimalRawConfig(),
    paths: { data_dir: dataDir },
    ...options.config,
  });
  await saveSchedules(dataDir, options.schedules ?? [MORNING]);
  const replies = [...(options.replies ?? [])];
  let modelCalls = 0;
  let gate: Promise<void> | undefined;
  const client: LlmClient = {
    chat: async () => {
      modelCalls++;
      await gate;
      const reply = replies.shift() ?? '早报 [N1]';
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const logger = recordingLogger();
  const errors: string[] = [];
  logger.error = (message: string) => void errors.push(message);
  const archive = new Archive(config.archive.dir, logger);
  let now = at('08:00');
  let briefRunning = false;
  const core = {
    trackBrief: <T>(work: Promise<T>) => work,
    onBrief: vi.fn((_result: BriefRunResult) => undefined),
    isBriefRunning: () => briefRunning,
  };
  const discord = fakeChannel('discord');
  const telegram = fakeChannel('telegram');
  const stopAwake = vi.fn();
  const keepAwake = vi.fn(() => stopAwake);
  const scheduler = new Scheduler({
    brief: {
      config,
      llm: new LlmService(client, config.ollama.num_ctx, logger),
      archive,
      sources,
      logger,
      now: () => now,
    },
    core,
    channels: [discord, telegram],
    logger,
    keepAwake,
  });
  return {
    config,
    archive,
    scheduler,
    core,
    discord,
    telegram,
    errors,
    keepAwake,
    stopAwake,
    modelCalls: () => modelCalls,
    state: () => loadState(dataDir, logger),
    setNow: (time: string) => {
      now = at(time);
    },
    setBriefRunning: (running: boolean) => {
      briefRunning = running;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return release;
    },
  };
}

describe('Scheduler', () => {
  it('sends at the scheduled time to every channel, once a day', async () => {
    const t = await setup();
    t.setNow('07:59');
    await t.scheduler.tick();
    expect(t.discord.received).toEqual([]);

    t.setNow('08:00');
    await t.scheduler.tick();
    expect(t.discord.received).toEqual(['早报 [原文](https://rnz.test/1)']);
    expect(t.telegram.received).toEqual(['早报 [原文](https://rnz.test/1)']);
    expect((await t.state()).sent).toEqual({ morning: '2026-11-03' });
    expect(t.core.onBrief).toHaveBeenCalledTimes(1);
    expect(t.keepAwake).toHaveBeenCalledTimes(1);
    expect(t.stopAwake).toHaveBeenCalledTimes(1);

    t.setNow('08:30');
    await t.scheduler.tick();
    expect(t.discord.received).toHaveLength(1);
    expect(t.modelCalls()).toBe(1);
  });

  it('archives the brief under its schedule and prunes old archives', async () => {
    const t = await setup({ config: { archive: { retention_days: 1 } } });
    const old = (await t.archive.listDates()).length;
    expect(old).toBe(0);
    await t.archive.write({
      date: '2026-10-01',
      raw: {
        version: 1,
        kind: 'manual',
        generatedAt: '2026-10-01T08:00:00.000+13:00',
        location: { city: 'Auckland', timezone: 'Pacific/Auckland', isHome: true },
        model: 'qwen3:32b',
        fallback: false,
        sources: {
          weather: { ok: true, text: '', data: null },
          calendar: { ok: true, text: '', data: null },
          todos: { ok: true, text: '', data: null },
        },
        news: null,
      },
      input: '',
      brief: '旧的',
    });
    await t.scheduler.tick();
    expect(await t.archive.listDates()).toEqual(['2026-11-03']);
    expect((await t.archive.readBrief('2026-11-03'))?.schedule).toBe('08:00 每天');
  });

  it('sends nothing without schedules', async () => {
    const t = await setup({ schedules: [] });
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(0);
  });

  it('waits while a /brief is being made', async () => {
    const t = await setup();
    t.setBriefRunning(true);
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(0);
    t.setBriefRunning(false);
    await t.scheduler.tick();
    expect(t.discord.received).toHaveLength(1);
  });

  it('retries a failing model after 2 and 5 minutes', async () => {
    const t = await setup({ replies: [new Error('Ollama 没启动'), new Error('还没好')] });
    await t.scheduler.tick();
    expect((await t.state()).attempts.morning).toMatchObject({ failures: 1 });
    t.setNow('08:01');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(1); // waiting for the retry
    t.setNow('08:02');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(2);
    t.setNow('08:07');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(3);
    expect(t.discord.received).toEqual(['早报 [原文](https://rnz.test/1)']);
    expect(await t.state()).toMatchObject({ sent: { morning: '2026-11-03' }, attempts: {} });
  });

  it('sends the fallback brief once every retry has failed', async () => {
    const down = () => new Error('Ollama 没启动');
    const t = await setup({ replies: [down(), down(), down(), down()] });
    for (const time of ['08:00', '08:02', '08:07', '08:17']) {
      t.setNow(time);
      await t.scheduler.tick();
    }
    expect(t.modelCalls()).toBe(3);
    expect(t.discord.received).toHaveLength(1);
    expect(t.discord.received[0]).toMatch(/^⚠️ 本地模型暂时不可用/);
    expect((await t.state()).sent).toEqual({ morning: '2026-11-03' });
  });

  it('sends the fallback right away when the next retry would miss the window', async () => {
    const t = await setup({ replies: [new Error('Ollama 没启动')] });
    t.setNow('11:59'); // the window closes at 12:00
    await t.scheduler.tick();
    expect(t.discord.received).toEqual([]);
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(1);
    expect(t.discord.received[0]).toMatch(/^⚠️ 本地模型暂时不可用/);
  });

  it('resends only to the channel that failed, without calling the model again', async () => {
    const t = await setup();
    t.telegram.failing = true;
    await t.scheduler.tick();
    expect(t.discord.received).toHaveLength(1);
    expect((await t.state()).pendingBrief).toMatchObject({ channels: ['telegram'] });
    expect(t.core.onBrief).toHaveBeenCalledTimes(1); // Discord has it, so chat starts from it

    t.telegram.failing = false;
    t.setNow('08:02');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(1);
    expect(t.telegram.received).toEqual(['早报 [原文](https://rnz.test/1)']);
    expect(t.discord.received).toHaveLength(1);
    expect(await t.state()).toMatchObject({ sent: { morning: '2026-11-03' }, pendingBrief: null });
  });

  it('gives up on a brief nobody can receive once the retries are used up', async () => {
    const t = await setup();
    t.discord.failing = true;
    t.telegram.failing = true;
    for (const time of ['08:00', '08:02', '08:07', '08:17']) {
      t.setNow(time);
      await t.scheduler.tick();
    }
    expect(t.modelCalls()).toBe(1);
    expect(await t.state()).toMatchObject({ sent: { morning: '2026-11-03' }, pendingBrief: null });
    expect(t.errors.some((e) => e.includes('重试用完'))).toBe(true);
  });

  it('stops retrying when the window closes', async () => {
    const t = await setup({ replies: [new Error('Ollama 没启动')] });
    t.setNow('11:50');
    await t.scheduler.tick();
    t.setNow('12:30');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(1);
    expect((await t.state()).attempts).toEqual({});
    expect(t.errors.some((e) => e.includes('补发截止时间还没成功'))).toBe(true);
  });

  it('drops a pending resend whose schedule was deleted', async () => {
    const t = await setup();
    t.telegram.failing = true;
    await t.scheduler.tick();
    await saveSchedules(t.config.paths.data_dir, []);
    t.setNow('08:02');
    await t.scheduler.tick();
    expect(t.telegram.received).toEqual([]);
    expect(await t.state()).toMatchObject({ pendingBrief: null, attempts: {}, sent: {} });
  });

  it('on stop, waits for the brief in progress', async () => {
    const t = await setup();
    const release = t.hold();
    const tick = t.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let stopped = false;
    const stop = t.scheduler.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stop]);
    expect(t.discord.received).toHaveLength(1);
    // Stopped: no more checks.
    t.setNow('09:00');
    await t.scheduler.tick();
    expect(t.modelCalls()).toBe(1);
  });
});
