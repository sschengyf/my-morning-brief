// Telegram turns bare domains into links, e.g. "evil.com/login", so text that
// reaches a message must not contain one unless we put the link there.
// Not exported: a shared /g regex keeps lastIndex between .test() calls.
const BARE_DOMAIN =
  /\b(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|xyz|top|info|me|ly|gl|link|click|ru|cn|nz|uk|au)\b(?:\/\S*)?/gi;

export function looksLikeDomain(text: string): boolean {
  return new RegExp(BARE_DOMAIN.source, 'i').test(text);
}

export function stripDomains(text: string): string {
  return text.replace(BARE_DOMAIN, '');
}

/** Keeps a domain readable but not linkable: "interest.co.nz" → "interest．co．nz". */
export function defuseDomains(text: string): string {
  return text.replace(BARE_DOMAIN, (domain) => domain.replace(/\./g, '．'));
}
