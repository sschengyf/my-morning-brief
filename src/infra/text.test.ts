import { describe, expect, it } from 'vitest';
import { looksLikeDomain } from './text.js';

describe('looksLikeDomain', () => {
  it('spots domains anywhere in the text, and gives the same answer every time', () => {
    expect(looksLikeDomain('interest.co.nz')).toBe(true);
    expect(looksLikeDomain('Latest stories from interest.co.nz')).toBe(true);
    expect(looksLikeDomain('Latest stories from interest.co.nz')).toBe(true);
  });

  it('accepts ordinary names', () => {
    expect(looksLikeDomain('interest')).toBe(false);
    expect(looksLikeDomain('NZ Herald')).toBe(false);
    expect(looksLikeDomain('SCMP 中国')).toBe(false);
  });
});
