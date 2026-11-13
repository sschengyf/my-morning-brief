import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../test/helpers.js';
import { extractArticle } from './extract.js';

describe('extractArticle', () => {
  it('keeps the article paragraphs, one per line, without navigation, footer or scripts', async () => {
    const text = extractArticle(await readFixture('article/news-page.html'));
    expect(text).toContain('Outgoing National MP Vanessa Weenink says');
    expect(text).toContain('"God, it hurt us as a country," she said.');
    expect(text.split('\n').length).toBeGreaterThanOrEqual(5);
    expect(text).not.toMatch(/Subscribe to our newsletter|Copyright RNZ|trackPageView|dataLayer/);
  });

  it('makes one line per paragraph, whatever the line breaks in the source', async () => {
    const html = await readFixture('article/news-page.html');
    const minified = html.replace(/\s*\n\s*/g, ' ').replace(/>\s+</g, '><');
    for (const page of [html, minified]) {
      const lines = extractArticle(page).split('\n');
      expect(lines).toContain(
        'Outgoing National MP Vanessa Weenink says the compromise the party leader made around Treaty issues hurt the country.',
      );
      expect(lines).toContain(
        `"God, it hurt us as a country," she said. "I don't think we have recovered from that debate yet."`,
      );
    }
  });

  it('breaks the line at a <br> inside a paragraph', async () => {
    const html = (await readFixture('article/news-page.html')).replace(
      'Treaty issues hurt the country.',
      'Treaty issues hurt the country.<br>A second line.',
    );
    expect(extractArticle(html).split('\n')).toContain('A second line.');
  });

  it('finds next to nothing on a page without an article', () => {
    expect(extractArticle('<html><body><nav>Home</nav></body></html>').length).toBeLessThan(20);
  });
});
