import { splitMessage } from '../split-message.js';

export const DISCORD_LIMIT = 2000;

/**
 * Discord renders Markdown itself, so messages only need splitting. Embeds are
 * suppressed on every message, or each [原文](link) would add a preview card.
 */
export function toDiscordMessages(markdown: string): string[] {
  return splitMessage(markdown, DISCORD_LIMIT);
}
