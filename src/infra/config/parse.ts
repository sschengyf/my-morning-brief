import { z } from 'zod';
import type { LoadConfigOptions } from './load.js';
import { resolvePaths } from './paths.js';
import { channelProblems, type Config, ConfigError, schema } from './schema.js';

/** Validates an already-parsed TOML object and resolves relative paths. */
export function parseConfig(
  raw: Record<string, unknown>,
  options: Pick<LoadConfigOptions, 'requireChannel'> = {},
): Config {
  const result = schema.safeParse(raw);
  const lines = result.success
    ? []
    : result.error.issues.map((issue) => `- ${describeIssue(issue, raw)}`);
  if (result.success && options.requireChannel !== false) {
    lines.push(...channelProblems(result.data).map((problem) => `- ${problem}`));
  }
  if (!result.success || lines.length > 0) {
    throw new ConfigError(`配置有误：\n${lines.join('\n')}`);
  }
  return resolvePaths(result.data);
}

function describeIssue(issue: z.core.$ZodIssue, raw: unknown): string {
  const key = issue.path.join('.');
  if (issue.code === 'invalid_type') {
    return valueAt(raw, issue.path) === undefined
      ? `缺少 ${key}`
      : `${key} 类型错误，应为 ${TYPE_NAMES[issue.expected] ?? issue.expected}`;
  }
  if (issue.code === 'invalid_format' && issue.format === 'url') return `${key} 不是有效的网址`;
  if (issue.code === 'too_small' || issue.code === 'too_big') return `${key} 超出允许范围`;
  if (issue.code === 'invalid_union') return `${key} 格式不对`;
  // Custom refinements and regex checks already carry Chinese messages.
  return `${key} ${issue.message}`;
}

const TYPE_NAMES: Record<string, string> = {
  string: '字符串',
  number: '数字',
  int: '整数',
  boolean: 'true 或 false',
  array: '数组',
  object: '表（[section]）',
};

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
