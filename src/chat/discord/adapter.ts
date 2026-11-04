import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  MessageFlags,
  Partials,
} from 'discord.js';
import { type Config, logger as defaultLogger, type Logger } from '#/infra/index.js';
import { type Channel, type ChatIO, type MessageHandler, repeatTyping } from '../channel.js';
import { dispatch } from '../dispatch.js';
import { toDiscordMessages } from './format.js';
import { interactionText, slashCommands } from './slash-commands.js';

/** Discord shows "typing" for about 10 seconds. */
const TYPING_EVERY_MS = 8_000;

const SEND_OPTIONS = {
  flags: MessageFlags.SuppressEmbeds,
  allowedMentions: { parse: [] },
} as const;

export class DiscordChannel implements Channel {
  readonly name = 'discord';
  private client: Client | null = null;

  constructor(
    private readonly config: Config['discord'],
    private readonly logger: Logger = defaultLogger,
    private readonly createClient: () => Client = () =>
      new Client({
        // Direct messages only. Their content needs no privileged intent.
        intents: [GatewayIntentBits.DirectMessages],
        // DM channels are not cached; without this, their messages never arrive.
        partials: [Partials.Channel],
      }),
  ) {}

  get ready(): boolean {
    return this.config.enabled && this.config.user_id !== '';
  }

  async start(handler?: MessageHandler): Promise<void> {
    const client = this.createClient();
    this.client = client;
    if (handler) {
      client.on(Events.MessageCreate, (message) => {
        void this.onMessage(message, handler).catch((error: unknown) =>
          this.logger.error('处理 Discord 消息失败', error),
        );
      });
      client.on(Events.InteractionCreate, (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        void this.onCommand(interaction, handler).catch((error: unknown) =>
          this.logger.error('处理 Discord 命令失败', error),
        );
      });
    }
    client.on(Events.Error, (error) => this.logger.error('Discord 连接出错', error));
    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    await client.login(this.config.bot_token);
    await ready;
    this.logger.info(`Discord 已连接：${client.user?.tag ?? ''}`);
    if (handler) {
      await client.application?.commands.set(slashCommands()).catch((error: unknown) => {
        this.logger.warn('注册 Discord slash 命令失败，普通文字命令仍然可以用', error);
      });
    }
  }

  async stop(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  async send(markdown: string): Promise<void> {
    if (!this.client) throw new Error('Discord 还没连接');
    const user = await this.client.users.fetch(this.config.user_id);
    for (const chunk of toDiscordMessages(markdown)) {
      await user.send({ content: chunk, ...SEND_OPTIONS });
    }
  }

  private async onMessage(message: Message, handler: MessageHandler): Promise<void> {
    if (message.author.bot) return;
    const channel = message.channel;
    const io: ChatIO = {
      reply: async (text) => {
        if (!channel.isSendable()) return;
        for (const chunk of toDiscordMessages(text))
          await channel.send({ content: chunk, ...SEND_OPTIONS });
      },
      typing: () =>
        channel.isSendable()
          ? repeatTyping(() => channel.sendTyping(), TYPING_EVERY_MS)
          : () => undefined,
    };
    await dispatch(
      {
        channel: 'discord',
        senderId: message.author.id,
        isPrivate: channel.type === ChannelType.DM,
        text: message.content,
        io,
      },
      this.config.user_id,
      handler,
      this.logger,
    );
  }

  private async onCommand(interaction: ChatInputCommandInteraction, handler: MessageHandler) {
    let deferred = false;
    let replied = false;
    const io: ChatIO = {
      reply: async (text) => {
        for (const chunk of toDiscordMessages(text)) {
          const options = { content: chunk, ...SEND_OPTIONS };
          if (deferred && !replied) await interaction.editReply(options);
          else if (replied) await interaction.followUp(options);
          else await interaction.reply(options);
          replied = true;
        }
      },
      // A deferred interaction already shows "thinking…".
      typing: () => () => undefined,
    };
    await dispatch(
      {
        channel: 'discord',
        senderId: interaction.user.id,
        isPrivate: !interaction.inGuild(),
        text: interactionText(interaction),
        io,
      },
      this.config.user_id,
      async (text, chatIo) => {
        // Must be acknowledged within 3 seconds; the answer may take a minute.
        await interaction.deferReply();
        deferred = true;
        await handler(text, chatIo);
      },
      this.logger,
    );
  }
}
