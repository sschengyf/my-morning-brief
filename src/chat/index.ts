// Public API of chat/: other modules import from here, never from its files.
export { CHANNEL_LABELS, sendToChannels } from './channel.js';
export type { Channel, MessageHandler } from './channel.js';
export { ChatCore } from './core/chat-core.js';
export { DiscordChannel } from './discord/adapter.js';
export { TelegramChannel } from './telegram/adapter.js';
