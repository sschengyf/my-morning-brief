import { logger as defaultLogger, type Logger } from '../infra/index.js';

export type ChannelName = 'telegram' | 'discord';

export const CHANNEL_LABELS: Record<ChannelName, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
};

/** How a channel answers one incoming message. */
export interface ChatIO {
  reply(markdown: string): Promise<void>;
  /** Shows "typing…" until the returned function is called. */
  typing(): () => void;
}

/** Handles one message from the owner; implemented by ChatCore. */
export type MessageHandler = (text: string, io: ChatIO) => Promise<void>;

/**
 * A chat platform. The brief, brief:once and the scheduler only use `send`,
 * so they never care which platform it is.
 */
export interface Channel {
  readonly name: ChannelName;
  /** Enabled with an owner id configured, so there is someone to send to. */
  readonly ready: boolean;
  /** Connects. With a handler it also receives messages; without one it can only send. */
  start(handler?: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  /** Sends Markdown to the owner. */
  send(markdown: string): Promise<void>;
}

export class SendError extends Error {
  override name = 'SendError';
  constructor(
    readonly failed: ChannelName[],
    readonly causes: unknown[],
  ) {
    super(`发送失败：${failed.map((name) => CHANNEL_LABELS[name]).join('、')}`);
  }
}

/**
 * Sends to every given channel. Channels that succeed are not affected by
 * those that fail; a SendError lists the failed ones so only they are retried.
 */
export async function sendToChannels(
  channels: Channel[],
  text: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const results = await Promise.allSettled(channels.map((channel) => channel.send(text)));
  const failed: ChannelName[] = [];
  const causes: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const name = channels[index]!.name;
      logger.error(`发送到 ${CHANNEL_LABELS[name]} 失败`, result.reason);
      failed.push(name);
      causes.push(result.reason);
    }
  });
  if (failed.length > 0) throw new SendError(failed, causes);
}

/** Repeats a typing action until stopped; platforms show it for a few seconds only. */
export function repeatTyping(action: () => Promise<unknown>, everyMs: number): () => void {
  const run = () => void action().catch(() => undefined);
  run();
  const timer = setInterval(run, everyMs);
  return () => clearInterval(timer);
}
