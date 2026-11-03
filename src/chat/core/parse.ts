import { DateTime } from 'luxon';

/** "/add@MyBot buy milk" → { name: 'add', args: 'buy milk' } */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!.toLowerCase(), args: (match[2] ?? '').trim() } : null;
}

/**
 * Ways to read "/city" arguments, most likely first. "Los Angeles, United
 * States" is explicit; otherwise "Wellington New Zealand" is tried as one
 * name, then with the trailing words as the country.
 */
export function cityQueries(args: string): { name: string; country?: string }[] {
  const comma = args.indexOf(',');
  if (comma >= 0) {
    const name = args.slice(0, comma).trim();
    const country = args.slice(comma + 1).trim();
    return [{ name, ...(country && { country }) }];
  }
  const words = args.trim().split(/\s+/).slice(0, 6);
  const queries = [];
  for (let k = words.length; k >= 1; k--) {
    const country = words.slice(k).join(' ');
    queries.push({ name: words.slice(0, k).join(' '), ...(country && { country }) });
  }
  return queries;
}

/** 2026-11-02, 11-02, 11/2, 昨天, 前天, 今天 → ISO date; null when unreadable. */
export function parseHistoryDate(text: string, today: DateTime): string | null {
  const relative: Record<string, number> = { 今天: 0, 昨天: 1, 前天: 2 };
  const trimmed = text.trim();
  if (Object.hasOwn(relative, trimmed))
    return today.minus({ days: relative[trimmed]! }).toISODate();

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (match) {
    const date = DateTime.fromObject(
      { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
      { zone: 'utc' },
    );
    return date.isValid ? date.toISODate() : null;
  }
  match = /^(\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (match) {
    let date = DateTime.fromObject(
      { year: today.year, month: Number(match[1]), day: Number(match[2]) },
      { zone: 'utc' },
    );
    if (!date.isValid) return null;
    // A date later this year has not happened yet; mean last year's.
    if (date.toISODate()! > today.toISODate()!) date = date.minus({ years: 1 });
    return date.toISODate();
  }
  return null;
}
