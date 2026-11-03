import { describe, expect, it } from 'vitest';
import { toDiscordMessages } from '../../src/chat/discord/format.js';
import { splitMessage } from '../../src/chat/split-message.js';
import {
  markdownToTelegramHtml,
  splitForTelegram,
  TELEGRAM_LIMIT,
} from '../../src/chat/telegram/format.js';

/** Every opening tag has its closing tag, in order. */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const [, closing, name] of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (!closing) stack.push(name!);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0;
}

const LINK = '[原文](https://www.rnz.co.nz/news/national/123456?a=1&b=2)';

describe('markdownToTelegramHtml', () => {
  it('escapes HTML before formatting, so text cannot add tags', () => {
    expect(markdownToTelegramHtml('1 < 2 & <b>x</b> **粗体**')).toBe(
      '1 &lt; 2 &amp; &lt;b&gt;x&lt;/b&gt; <b>粗体</b>',
    );
  });

  it('turns links into <a>, keeping & escaped in the href', () => {
    expect(markdownToTelegramHtml(`新闻 ${LINK}`)).toBe(
      '新闻 <a href="https://www.rnz.co.nz/news/national/123456?a=1&amp;b=2">原文</a>',
    );
    expect(markdownToTelegramHtml('[原文](<https://a.test/x>)')).toBe(
      '<a href="https://a.test/x">原文</a>',
    );
  });

  it('formats code and headings, leaving code contents alone', () => {
    expect(markdownToTelegramHtml('# 今天\n`**id**`')).toBe('<b>今天</b>\n<code>**id**</code>');
  });

  it('only links http(s) urls', () => {
    expect(markdownToTelegramHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
});

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

  it('keeps every Telegram chunk under the limit after conversion, with balanced tags', () => {
    const line = `**新闻** 一条很长的新闻概括，${'内容'.repeat(20)} ${LINK}`;
    const markdown = Array.from({ length: 120 }, () => line).join('\n');
    const chunks = splitForTelegram(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const html = markdownToTelegramHtml(chunk);
      expect(html.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(balanced(html)).toBe(true);
      expect(html).not.toMatch(/\[原文\]\(/); // every link survived whole
    }
    expect(chunks.join('\n')).toBe(markdown);
  });

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
