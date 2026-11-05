import { type NewsItem, wrapData } from '#/sources/index.js';

export interface PickRequest {
  /** In round-robin order; the model sees them as C1, C2, … */
  candidates: NewsItem[];
  count: number;
  interests: string[];
  avoid: string[];
  timeoutSeconds: number;
}

/**
 * What the model picks from: ids, sources and titles only. Summaries would make
 * fifty candidates long, and links are never shown to the model.
 */
export function formatPickInput(request: PickRequest): string {
  const lines = request.candidates.map(
    (item, index) => `[C${index + 1}] 来源 ${item.source}｜${item.title}`,
  );
  const preferences = [
    request.interests.length > 0 && `用户兴趣：${request.interests.join('、')}`,
    request.avoid.length > 0 && `不想看：${request.avoid.join('、')}`,
  ].filter((part): part is string => typeof part === 'string');
  return [
    ...(preferences.length > 0 ? [preferences.join('；')] : []),
    `要挑的条数：${request.count}`,
    wrapData('候选新闻', lines.join('\n')),
  ].join('\n\n');
}

/** Candidate numbers in the order the model wrote them: "C3, C17,c8" → [3, 17, 8]. */
export function parsePicks(reply: string): number[] {
  return [...reply.matchAll(/\bC\s*(\d+)/gi)].map((match) => Number(match[1]));
}
