const LINK = /\[[^\]\n]*\]\([^)\s]*\)/g;

/**
 * Splits Markdown into chunks whose measured size stays within `limit`:
 * whole paragraphs where possible, then lines, then, for a single overlong
 * line, at the last space or punctuation that is not inside a [text](link).
 * `measure` is the size after the channel's conversion (Telegram HTML grows).
 */
export function splitMessage(
  text: string,
  limit: number,
  measure: (chunk: string) => number = (chunk) => chunk.length,
): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  const append = (piece: string, separator: string) => {
    const joined = current ? `${current}${separator}${piece}` : piece;
    if (measure(joined) <= limit) {
      current = joined;
      return true;
    }
    return false;
  };

  for (const paragraph of text.trim().split(/\n{2,}/)) {
    if (append(paragraph, '\n\n')) continue;
    flush();
    if (append(paragraph, '\n\n')) continue;
    for (const line of paragraph.split('\n')) {
      if (append(line, '\n')) continue;
      flush();
      if (append(line, '\n')) continue;
      for (const piece of splitLine(line, limit, measure)) {
        if (!append(piece, '')) {
          flush();
          current = piece;
        }
      }
    }
  }
  flush();
  return chunks;
}

function splitLine(line: string, limit: number, measure: (chunk: string) => number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (measure(rest) > limit) {
    // Longest prefix that fits.
    let end = rest.length;
    while (end > 1 && measure(rest.slice(0, end)) > limit) end--;
    pieces.push(rest.slice(0, breakPoint(rest, end)));
    rest = rest.slice(pieces.at(-1)!.length);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** A cut at or before `end`: after a space or punctuation, never inside a link. */
function breakPoint(text: string, end: number): number {
  let cut = end;
  for (const match of text.matchAll(LINK)) {
    const start = match.index;
    if (start < cut && cut < start + match[0].length && start > 0) cut = start;
  }
  if (cut < end) return cut;
  for (let i = cut; i > cut / 2; i--) {
    if (/[\s，。、；！？,.;!?]/.test(text[i - 1]!)) return i;
  }
  return cut;
}
