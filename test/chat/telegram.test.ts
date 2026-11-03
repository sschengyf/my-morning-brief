import { Bot, GrammyError } from 'grammy';
import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import type { ChatIO } from '../../src/chat/channel.js';
import { sendTelegramMarkdown, TelegramChannel } from '../../src/chat/telegram.js';
import { recordingLogger } from '../helpers.js';

const OWNER = 42;

function fakeBot() {
  const bot = new Bot('123456789:AAEexampleexampleexampleexampleexample', {
    botInfo: {
      id: 1,
      is_bot: true,
      first_name: 'Brief',
      username: 'brief_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never,
  });
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true } as never;
  });
  return { bot, calls };
}

function textUpdate(fromId: number, chatId: number, text: string, type = 'private'): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type, first_name: 'X' } as never,
      from: { id: fromId, is_bot: false, first_name: 'X' },
      text,
    },
  };
}

async function setup(chatId = OWNER) {
  const { bot, calls } = fakeBot();
  const channel = new TelegramChannel(
    { enabled: true, bot_token: 'x', chat_id: chatId },
    recordingLogger(),
    bot,
  );
  const handler = vi.fn(async (text: string, io: ChatIO) => io.reply(`**收到**：${text}`));
  channel.attach(handler);
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { bot, calls, channel, handler, flush };
}

describe('TelegramChannel', () => {
  it('answers the owner in HTML without link previews', async () => {
    const { bot, calls, handler, flush } = await setup();
    await bot.handleUpdate(textUpdate(OWNER, OWNER, '/todo'));
    await flush();
    expect(handler).toHaveBeenCalledWith('/todo', expect.anything());
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: OWNER,
          text: '<b>收到</b>：/todo',
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
  });

  it('ignores strangers and groups the owner is in', async () => {
    const { bot, calls, handler, flush } = await setup();
    await bot.handleUpdate(textUpdate(7, 7, 'hi'));
    await bot.handleUpdate(textUpdate(OWNER, -100, 'hi', 'group'));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('tells the sender their chat id while chat_id is 0', async () => {
    const { bot, calls, handler, flush } = await setup(0);
    await bot.handleUpdate(textUpdate(OWNER, OWNER, '/start'));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(calls[0]!.payload.text).toContain('telegram.chat_id = 42');
    expect(calls[0]!.payload.text).toContain('<code>42</code>');
  });

  it('is ready only with a chat id', () => {
    expect(
      new TelegramChannel(
        { enabled: true, bot_token: 'x', chat_id: 0 },
        recordingLogger(),
        fakeBot().bot,
      ).ready,
    ).toBe(false);
  });
});

describe('sendTelegramMarkdown', () => {
  it('resends as plain text when Telegram cannot parse the HTML', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new GrammyError(
          'x',
          { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
          'sendMessage',
          {},
        ),
      )
      .mockResolvedValue(undefined);
    await sendTelegramMarkdown({ sendMessage }, OWNER, '**a**');
    expect(sendMessage.mock.calls[1]).toEqual([
      OWNER,
      '**a**',
      { link_preview_options: { is_disabled: true } },
    ]);
  });

  it('rethrows other errors so the caller can retry', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(sendTelegramMarkdown({ sendMessage }, OWNER, 'a')).rejects.toThrow('network down');
  });
});
