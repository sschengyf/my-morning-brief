/** Properties node-ical refuses to see twice in one component; it then rejects the whole calendar. */
const SINGLE = new Set(['DTSTART', 'DTEND', 'DUE']);

/**
 * Keeps only the first DTSTART, DTEND and DUE of each component (with their
 * folded continuation lines). iCloud has exported events with a duplicate
 * DTEND, and one such old event would otherwise cost every event of that
 * calendar.
 */
export function dropDuplicateDates(icsText: string): string {
  const seen: Set<string>[] = [new Set()];
  let dropping = false;
  const kept = icsText.split(/\r?\n/).filter((line) => {
    // A folded line continues the previous one: it goes wherever that one went.
    if (/^[ \t]/.test(line)) return !dropping;
    dropping = false;
    const name = /^[A-Za-z-]+/.exec(line)?.[0].toUpperCase() ?? '';
    if (name === 'BEGIN') seen.push(new Set());
    else if (name === 'END' && seen.length > 1) seen.pop();
    else if (SINGLE.has(name)) {
      const current = seen.at(-1)!;
      if (current.has(name)) {
        dropping = true;
        return false;
      }
      current.add(name);
    }
    return true;
  });
  return kept.join('\r\n');
}
