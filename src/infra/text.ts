// Telegram turns bare domains into links, e.g. "evil.com/login", so model output
// has them removed (llm/sanitize.ts). Names shown next to model output must not
// look like one either, or they would be removed too.
export const BARE_DOMAIN =
  /\b(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|xyz|top|info|me|ly|gl|link|click|ru|cn|nz|uk|au)\b(?:\/\S*)?/gi;

export function looksLikeDomain(text: string): boolean {
  return new RegExp(BARE_DOMAIN.source, 'i').test(text);
}
