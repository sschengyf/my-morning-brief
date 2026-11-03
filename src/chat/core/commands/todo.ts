import { addTodo, completeTodo, formatTodos, listTodos } from '../../../sources/index.js';
import type { Command } from '../context.js';

export const todoCommand: Command = async (_args, io, ctx) => {
  const items = await listTodos(ctx.deps.config.todo.file);
  await io.reply(items.length ? `未完成的待办：\n${formatTodos(items)}` : '没有未完成的待办 🎉');
};

export const addCommand: Command = async (args, io, ctx) => {
  if (!args) return io.reply('用法：/add 待办内容，例如 /add 交水费');
  const item = await addTodo(ctx.deps.config.todo.file, args);
  ctx.invalidateData();
  await io.reply(`已添加：${item.text}（第 ${item.number} 项）`);
};

export const doneCommand: Command = async (args, io, ctx) => {
  const number = Number(args);
  const done =
    Number.isInteger(number) && number > 0
      ? await completeTodo(ctx.deps.config.todo.file, number)
      : null;
  if (done === null) return io.reply('没有这个序号，先用 /todo 看看列表');
  ctx.invalidateData();
  await io.reply(`已完成：${done}`);
};
