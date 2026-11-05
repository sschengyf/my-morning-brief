import { oneLine } from '../common.js';

const SUMMARY_LENGTH = 200;
const TRACKING_PARAMS = /^(utm_.+|at_.+|fbclid|gclid|mc_cid|mc_eid)$/i;
// hnrss puts only these in the description; they carry no news content.
const METADATA_LINE = /^\s*(Article URL|Comments URL|Points|# Comments):.*$/gim;
const BARE_URL = /https?:\/\/\S+/g;

/** Strips HTML, hnrss metadata lines and bare URLs; truncates to SUMMARY_LENGTH characters. */
export function cleanSummary(text: string): string {
  const cleaned = oneLine(
    text
      .replace(/<[^>]*>/g, ' ')
      .replace(METADATA_LINE, ' ')
      .replace(BARE_URL, ' '),
  );
  const chars = [...cleaned];
  return chars.length > SUMMARY_LENGTH ? `${chars.slice(0, SUMMARY_LENGTH).join('')}…` : cleaned;
}

/**
 * Whether a summary only repeats the title. Google News feeds do this
 * ("Breakingviews - X - Reuters" / "Breakingviews - X Reuters"), and the brief
 * would show the title twice.
 */
export function repeatsTitle(summary: string, title: string): boolean {
  const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const s = letters(summary);
  const t = letters(title);
  return s !== '' && (s === t || t.startsWith(s));
}

/** Removes tracking parameters and a trailing slash, so the same article dedupes across days and feeds. */
export function normalizeLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return link.trim();
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
