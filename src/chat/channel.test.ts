import { describe, expect, it } from 'vitest';
import { recordingLogger } from '../../test/helpers.js';
import { type Channel, type ChannelName, SendError, sendToChannels } from './channel.js';

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
