import { describe, expect, it } from 'vitest';
import { cleanSummary, normalizeLink } from './clean.js';

describe('normalizeLink', () => {
  it('removes tracking parameters and trailing slashes', () => {
    expect(normalizeLink('https://Example.com/a/?utm_source=x&id=3&fbclid=y')).toBe(
      'https://example.com/a?id=3',
    );
    expect(normalizeLink('https://example.com/')).toBe('https://example.com');
    expect(normalizeLink(' not a url ')).toBe('not a url');
  });
});

describe('cleanSummary', () => {
  it('strips HTML and URLs and truncates to 200 characters', () => {
    expect(cleanSummary('<p>Hello <b>world</b></p> see https://x.test/a')).toBe('Hello world see');
    const long = cleanSummary('长'.repeat(300));
    expect([...long]).toHaveLength(201);
    expect(long.endsWith('…')).toBe(true);
  });
});
