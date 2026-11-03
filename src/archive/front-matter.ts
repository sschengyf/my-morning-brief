import type { ArchiveRaw } from './types.js';

/** YAML front matter, which Obsidian shows as note properties. */
export function frontMatter(raw: ArchiveRaw): string {
  return [
    '---',
    `generated_at: ${raw.generatedAt}`,
    `kind: ${raw.kind}`,
    `city: ${JSON.stringify(raw.location.city)}`,
    `timezone: ${raw.location.timezone}`,
    `model: ${JSON.stringify(raw.model)}`,
    `fallback: ${raw.fallback}`,
    '---',
    '',
    '',
  ].join('\n');
}

export function stripFrontMatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}
