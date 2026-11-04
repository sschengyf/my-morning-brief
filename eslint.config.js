import { dirname, relative, resolve, sep } from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const SRC = resolve(import.meta.dirname, 'src');

// Lower layers never import higher ones. A module may use any module listed before it.
const LAYERS = [
  'infra',
  'location',
  'schedules',
  'sources',
  'llm',
  'archive',
  'brief',
  'chat',
  'scheduler',
  'app',
];

/** "infra" for src/infra/config/load.ts; null for src/index.ts or files outside src. */
function moduleOf(path) {
  const parts = relative(SRC, path).split(sep);
  return parts[0] === '..' || parts.length < 2 ? null : parts[0];
}

const moduleBoundaries = {
  meta: {
    type: 'problem',
    messages: {
      deep: '只能通过 {{module}}/index.ts 引用 {{module}} 模块，不要直接引用它内部的文件',
      layer: '{{from}} 不能依赖 {{to}}：依赖只能指向更底层的模块（{{order}}）',
      unknown: '{{module}} 不在 eslint.config.js 的 LAYERS 列表里',
    },
  },
  create(context) {
    const file = context.filename;
    const from = moduleOf(file);
    // Tests may reach into other modules' files to test them directly; layering still applies.
    const isTest = file.endsWith('.test.ts');
    if (from !== null && !LAYERS.includes(from)) {
      context.report({ loc: { line: 1, column: 0 }, messageId: 'unknown', data: { module: from } });
      return {};
    }
    const check = (node) => {
      const spec = node.source?.value;
      if (typeof spec !== 'string' || !spec.startsWith('.')) return;
      const target = resolve(dirname(file), spec);
      const to = moduleOf(target);
      if (to === null || to === from) return;
      if (!isTest && relative(resolve(SRC, to), target) !== 'index.js') {
        context.report({ node: node.source, messageId: 'deep', data: { module: to } });
      }
      if (from !== null && LAYERS.indexOf(to) >= LAYERS.indexOf(from)) {
        context.report({
          node: node.source,
          messageId: 'layer',
          data: { from, to, order: LAYERS.join(' → ') },
        });
      }
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
    };
  },
};

export default tseslint.config(
  { ignores: ['node_modules/', 'data/', 'archive/', 'logs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: { local: { rules: { 'module-boundaries': moduleBoundaries } } },
    rules: { 'local/module-boundaries': 'error' },
  },
  {
    // The logger is the only place allowed to write to the console.
    files: ['src/infra/logger.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
