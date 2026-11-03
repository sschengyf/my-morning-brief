import { Bot, GrammyError, type Api } from 'grammy';
import type { Config } from '../config.js';
import { logger as defaultLogger, type Logger } from '../logger.js';
import {
  dispatch,
  repeatTyping,
  type Channel,
  type ChatIO,
  type MessageHandler,
} from './channel.js';
import { COMMANDS } from './commands.js';
import { markdownToTelegramHtml, splitForTelegram } from './telegramFormat.js';

/** Telegram shows "typing" for about 5 seconds. */
const TYPING_EVERY_MS = 4_000;

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

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private readonly bot: Bot;
  private polling: Promise<void> | null = null;

  constructor(
    private readonly config: Config['telegram'],
    private readonly logger: Logger = defaultLogger,
    bot?: Bot,
  ) {
    this.bot = bot ?? new Bot(config.bot_token);
  }

  get ready(): boolean {
    return this.config.enabled && this.config.chat_id !== 0;
  }

  async start(handler?: MessageHandler): Promise<void> {
    // Without a handler (brief:once) the API is enough; polling would only steal updates.
    if (!handler) return;
    this.attach(handler);

    await this.bot.api
      .setMyCommands(COMMANDS.map(({ name, description }) => ({ command: name, description })))
      .catch((error: unknown) => this.logger.warn('注册 Telegram 命令菜单失败', error));

    await new Promise<void>((resolve, reject) => {
      this.polling = this.bot.start({ onStart: () => resolve() }).catch((error: unknown) => {
        if (error instanceof GrammyError && error.error_code === 409) {
          this.logger.error(
            'Telegram 返回 409：另一个实例正在用这个 bot 运行（可能是开机自启的那个），请先停掉其中一个',
          );
        } else {
          this.logger.error('Telegram 轮询停止了', error);
        }
        reject(error as Error);
      });
    });
    this.logger.info('Telegram 已连接');
  }

  /** Routes text messages to the handler; separate from polling so tests can feed updates. */
  attach(handler: MessageHandler): void {
    const ownerId = this.config.chat_id === 0 ? '' : String(this.config.chat_id);

    this.bot.on('message:text', (ctx) => {
      const chatId = ctx.chat.id;
      const io: ChatIO = {
        reply: (text) => sendTelegramMarkdown(ctx.api, chatId, text),
        typing: () => repeatTyping(() => ctx.api.sendChatAction(chatId, 'typing'), TYPING_EVERY_MS),
      };
      // Not awaited: grammY handles updates one at a time, and a long answer
      // would otherwise hold back the next message and its "busy" notice.
      void dispatch(
        {
          channel: 'telegram',
          senderId: String(ctx.from.id),
          isPrivate: ctx.chat.type === 'private' && ctx.chat.id === ctx.from.id,
          text: ctx.message.text,
          io,
        },
        ownerId,
        handler,
        this.logger,
      ).catch((error: unknown) => this.logger.error('处理 Telegram 消息失败', error));
    });
    this.bot.catch((error) => this.logger.error('Telegram 处理更新出错', error.error));
  }

  async stop(): Promise<void> {
    if (this.polling) {
      await this.bot.stop();
      this.polling = null;
    }
  }

  send(markdown: string): Promise<void> {
    return sendTelegramMarkdown(this.bot.api, this.config.chat_id, markdown);
  }
}
