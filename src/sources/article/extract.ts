import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, td';
const BREAK = ' ';

/**
 * The main text of a web page, one paragraph per line. Navigation, footers
 * and scripts are left out; a page without an article (a video page, a bot
 * check, a page that needs JavaScript) gives little or no text.
 */
export function extractArticle(html: string): string {
  const article = new Readability(parseHTML(html).document).parse();
  if (!article?.content) return '';
  // Line breaks in the source say nothing (minified pages have none, others
  // wrap mid-sentence), so paragraphs come from the block elements.
  const { document } = parseHTML(`<html><body>${article.content}</body></html>`);
  for (const block of document.querySelectorAll(BLOCKS)) block.append(BREAK);
  for (const br of document.querySelectorAll('br')) br.after(BREAK);
  const text: string = document.body.textContent ?? '';
  return text
    .split(BREAK)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}
