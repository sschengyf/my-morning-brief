import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isNotFound, writeFileAtomic } from '../../infra/index.js';
import { oneLine } from '../common.js';

export interface TodoItem {
  /** 1-based position among open todos, as shown to the user. */
  number: number;
  text: string;
}

const NEW_FILE = '# 待办\n\n';
// "- [ ] text" or "- [x] text", optionally indented; "*" bullets as Obsidian also writes them.
const TODO_LINE = /^(\s*[-*] \[)([ xX])(\] ?)(.*)$/;

// Reads and writes go through one queue, so /add and /done arriving together
// cannot overwrite each other's change.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

interface TodoFile {
  lines: string[];
  eol: string;
}

/** Reads the file fresh every time; Obsidian may have changed it. Creates it when missing. */
async function readTodoFile(file: string): Promise<TodoFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, NEW_FILE);
    text = NEW_FILE;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { lines: text.split(eol), eol };
}

function writeTodoFile(file: string, { lines, eol }: TodoFile): Promise<void> {
  return writeFileAtomic(file, lines.join(eol));
}

/** Indexes into `lines` of the open todos, in file order. */
function openLineIndexes(lines: string[]): number[] {
  return lines.flatMap((line, index) => {
    const match = TODO_LINE.exec(line);
    return match?.[2] === ' ' && match[4]!.trim() ? [index] : [];
  });
}

function itemText(line: string): string {
  return TODO_LINE.exec(line)![4]!.trim();
}

export function listTodos(file: string): Promise<TodoItem[]> {
  return serialized(async () => {
    const { lines } = await readTodoFile(file);
    return openLineIndexes(lines).map((index, i) => ({
      number: i + 1,
      text: itemText(lines[index]!),
    }));
  });
}

/** Appends an open todo and returns its number. */
export function addTodo(file: string, text: string): Promise<TodoItem> {
  const content = oneLine(text);
  if (!content) return Promise.reject(new Error('待办内容不能为空'));
  return serialized(async () => {
    const todo = await readTodoFile(file);
    // Text ending in a newline splits into a trailing ""; insert before it to keep that newline.
    const endsWithNewline = todo.lines.at(-1) === '';
    const at = endsWithNewline ? todo.lines.length - 1 : todo.lines.length;
    todo.lines.splice(at, 0, `- [ ] ${content}`);
    if (!endsWithNewline) todo.lines.push('');
    await writeTodoFile(file, todo);
    return { number: openLineIndexes(todo.lines).length, text: content };
  });
}

/**
 * Marks the open todo with this number done and returns its text, so the user
 * can see which item it was if the file changed since they last listed it.
 * Returns null when there is no such number.
 */
export function completeTodo(file: string, number: number): Promise<string | null> {
  return serialized(async () => {
    const todo = await readTodoFile(file);
    const index = openLineIndexes(todo.lines)[number - 1];
    if (index === undefined) return null;
    const line = todo.lines[index]!;
    todo.lines[index] = line.replace(TODO_LINE, '$1x$3$4');
    await writeTodoFile(file, todo);
    return itemText(line);
  });
}
