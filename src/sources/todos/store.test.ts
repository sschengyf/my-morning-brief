import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../test/helpers.js';
import { fetchTodos, formatTodos } from './source.js';
import { addTodo, completeTodo, listTodos } from './store.js';

async function todoFile(content?: string): Promise<string> {
  const file = join(await makeTempDir(), 'todo.md');
  if (content !== undefined) await writeFile(file, content);
  return file;
}

const OBSIDIAN_NOTE = [
  '# 待办',
  '',
  'Some notes I keep here.',
  '- [ ] Renew passport 📅 2026-11-05',
  '- [x] Book dentist',
  '  - [ ] Pack charger',
  '* [ ] Call mum',
  '- [ ] ',
  '',
].join('\n');

describe('todos', () => {
  it('creates the file with a heading when it is missing', async () => {
    const file = join(await makeTempDir(), 'nested', 'todo.md');
    expect(await listTodos(file)).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe('# 待办\n\n');
  });

  it('lists open todos in file order, keeping Obsidian Tasks dates as written', async () => {
    const file = await todoFile(OBSIDIAN_NOTE);
    expect(await listTodos(file)).toEqual([
      { number: 1, text: 'Renew passport 📅 2026-11-05' },
      { number: 2, text: 'Pack charger' },
      { number: 3, text: 'Call mum' },
    ]);
  });

  it('adds a todo at the end and leaves everything else untouched', async () => {
    const file = await todoFile(OBSIDIAN_NOTE);
    expect(await addTodo(file, '  Buy\nmilk ')).toEqual({ number: 4, text: 'Buy milk' });
    expect(await readFile(file, 'utf8')).toBe(OBSIDIAN_NOTE + '- [ ] Buy milk\n');
  });

  it('adds a newline first when the file does not end with one', async () => {
    const file = await todoFile('# 待办\n- [ ] First');
    await addTodo(file, 'Second');
    expect(await readFile(file, 'utf8')).toBe('# 待办\n- [ ] First\n- [ ] Second\n');
  });

  it('refuses an empty todo', async () => {
    await expect(addTodo(await todoFile(), '   ')).rejects.toThrow('待办内容不能为空');
  });

  it('completes by number and returns the completed text', async () => {
    const file = await todoFile(OBSIDIAN_NOTE);
    expect(await completeTodo(file, 2)).toBe('Pack charger');
    expect(await readFile(file, 'utf8')).toBe(
      OBSIDIAN_NOTE.replace('  - [ ] Pack charger', '  - [x] Pack charger'),
    );
    expect((await listTodos(file)).map((todo) => todo.text)).toEqual([
      'Renew passport 📅 2026-11-05',
      'Call mum',
    ]);
  });

  it('returns null for a number that does not exist', async () => {
    const file = await todoFile(OBSIDIAN_NOTE);
    expect(await completeTodo(file, 0)).toBeNull();
    expect(await completeTodo(file, 4)).toBeNull();
    expect(await readFile(file, 'utf8')).toBe(OBSIDIAN_NOTE);
  });

  it('keeps CRLF line endings', async () => {
    const crlf = OBSIDIAN_NOTE.replaceAll('\n', '\r\n');
    const file = await todoFile(crlf);
    await addTodo(file, 'Buy milk');
    await completeTodo(file, 1);
    expect(await readFile(file, 'utf8')).toBe(
      crlf.replace('- [ ] Renew', '- [x] Renew') + '- [ ] Buy milk\r\n',
    );
  });

  it('reads the file fresh each time, so outside edits are seen', async () => {
    const file = await todoFile('- [ ] A\n- [ ] B\n');
    await listTodos(file);
    await writeFile(file, '- [ ] B\n'); // edited in Obsidian meanwhile
    expect(await completeTodo(file, 1)).toBe('B');
  });

  it('does not lose writes when commands arrive together', async () => {
    const file = await todoFile();
    await Promise.all(['A', 'B', 'C', 'D'].map((text) => addTodo(file, text)));
    expect((await listTodos(file)).map((todo) => todo.text).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('formats the list for the brief', async () => {
    expect(formatTodos([])).toBe('没有未完成的待办');
    const result = await fetchTodos(await todoFile('- [ ] A\n- [ ] B\n'));
    expect(result).toEqual({
      text: '1. A\n2. B',
      raw: {
        open: [
          { number: 1, text: 'A' },
          { number: 2, text: 'B' },
        ],
      },
      ok: true,
    });
  });

  it('reports a read failure instead of throwing', async () => {
    const dir = await makeTempDir(); // a directory cannot be read as a file
    const result = await fetchTodos(dir);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/^（待办读取失败：/);
  });
});
