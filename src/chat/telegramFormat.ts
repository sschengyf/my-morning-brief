import { splitMessage } from './split.js';

/** Telegram allows 4096 characters; leave some room. */
export const TELEGRAM_LIMIT = 4000;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Converts the Markdown the model and the bot write into Telegram HTML:
 * **bold**, [text](link), `code` and # headings. Everything is escaped first,
 * so text can never produce tags of its own.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codes: string[] = [];
  // Code spans first, so their contents are not formatted.
  let html = escapeHtml(markdown).replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  html = html
    .replace(
      /\[([^\]\n]+)\]\(&lt;(https?:\/\/[^\s)]+?)&gt;\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, text1?: string, url1?: string, text2?: string, url2?: string) =>
        `<a href="${(url1 ?? url2)!.replace(/"/g, '&quot;')}">${text1 ?? text2}</a>`,
    )
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>');
  return html.replace(/\uE000(\d+)\uE000/g, (_, index: string) => codes[Number(index)]!);
}

/**
 * Splits the Markdown so each chunk fits once converted. Splitting happens
 * before conversion: cutting converted HTML could break an <a> tag in half.
 * Each chunk is converted on its own, so its tags are always balanced.
 */
export function splitForTelegram(markdown: string): string[] {
  return splitMessage(markdown, TELEGRAM_LIMIT, (chunk) => markdownToTelegramHtml(chunk).length);
}
