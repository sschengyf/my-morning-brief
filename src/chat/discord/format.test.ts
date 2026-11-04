import { describe, expect, it } from 'vitest';
import { toDiscordMessages } from './format.js';

const LINK = '[原文](https://www.rnz.co.nz/news/national/123456?a=1&b=2)';

describe('splitting', () => {
  it('splits Discord messages at 2000 characters', () => {
    const markdown = Array.from(
      { length: 50 },
      (_, i) => `${i}. ${'新闻'.repeat(30)} ${LINK}`,
    ).join('\n');
    const chunks = toDiscordMessages(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('\n')).toBe(markdown);
  });
});
