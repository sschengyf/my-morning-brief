// Public API of chat/: other modules import from here, never from its files.
export { CHANNEL_LABELS, SendError, sendToChannels } from './channel.js';
export type { Channel, ChannelName, MessageHandler } from './channel.js';
export { ChatCore } from './core/chat-core.js';
export { SCHEDULE_PROMPT } from './core/next-brief.js';
export { DiscordChannel } from './discord/adapter.js';
export { TelegramChannel } from './telegram/adapter.js';
