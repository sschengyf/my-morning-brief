import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../helpers.js';
import {
  type Channel,
  type ChannelName,
  type ChatIO,
  SendError,
  sendToChannels,
} from '../../src/chat/channel.js';
import { dispatch, type Incoming } from '../../src/chat/dispatch.js';

function io(): ChatIO & { replies: string[] } {
  const replies: string[] = [];
  return { replies, reply: async (text) => void replies.push(text), typing: () => () => undefined };
}

function incoming(overrides: Partial<Incoming> = {}): Incoming {
  return {
    channel: 'discord',
    senderId: '111',
    isPrivate: true,
    text: '你好',
    io: io(),
    ...overrides,
  };
}

describe('dispatch', () => {
  it('passes the owner’s private messages to the handler', async () => {
    const handler = vi.fn(async () => undefined);
    const message = incoming();
    await dispatch(message, '111', handler, recordingLogger());
    expect(handler).toHaveBeenCalledWith('你好', message.io);
  });

  it('tells anyone their id before an owner is configured, and does nothing else', async () => {
    const handler = vi.fn(async () => undefined);
    const discord = incoming({ senderId: '123456789012345678' });
    await dispatch(discord, '', handler, recordingLogger());
    expect((discord.io as ReturnType<typeof io>).replies[0]).toContain(
      'discord.user_id = "123456789012345678"',
    );

    const telegram = incoming({ channel: 'telegram', senderId: '42' });
    await dispatch(telegram, '', handler, recordingLogger());
    expect((telegram.io as ReturnType<typeof io>).replies[0]).toContain('telegram.chat_id = 42');
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores strangers and group or server messages', async () => {
    const handler = vi.fn(async () => undefined);
    const logger = recordingLogger();
    const stranger = incoming({ senderId: '999' });
    await dispatch(stranger, '111', handler, logger);
    const group = incoming({ isPrivate: false });
    await dispatch(group, '111', handler, logger);
    await dispatch(incoming({ isPrivate: false }), '', handler, logger);

    expect(handler).not.toHaveBeenCalled();
    expect((stranger.io as ReturnType<typeof io>).replies).toEqual([]);
    expect((group.io as ReturnType<typeof io>).replies).toEqual([]);
    expect(logger.warnings).toEqual([expect.stringContaining('陌生人')]);
  });
});

function fakeChannel(name: ChannelName, fail = false): Channel & { sent: string[] } {
  const sent: string[] = [];
  return {
    name,
    ready: true,
    sent,
    start: async () => undefined,
    stop: async () => undefined,
    send: async (text) => {
      if (fail) throw new Error(`${name} down`);
      sent.push(text);
    },
  };
}

describe('sendToChannels', () => {
  it('sends to every channel', async () => {
    const channels = [fakeChannel('telegram'), fakeChannel('discord')];
    await sendToChannels(channels, '早报', recordingLogger());
    expect(channels.map((c) => c.sent)).toEqual([['早报'], ['早报']]);
  });

  it('still delivers to the others and names the channels that failed', async () => {
    const telegram = fakeChannel('telegram', true);
    const discord = fakeChannel('discord');
    const error = await sendToChannels([telegram, discord], '早报', recordingLogger()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SendError);
    expect((error as SendError).failed).toEqual(['telegram']);
    expect((error as SendError).message).toBe('发送失败：Telegram');
    expect(discord.sent).toEqual(['早报']);
  });
});
