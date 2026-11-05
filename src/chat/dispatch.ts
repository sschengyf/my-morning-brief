import { logger as defaultLogger, type Logger } from '#/infra/index.js';
import { CHANNEL_LABELS, type ChannelName, type ChatIO, type MessageHandler } from './channel.js';

/** The reply to anyone who writes before an owner id is configured. */
export function firstTimeReply(channel: ChannelName, id: string): string {
  const key = channel === 'telegram' ? 'telegram.chat_id' : 'discord.user_id';
  const env = channel === 'telegram' ? 'TELEGRAM_CHAT_ID' : 'DISCORD_USER_ID';
  const value = channel === 'telegram' ? id : `"${id}"`;
  return [
    `你的 id 是：\`${id}\``,
    `Docker 部署：填进 users/<名字>/.env 的 ${env}=${id}，然后 docker compose up -d <名字>（restart 不会重新读 .env）。`,
    `本机运行：在 config.toml 里设置 ${key} = ${value}，然后重启程序。`,
  ].join('\n\n');
}

/** One incoming message, already translated from the platform's types. */
export interface Incoming {
  channel: ChannelName;
  senderId: string;
  /** A one-to-one chat with the bot: not a group, not a server channel. */
  isPrivate: boolean;
  text: string;
  io: ChatIO;
}

/**
 * The owner check both platforms share. Before an owner id is configured the
 * bot only tells people their id; afterwards it serves the owner's private
 * messages and ignores everything else.
 */
export async function dispatch(
  incoming: Incoming,
  ownerId: string,
  handler: MessageHandler,
  logger: Logger = defaultLogger,
): Promise<void> {
  const label = CHANNEL_LABELS[incoming.channel];
  if (!incoming.isPrivate) {
    logger.info(`忽略了一条 ${label} 群组或服务器里的消息，机器人只处理私聊`);
    return;
  }
  if (!ownerId) {
    await incoming.io.reply(firstTimeReply(incoming.channel, incoming.senderId));
    return;
  }
  if (incoming.senderId !== ownerId) {
    logger.warn(`忽略了一条陌生人发来的 ${label} 消息`);
    return;
  }
  await handler(incoming.text, incoming.io);
}
