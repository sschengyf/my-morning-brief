import { describe, expect, it } from 'vitest';
import { makeTempDir, recordingLogger } from '../../test/helpers.js';
import type { Channel, ChannelName } from '#/chat/channel.js';
import { saveSchedules } from '#/schedules/store.js';
import { remindToSchedule } from './prompt.js';
import { loadState } from './state.js';

function channel(name: ChannelName, failing = false) {
  const received: string[] = [];
  const c: Channel & { received: string[] } = {
    name,
    ready: true,
    received,
    start: async () => undefined,
    stop: async () => undefined,
    send: async (text) => {
      if (failing) throw new Error('down');
      received.push(text);
    },
  };
  return c;
}

describe('remindToSchedule', () => {
  it('asks once when no schedule was ever set, not again after a restart', async () => {
    const dir = await makeTempDir();
    const discord = channel('discord');
    await remindToSchedule(dir, [discord], recordingLogger());
    expect(discord.received).toEqual([expect.stringContaining('还没有设置定时早报')]);
    expect((await loadState(dir)).schedulePromptSent).toBe(true);

    await remindToSchedule(dir, [discord], recordingLogger());
    expect(discord.received).toHaveLength(1);
  });

  it('does not ask once schedules exist or were cleared on purpose', async () => {
    const dir = await makeTempDir();
    await saveSchedules(dir, []);
    const discord = channel('discord');
    await remindToSchedule(dir, [discord], recordingLogger());
    expect(discord.received).toEqual([]);
  });

  it('does nothing without a ready channel', async () => {
    const dir = await makeTempDir();
    await remindToSchedule(dir, [], recordingLogger());
    expect((await loadState(dir)).schedulePromptSent).toBe(false);
  });

  it('tries again on the next start when no channel got it, but not when one did', async () => {
    const dir = await makeTempDir();
    const logger = recordingLogger();
    await remindToSchedule(dir, [channel('discord', true)], logger);
    expect((await loadState(dir)).schedulePromptSent).toBe(false);
    expect(logger.warnings).toEqual([expect.stringContaining('下次启动再试')]);

    await remindToSchedule(dir, [channel('discord', true), channel('telegram')], recordingLogger());
    expect((await loadState(dir)).schedulePromptSent).toBe(true);
  });
});
