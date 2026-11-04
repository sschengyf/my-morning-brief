import { describe, expect, it } from 'vitest';
import { splitMessage } from './split-message.js';

const LINK = '[原文](https://www.rnz.co.nz/news/national/123456?a=1&b=2)';

describe('splitting', () => {
  it('keeps short messages whole', () => {
    expect(splitMessage('a\n\nb', 100)).toEqual(['a\n\nb']);
  });

  it('splits at paragraphs first, then lines', () => {
    const paragraph = 'x'.repeat(60);
    expect(splitMessage(`${paragraph}\n\n${paragraph}`, 100)).toEqual([paragraph, paragraph]);
    expect(splitMessage(`${paragraph}\n${paragraph}`, 100)).toEqual([paragraph, paragraph]);
  });

  it('never cuts a link in half on an overlong line', () => {
    const line = `${'字'.repeat(80)}${LINK}${'字'.repeat(80)}`;
    const chunks = splitMessage(line, 100);
    expect(chunks.join('')).toBe(line);
    expect(chunks.some((chunk) => chunk.includes(LINK))).toBe(true);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });
});
