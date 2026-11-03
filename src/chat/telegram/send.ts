import { type Api, GrammyError } from 'grammy';
import { markdownToTelegramHtml, splitForTelegram } from './format.js';

/**
 * Sends Markdown as Telegram HTML, split so each converted chunk fits. A chunk
 * Telegram cannot parse is resent as plain text rather than lost.
 */
export async function sendTelegramMarkdown(
  api: Pick<Api, 'sendMessage'>,
  chatId: number,
  markdown: string,
): Promise<void> {
  for (const chunk of splitForTelegram(markdown)) {
    try {
      await api.sendMessage(chatId, markdownToTelegramHtml(chunk), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      if (!(error instanceof GrammyError && /can't parse entities/i.test(error.description))) {
        throw error;
      }
      await api.sendMessage(chatId, chunk, { link_preview_options: { is_disabled: true } });
    }
  }
}
