import { describe, expect, it } from 'vitest';
import { cleanSummary, normalizeLink, repeatsTitle } from './clean.js';

describe('normalizeLink', () => {
  it('removes tracking parameters and trailing slashes', () => {
    expect(normalizeLink('https://Example.com/a/?utm_source=x&id=3&fbclid=y')).toBe(
      'https://example.com/a?id=3',
    );
    expect(normalizeLink('https://example.com/')).toBe('https://example.com');
    expect(normalizeLink(' not a url ')).toBe('not a url');
  });
});

describe('repeatsTitle', () => {
  it('spots a summary that only repeats the title, as Google News feeds do', () => {
    const title = 'Breakingviews - COMMENTARY: COP31 will expose clean-energy tariffs - Reuters';
    expect(
      repeatsTitle(
        'Breakingviews - COMMENTARY: COP31 will expose clean-energy tariffs Reuters',
        title,
      ),
    ).toBe(true);
    expect(repeatsTitle('Breakingviews - COMMENTARY: COP31 will expose', title)).toBe(true);
  });

  it('keeps real summaries', () => {
    expect(
      repeatsTitle('Police confirmed three people were assaulted.', 'School in lockdown'),
    ).toBe(false);
    expect(repeatsTitle('', 'School in lockdown')).toBe(false);
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
