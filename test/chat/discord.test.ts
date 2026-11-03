import { EventEmitter } from 'node:events';
import { ChannelType, Events, MessageFlags, type Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { DiscordChannel, interactionText, slashCommands } from '../../src/chat/discord.js';
import { recordingLogger } from '../helpers.js';

const OWNER = '123456789012345678';

function fakeClient() {
  const client = Object.assign(new EventEmitter(), {
    user: { tag: 'brief#0001' },
    application: { commands: { set: vi.fn(async () => undefined) } },
    dmSent: [] as unknown[],
    users: {
      fetch: vi.fn(async () => ({
        send: async (options: unknown) => void client.dmSent.push(options),
      })),
    },
    login: vi.fn(async () => {
      setImmediate(() => client.emit(Events.ClientReady));
      return 'token';
    }),
    destroy: vi.fn(async () => undefined),
  });
  return client;
}

function dm(authorId: string, content: string, type = ChannelType.DM) {
  const sent: { content: string; flags: number }[] = [];
  return {
    sent,
    message: {
      author: { id: authorId, bot: false },
      content,
      channel: {
        type,
        isSendable: () => true,
        send: async (options: { content: string; flags: number }) => void sent.push(options),
        sendTyping: vi.fn(async () => undefined),
      },
    },
  };
}

function command(userId: string, name: string, args: Record<string, string> = {}, inGuild = false) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    interaction: {
      commandName: name,
      user: { id: userId },
      options: { getString: (key: string) => args[key] ?? null },
      isChatInputCommand: () => true,
      inGuild: () => inGuild,
      deferReply: async () => void calls.push(['defer', null]),
      editReply: async (options: unknown) => void calls.push(['edit', options]),
      followUp: async (options: unknown) => void calls.push(['followUp', options]),
      reply: async (options: unknown) => void calls.push(['reply', options]),
    },
  };
}

async function started(userId = OWNER) {
  const client = fakeClient();
  const handler = vi.fn(async (text: string, io: { reply(t: string): Promise<void> }) => {
    await io.reply(`收到：${text}`);
  });
  const channel = new DiscordChannel(
    { enabled: true, bot_token: 'token', user_id: userId },
    recordingLogger(),
    () => client as unknown as Client,
  );
  await channel.start(handler);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { client, channel, handler, flush };
}

describe('DiscordChannel', () => {
  it('registers the slash commands for bot DMs', async () => {
    const { client } = await started();
    expect(client.application.commands.set).toHaveBeenCalledWith(slashCommands());
    const city = slashCommands().find((c) => c.name === 'city')!;
    expect(city.options?.[0]).toMatchObject({ name: 'name', required: true });
  });

  it('answers the owner’s DMs with embeds suppressed', async () => {
    const { client, handler, flush } = await started();
    const { message, sent } = dm(OWNER, '今天要带伞吗');
    client.emit(Events.MessageCreate, message);
    await flush();
    expect(handler).toHaveBeenCalledWith('今天要带伞吗', expect.anything());
    expect(sent).toEqual([
      {
        content: '收到：今天要带伞吗',
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [] },
      },
    ]);
  });

  it('ignores strangers, server channels and bots', async () => {
    const { client, handler, flush } = await started();
    const stranger = dm('999', 'hi');
    const server = dm(OWNER, 'hi', ChannelType.GuildText);
    const bot = dm(OWNER, 'hi');
    bot.message.author.bot = true;
    for (const { message } of [stranger, server, bot]) client.emit(Events.MessageCreate, message);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect([...stranger.sent, ...server.sent, ...bot.sent]).toEqual([]);
  });

  it('tells the sender their id before user_id is set', async () => {
    const { client, handler, flush } = await started('');
    const { message, sent } = dm(OWNER, 'hi');
    client.emit(Events.MessageCreate, message);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(sent[0]!.content).toContain(`discord.user_id = "${OWNER}"`);
  });

  it('defers slash commands, then edits the reply and follows up', async () => {
    const { client, handler, flush } = await started();
    const { interaction, calls } = command(OWNER, 'city', { name: 'Wellington New Zealand' });
    handler.mockImplementationOnce(async (_text, io) => {
      await io.reply('一');
      await io.reply('二');
    });
    client.emit(Events.InteractionCreate, interaction);
    await flush();
    expect(handler).toHaveBeenCalledWith('/city Wellington New Zealand', expect.anything());
    expect(calls.map(([kind]) => kind)).toEqual(['defer', 'edit', 'followUp']);
  });

  it('does not defer for strangers or server channels', async () => {
    const { client, handler, flush } = await started();
    const stranger = command('999', 'brief');
    const server = command(OWNER, 'brief', {}, true);
    client.emit(Events.InteractionCreate, stranger.interaction);
    client.emit(Events.InteractionCreate, server.interaction);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect([...stranger.calls, ...server.calls]).toEqual([]);
  });

  it('sends briefs to the owner by DM', async () => {
    const { client, channel } = await started();
    await channel.send('早报');
    expect(client.users.fetch).toHaveBeenCalledWith(OWNER);
    expect(client.dmSent).toEqual([expect.objectContaining({ content: '早报' })]);
    expect(channel.ready).toBe(true);
  });

  it('turns an interaction into command text', () => {
    expect(interactionText(command(OWNER, 'add', { text: '交水费' }).interaction as never)).toBe(
      '/add 交水费',
    );
    expect(interactionText(command(OWNER, 'history').interaction as never)).toBe('/history');
  });
});
