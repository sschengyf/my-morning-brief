/** Rough token estimate: one per CJK character, one per four other characters. */
export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}
