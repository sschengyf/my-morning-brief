import { describe, expect, it } from 'vitest';
import { ARTICLE_PROMPT, BRIEF_PROMPT, CHAT_PROMPT } from './prompts.js';

describe('prompts', () => {
  it('tells every prompt that writes about news to copy names and amounts as written', () => {
    for (const prompt of [BRIEF_PROMPT, CHAT_PROMPT, ARTICLE_PROMPT]) {
      expect(prompt).toContain('带着 $ 符号和英文单位');
      expect(prompt).toContain('名和姓的顺序也照抄');
    }
  });
});
