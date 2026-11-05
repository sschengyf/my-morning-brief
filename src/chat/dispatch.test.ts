import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import type { ChatIO } from './channel.js';
import { dispatch, type Incoming } from './dispatch.js';

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
    expect((discord.io as ReturnType<typeof io>).replies[0]).toContain(
      'users/<名字>/.env 的 DISCORD_USER_ID=123456789012345678',
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
