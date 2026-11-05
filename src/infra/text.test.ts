import { describe, expect, it } from 'vitest';
import { defuseDomains, looksLikeDomain, stripDomains } from './text.js';

describe('looksLikeDomain', () => {
  it('spots domains anywhere in the text, and gives the same answer every time', () => {
    expect(looksLikeDomain('interest.co.nz')).toBe(true);
    expect(looksLikeDomain('Latest stories from interest.co.nz')).toBe(true);
    expect(looksLikeDomain('Latest stories from interest.co.nz')).toBe(true);
  });

  it('strips domains, or keeps them readable but not linkable', () => {
    expect(stripDomains('see evil.com/login now')).toBe('see  now');
    expect(defuseDomains('Latest stories from interest.co.nz')).toBe(
      'Latest stories from interest．co．nz',
    );
    expect(looksLikeDomain(defuseDomains('interest.co.nz'))).toBe(false);
  });

  it('accepts ordinary names', () => {
    expect(looksLikeDomain('interest')).toBe(false);
    expect(looksLikeDomain('NZ Herald')).toBe(false);
    expect(looksLikeDomain('SCMP 中国')).toBe(false);
  });
});
