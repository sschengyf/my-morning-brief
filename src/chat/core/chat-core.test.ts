import { DateTime } from 'luxon';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeTempDir,
  minimalRawConfig,
  readFixture,
  recordingLogger,
} from '../../../test/helpers.js';
import { Archive } from '#/archive/archive.js';
import type { Sources } from '#/brief/data-sources.js';
import { runBrief } from '#/brief/run.js';
import { parseConfig } from '#/infra/config/parse.js';
import { LlmService } from '#/llm/service.js';
import type { ChatMessage, LlmClient } from '#/llm/types.js';
import { searchCity } from '#/location/geocoding.js';
import type { NewsItem } from '#/sources/news/types.js';
import type { ChatIO } from '../channel.js';
import { saveSchedules } from '#/schedules/store.js';
import type { Schedule } from '#/schedules/types.js';
import { ChatCore } from './chat-core.js';

// Tuesday 3 Nov 2026, 10:00 in Auckland.
const NOW = DateTime.fromISO('2026-11-02T21:00:00Z');

const wellington = JSON.parse(await readFixture('geocoding-wellington.json')) as unknown;

const SHANGHAI = {
  results: [
    {
      name: 'Shanghai',
      latitude: 31.22,
      longitude: 121.46,
      timezone: 'Asia/Shanghai',
      country: 'China',
      country_code: 'CN',
      admin1: 'Shanghai',
    },
  ],
};

/** Open-Meteo geocoding with canned answers for Wellington and Shanghai only. */
const fakeGeocoding: typeof fetch = async (input) => {
  const name = new URL(input as URL).searchParams.get('name');
  const body = name === 'Wellington' ? wellington : name === 'Shanghai' ? SHANGHAI : {};
  return new Response(JSON.stringify(body));
};

function item(n: number): NewsItem {
  return {
    source: 'RNZ',
    title: `Story ${n}`,
    link: `https://rnz.test/${n}`,
    publishedAt: null,
    summary: `Summary ${n}`,
    titleOnly: false,
  };
}

function countingSources() {
  const counts = { weather: 0, calendar: 0, todos: 0, news: 0 };
  const sources: Sources = {
    weather: async (location) => {
      counts.weather++;
      return { text: `${location.city}：晴`, raw: null, ok: true };
    },
    calendar: async () => {
      counts.calendar++;
      return { text: '09:00-09:30 Standup', raw: null, ok: true };
    },
    todos: async () => {
      counts.todos++;
      return { text: `待办第 ${counts.todos} 次读取`, raw: null, ok: true };
    },
    news: async () => {
      counts.news++;
      return { items: [item(1), item(2)], tooOld: [], failures: [], ok: true };
    },
  };
  return { counts, sources };
}

interface Setup {
  replies?: (string | Error)[];
  /** Holds the model until released. */
  gate?: Promise<void>;
  dataDir?: string;
  /** Defaults to one daily 08:00 schedule; null for "never set". */
  schedules?: Schedule[] | null;
}

const DAILY_0800: Schedule = {
  id: 'daily0800',
  time: '08:00',
  days: 'daily',
  createdAt: '2026-10-01T00:00:00.000+13:00',
};

async function setup(options: Setup = {}) {
  const dataDir = options.dataDir ?? (await makeTempDir());
  const config = parseConfig({ ...minimalRawConfig(), paths: { data_dir: dataDir } });
  const schedules = options.schedules === undefined ? [DAILY_0800] : options.schedules;
  if (schedules && !options.dataDir) await saveSchedules(dataDir, schedules);
  const requests: ChatMessage[][] = [];
  const replies = [...(options.replies ?? [])];
  const client: LlmClient = {
    chat: async (messages) => {
      requests.push(messages);
      await options.gate;
      const reply = replies.shift() ?? '好的 [N2]';
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const logger = recordingLogger();
  const { counts, sources } = countingSources();
  let now = NOW;
  const archive = new Archive(config.archive.dir, logger);
  const core = new ChatCore({
    config,
    llm: new LlmService(client, config.ollama.num_ctx, logger),
    archive,
    sources,
    logger,
    now: () => now,
    searchCity: (name, country) => searchCity(name, country, fakeGeocoding),
  });

  const replied: string[] = [];
  const io: ChatIO = {
    reply: async (text) => void replied.push(text),
    typing: () => () => undefined,
  };
  /** Sends a message and returns what the bot replied to it. */
  const send = async (text: string) => {
    const from = replied.length;
    await core.handle(text, io);
    return replied.slice(from);
  };
  const advance = (duration: object) => {
    now = now.plus(duration);
  };
  return { config, core, archive, counts, sources, requests, send, advance, io, replied };
}

describe('ChatCore commands', () => {
  it('shows help and rejects unknown commands', async () => {
    const { send } = await setup();
    expect((await send('/start'))[0]).toContain('/brief');
    expect(await send('/nope')).toEqual(['不认识这个命令，发 /help 看看能做什么']);
  });

  it('adds, lists and completes todos', async () => {
    const { send, config } = await setup();
    expect(await send('/todo')).toEqual(['没有未完成的待办 🎉']);
    expect(await send('/add')).toEqual(['用法：/add 待办内容，例如 /add 交水费']);
    expect(await send('/add 交水费')).toEqual(['已添加：交水费（第 1 项）']);
    expect(await send('/add 买牛奶')).toEqual(['已添加：买牛奶（第 2 项）']);
    expect(await send('/todo')).toEqual(['未完成的待办：\n1. 交水费\n2. 买牛奶']);
    expect(await send('/done 1')).toEqual(['已完成：交水费']);
    expect(await send('/done 5')).toEqual(['没有这个序号，先用 /todo 看看列表']);
    expect(await send('/done abc')).toEqual(['没有这个序号，先用 /todo 看看列表']);
    expect(await readFile(config.todo.file, 'utf8')).toBe('# 待办\n\n- [x] 交水费\n- [ ] 买牛奶\n');
  });

  it('sends /brief to the asker and archives it as manual', async () => {
    const { send, archive, counts } = await setup();
    expect(await send('/brief')).toEqual(['好的 [原文](https://rnz.test/2)']);
    expect(counts.news).toBe(1);
    expect(await archive.readBrief('2026-11-03')).toMatchObject({ kind: 'manual' });
  });

  it('reports a failed /brief', async () => {
    const { send } = await setup({ replies: [new Error('boom')] });
    expect(await send('/brief')).toEqual(['早报生成失败：详情见日志']);
  });

  it('lists and resends archived briefs', async () => {
    const { send, advance } = await setup();
    expect(await send('/history')).toEqual(['最近 14 天没有归档的早报']);
    await send('/brief');
    advance({ days: 1 });
    expect((await send('/history'))[0]).toContain('最近有早报的日期：\n2026-11-03');
    expect(await send('/history 昨天')).toEqual([
      '📜 11月3日 10:00 手动早报\n\n好的 [原文](https://rnz.test/2)',
    ]);
    expect(await send('/history 10-01')).toEqual(['2026-10-01 没有归档的早报']);
    expect(await send('/history someday')).toEqual([
      '日期格式不对，可以写 2026-11-02、11-02、昨天 或 前天',
    ]);
  });

  it('switches city and replies with local and home times', async () => {
    const { send, config } = await setup();
    expect(await send('/city Shanghai')).toEqual([
      '已切换到 Shanghai（China），时区 Asia/Shanghai。下次早报：当地时间 11月3日 08:00（Auckland 时间 11月3日 13:00）。',
    ]);
    const stored = JSON.parse(await readFile(join(config.paths.data_dir, 'location.json'), 'utf8'));
    expect(stored).toMatchObject({ city: 'Shanghai', timezone: 'Asia/Shanghai' });
    expect((await send('/where'))[0]).toBe(
      [
        '当前位置：Shanghai（China），时区 Asia/Shanghai，当地时间 11月3日 05:00。',
        '下次早报：当地时间 11月3日 08:00（Auckland 时间 11月3日 13:00）。',
        '回家后用 /home 恢复。',
      ].join('\n'),
    );
  });

  it('leaves the location alone when the city is not found', async () => {
    const { send, config } = await setup();
    expect(await send('/city Atlantis')).toEqual([
      '没找到这个城市，检查一下拼写，或者加上国家，比如 /city Chengdu China',
    ]);
    await expect(access(join(config.paths.data_dir, 'location.json'))).rejects.toThrow();
    expect(await send('/city')).toEqual([
      '用法：/city 城市英文名，例如 /city Shanghai 或 /city Wellington New Zealand',
    ]);
  });

  it('lists same-name places in other timezones', async () => {
    const { send } = await setup();
    expect((await send('/city Wellington'))[0]).toBe(
      [
        '已切换到 Wellington（Wellington Region, New Zealand），时区 Pacific/Auckland。下次早报：当地时间 11月4日 08:00。',
        '',
        '同名的其他地方：',
        '- Wellington（Kansas, United States），America/Chicago',
        '- Wellington（Texas, United States），America/Chicago',
        '- Wellington（England, United Kingdom），Europe/London',
        '',
        '不是你要的？用 /city 城市名 国家 指定，例如 /city Wellington United States',
      ].join('\n'),
    );
  });

  it('picks the city in the given country', async () => {
    const { send } = await setup();
    expect((await send('/city Wellington United Kingdom'))[0]).toMatch(
      /^已切换到 Wellington（England, United Kingdom），时区 Europe\/London。下次早报：当地时间 11月3日 08:00（Auckland 时间 11月3日 21:00）。$/,
    );
  });

  it('goes back home with /home', async () => {
    const { send, config } = await setup();
    await send('/city Shanghai');
    expect(await send('/home')).toEqual([
      '已恢复为 Auckland，时区 Pacific/Auckland。下次早报：当地时间 11月4日 08:00。',
    ]);
    await expect(access(join(config.paths.data_dir, 'location.json'))).rejects.toThrow();
    expect((await send('/where'))[0]).toContain('当前位置：Auckland（家）');
  });

  it('refreshes the data on request', async () => {
    const { send, counts } = await setup();
    expect(await send('/refresh')).toEqual(['已重新获取今天的数据：天气 ✓，日程 ✓，待办 ✓']);
    await send('/refresh');
    expect(counts.weather).toBe(2);
  });
});

describe('/schedule', () => {
  const file = (dir: string) => join(dir, 'schedules.json');

  it('asks to set one when never set, and says so in /where too', async () => {
    const { send } = await setup({ schedules: null });
    const prompt =
      '还没有设置定时早报。用 /schedule add 08:00 设置一个，也可以加上“工作日”或“周末”，例如 /schedule add 07:30 工作日。';
    expect(await send('/schedule')).toEqual([prompt]);
    expect((await send('/where'))[0]).toContain(prompt);
  });

  it('adds schedules, daily by default, and lists them by time with the next one', async () => {
    const { send, config } = await setup({ schedules: null });
    expect((await send('/schedule add 18:00 工作日'))[0]).toBe(
      [
        '已添加 18:00 工作日。',
        '',
        '定时早报（Auckland 时间）：',
        '1. 18:00 工作日',
        '',
        '下次早报：当地时间 11月3日 18:00。',
      ].join('\n'),
    );
    await send('/schedule add 7:30');
    expect(await send('/schedule')).toEqual([
      [
        '定时早报（Auckland 时间）：',
        '1. 07:30 每天',
        '2. 18:00 工作日',
        '',
        '下次早报：当地时间 11月3日 18:00。',
      ].join('\n'),
    ]);
    const saved = JSON.parse(await readFile(file(config.paths.data_dir), 'utf8'));
    expect(saved.schedules.map((x: Schedule) => [x.time, x.days, x.createdAt])).toEqual([
      ['07:30', 'daily', '2026-11-03T10:00:00.000+13:00'],
      ['18:00', 'weekdays', '2026-11-03T10:00:00.000+13:00'],
    ]);
  });

  it('shows the next brief in both local and home time after /city', async () => {
    const { send } = await setup();
    await send('/city Shanghai');
    expect((await send('/schedule'))[0]).toBe(
      [
        '定时早报（Shanghai 时间）：',
        '1. 08:00 每天',
        '',
        '下次早报：当地时间 11月3日 08:00（Auckland 时间 11月3日 13:00）。',
      ].join('\n'),
    );
  });

  it('rejects bad input and clashing schedules without saving', async () => {
    const { send, config } = await setup();
    const before = await readFile(file(config.paths.data_dir), 'utf8');
    expect(await send('/schedule add 8am')).toEqual([
      '时间格式不对，例如 /schedule add 08:00 或 /schedule add 07:30 工作日',
    ]);
    expect(await send('/schedule add 09:00 周一')).toEqual([
      '最后一项可以是 每天、工作日 或 周末，例如 /schedule add 07:30 工作日',
    ]);
    expect((await send('/schedule add 08:00 工作日'))[0]).toContain('同一天不能在同一时间发两份');
    expect((await send('/schedule add 08:10'))[0]).toContain('至少要隔 30 分钟');
    expect(await readFile(file(config.paths.data_dir), 'utf8')).toBe(before);
  });

  it('removes one or several by number, and nothing when any number is wrong', async () => {
    const { send } = await setup();
    await send('/schedule add 12:00');
    await send('/schedule add 18:00');
    expect(await send('/schedule remove 2 5')).toEqual([
      '没有第 5 个定时，先用 /schedule 看看列表。',
    ]);
    expect(await send('/schedule remove')).toEqual([
      '要写删第几个，例如 /schedule remove 2，先用 /schedule 看看列表。',
    ]);
    expect((await send('/schedule remove 1 3'))[0]).toBe(
      [
        '已删除 08:00 每天、18:00 每天。',
        '',
        '定时早报（Auckland 时间）：',
        '1. 12:00 每天',
        '',
        '下次早报：当地时间 11月3日 12:00。',
      ].join('\n'),
    );
    expect((await send('/schedule remove 1'))[0]).toBe(
      '已删除 12:00 每天。\n\n现在没有定时早报，用 /schedule add 08:00 添加。',
    );
  });

  it('clears all, which is not the same as never set', async () => {
    const { send, config } = await setup();
    expect(await send('/schedule clear')).toEqual([
      '已删除全部定时。现在没有定时早报了，用 /schedule add 08:00 添加。',
    ]);
    expect(await send('/schedule')).toEqual(['现在没有定时早报，用 /schedule add 08:00 添加。']);
    expect(JSON.parse(await readFile(file(config.paths.data_dir), 'utf8'))).toEqual({
      schedules: [],
    });
  });

  it('says when schedules.json was corrupt, until the list is edited', async () => {
    const { send, config } = await setup({ schedules: null });
    await writeFile(file(config.paths.data_dir), 'not json');
    expect((await send('/schedule'))[0]).toMatch(
      /^⚠️ schedules\.json 内容有误，已备份为 .*schedules\.json\.corrupt-.*，在重新设置之前不发定时早报。\n\n现在没有定时早报/,
    );
    await send('/schedule add 08:00');
    expect((await send('/schedule'))[0]).not.toContain('内容有误');
  });

  it('explains the subcommands for anything else', async () => {
    const { send } = await setup();
    expect((await send('/schedule edit 1'))[0]).toMatch(/^用法：/);
  });
});

it('/history sends every brief of a day in order', async () => {
  const { send, archive, advance } = await setup({ replies: ['早上的', '中午的'] });
  await runBrief(
    {
      kind: 'scheduled',
      send: async () => undefined,
      archive: true,
      schedule: { id: 'daily0800', time: '08:00', label: '08:00 每天' },
    },
    {
      config: parseConfig({ ...minimalRawConfig(), paths: { data_dir: join(archive.dir, '..') } }),
      llm: new LlmService({ chat: async () => '早上的' }, 16384),
      archive,
      sources: countingSources().sources,
      now: () => NOW.minus({ hours: 2 }),
    },
  );
  await send('/brief');
  advance({ days: 1 });
  expect(await send('/history 昨天')).toEqual([
    '📜 11月3日 08:00 定时早报\n\n早上的',
    '📜 11月3日 10:00 手动早报\n\n早上的',
  ]);
});

describe('ChatCore chat', () => {
  it('answers from the news of today’s brief without refetching it', async () => {
    const { send, counts, requests } = await setup({
      replies: ['早报 [N1] [N2]', '第二条是 [N2]'],
    });
    await send('/brief');
    expect(await send('第二条展开讲讲')).toEqual(['第二条是 [原文](https://rnz.test/2)']);
    expect(counts.news).toBe(1);

    const chat = requests[1]!;
    expect(chat[0]!.content).toContain('[N2] 来源 RNZ｜Story 2｜Summary 2');
    // The brief opens the conversation, with ids rather than links.
    expect(chat[1]).toEqual({ role: 'assistant', content: '早报 [N1] [N2]' });
    expect(chat.at(-1)).toEqual({ role: 'user', content: '第二条展开讲讲' });
  });

  it('says when there is no brief yet', async () => {
    const { send, requests } = await setup();
    await send('今天天气怎样');
    expect(requests[0]![0]!.content).toContain('今天的早报还没生成');
    expect(requests[0]).toHaveLength(2);
  });

  it('restores today’s brief from the archive after a restart', async () => {
    const first = await setup({ replies: ['早报 [N2]'] });
    await first.send('/brief');

    const second = await setup({ dataDir: first.config.paths.data_dir });
    await second.core.restore();
    await second.send('第二条呢');
    const chat = second.requests[0]!;
    expect(chat[0]!.content).toContain('[N2] 来源 RNZ｜Story 2');
    expect(chat[1]).toEqual({ role: 'assistant', content: '早报 [N2]' });
  });

  it('switches to a newer brief that another process archived today', async () => {
    const first = await setup();
    const second = await setup({ dataDir: first.config.paths.data_dir, replies: ['早的早报'] });
    await second.send('/brief');
    // A brief:once run an hour later while the bot is up.
    await runBrief(
      { kind: 'manual', archive: true, send: async () => undefined },
      {
        config: first.config,
        llm: new LlmService({ chat: async () => '外面的早报 [N1]' }, 16384),
        archive: first.archive,
        sources: first.sources,
        now: () => NOW.plus({ hours: 1 }),
      },
    );
    second.advance({ hours: 1 });
    await second.send('早报说了什么');
    expect(second.requests[1]![1]).toEqual({ role: 'assistant', content: '外面的早报 [N1]' });
  });

  it('starts afresh after midnight, before the new day’s brief', async () => {
    const { send, requests, advance } = await setup({ replies: ['昨天的早报 [N1]', '一'] });
    await send('/brief');
    await send('问题一');
    advance({ hours: 15 }); // 01:00 the next day
    await send('第一条新闻呢');
    const chat = requests.at(-1)!;
    expect(chat[0]!.content).toContain('今天的早报还没生成');
    expect(chat.slice(1)).toEqual([{ role: 'user', content: '第一条新闻呢' }]);
  });

  it('keeps the conversation going after its own /brief', async () => {
    const { send, requests } = await setup({ replies: ['早报', '一', '二'] });
    await send('/brief');
    await send('问题一');
    await send('问题二');
    expect(requests[2]!.slice(1).map((m) => m.content)).toEqual(['早报', '问题一', '一', '问题二']);
  });

  it('caches the data for 30 minutes, and drops it after a todo change or a city switch', async () => {
    const { send, counts, requests, advance } = await setup();
    await send('一');
    await send('二');
    expect(counts.todos).toBe(1);
    await send('/add 交水费');
    await send('三');
    expect(counts.todos).toBe(2);
    expect(requests.at(-1)![0]!.content).toContain('待办第 2 次读取');
    advance({ minutes: 31 });
    await send('四');
    expect(counts.todos).toBe(3);
    await send('/city Shanghai');
    await send('五');
    expect(counts.weather).toBe(4);
    expect(requests.at(-1)![0]!.content).toContain('Shanghai：晴');
  });

  it('keeps the brief plus the last ten rounds, and /clear keeps only the brief', async () => {
    const { send, requests } = await setup({ replies: ['早报'] });
    await send('/brief');
    for (let i = 1; i <= 12; i++) await send(`问题 ${i}`);
    const last = requests.at(-1)!;
    // system + brief + 10 rounds + the new question
    expect(last).toHaveLength(1 + 1 + 20 + 1);
    expect(last[1]).toEqual({ role: 'assistant', content: '早报' });
    expect(last[2]).toEqual({ role: 'user', content: '问题 2' });

    expect(await send('/clear')).toEqual(['对话记忆已清空']);
    await send('新问题');
    expect(requests.at(-1)!.slice(1)).toEqual([
      { role: 'assistant', content: '早报' },
      { role: 'user', content: '新问题' },
    ]);
  });

  it('tells the user to wait while the model is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { core, io, replied } = await setup({ gate, replies: ['一的答案', '二的答案'] });
    const first = core.handle('一', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = core.handle('二', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replied).toEqual(['上一个问题还在处理，稍等']);
    release();
    await Promise.all([first, second]);
    expect(replied).toEqual(['上一个问题还在处理，稍等', '一的答案', '二的答案']);
  });

  it('says a brief is being written when that is what keeps the model busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { core, io, replied } = await setup({ gate, replies: ['早报', '答案'] });
    const brief = core.handle('/brief', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const question = core.handle('天气呢', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replied).toEqual(['正在生成早报，稍后回复你']);
    release();
    await Promise.all([brief, question]);
    expect(replied).toEqual(['正在生成早报，稍后回复你', '早报', '答案']);
  });

  it('does not start a second brief while one is being written', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { core, io, replied, counts } = await setup({ gate, replies: ['早报'] });
    const first = core.handle('/brief', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await core.handle('/brief', io);
    expect(replied).toEqual(['早报正在生成，好了会发到发起的那个对话里']);
    release();
    await first;
    expect(counts.news).toBe(1);
    expect(replied).toEqual(['早报正在生成，好了会发到发起的那个对话里', '早报']);
  });

  it('answers a question asked during /brief from the new brief', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { core, io, requests, counts } = await setup({ gate, replies: ['早报 [N1]', '答案'] });
    const brief = core.handle('/brief', io);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const question = core.handle('第一条呢', io);
    release();
    await Promise.all([brief, question]);
    expect(requests[1]![0]!.content).toContain('[N1] 来源 RNZ｜Story 1');
    expect(requests[1]![1]).toEqual({ role: 'assistant', content: '早报 [N1]' });
    expect(counts.news).toBe(1);
  });

  it('reports model errors in Chinese', async () => {
    const { send } = await setup({ replies: [new Error('socket hang up')] });
    expect(await send('你好')).toEqual(['出错了：请稍后再试，详情见日志']);
  });

  it('ignores empty messages', async () => {
    const { send, requests } = await setup();
    expect(await send('   ')).toEqual([]);
    expect(requests).toEqual([]);
  });
});

it('keeps unknown todo files untouched until a todo command', async () => {
  const { config, send } = await setup();
  await writeFile(config.todo.file, '- [ ] 已有\n');
  expect(await send('/todo')).toEqual(['未完成的待办：\n1. 已有']);
});
