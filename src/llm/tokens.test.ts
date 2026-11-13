import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('counts a CJK character as one token and four other characters as one', () => {
    expect(estimateTokens('今天晴')).toBe(3);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('今天 sunny')).toBe(4);
  });
});
