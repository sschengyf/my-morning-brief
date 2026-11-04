import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { sendTelegramMarkdown } from './send.js';

const OWNER = 42;

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
