import { logger as defaultLogger } from '#/infra/index.js';
import {
  addTodo,
  completeTodo,
  describeError,
  MsLoginNeeded,
  msAuthOptions,
  readTodos,
  startDeviceLogin,
  todoText,
} from '#/sources/index.js';
import type { Command, CommandContext } from '../context.js';

const READ_ONLY = '待办在 Microsoft To Do 里管理，请在 App 里修改；用 /todo 看当前列表';

export const todoCommand: Command = async (_args, io, ctx) => {
  let todos;
  try {
    todos = await readTodos(ctx.deps.config);
  } catch (error) {
    return io.reply(`待办获取失败：${describeError(error)}`);
  }
  if (todos.length === 0) return io.reply('没有未完成的待办 🎉');
  await io.reply(`未完成的待办：\n${todoText(ctx.deps.config, todos, await today(ctx))}`);
};

export const addCommand: Command = async (args, io, ctx) => {
  const { todo } = ctx.deps.config;
  if (todo.backend === 'ms_todo') return io.reply(READ_ONLY);
  if (!args) return io.reply('用法：/add 待办内容，例如 /add 交水费');
  const item = await addTodo(todo.file, args);
  ctx.invalidateData();
  await io.reply(`已添加：${item.text}（第 ${item.number} 项）`);
};

export const doneCommand: Command = async (args, io, ctx) => {
  const { todo } = ctx.deps.config;
  if (todo.backend === 'ms_todo') return io.reply(READ_ONLY);
  const number = Number(args);
  const done =
    Number.isInteger(number) && number > 0 ? await completeTodo(todo.file, number) : null;
  if (done === null) return io.reply('没有这个序号，先用 /todo 看看列表');
  ctx.invalidateData();
  await io.reply(`已完成：${done}`);
};

/**
 * Signs in to Microsoft To Do with a device code: replies with the code at
 * once, then waits for the sign-in in the background (so shutdown and other
 * messages never wait for it) and reports how it went.
 */
export const todoLoginCommand: Command = async (_args, io, ctx) => {
  const { config } = ctx.deps;
  if (config.todo.backend !== 'ms_todo') {
    return io.reply(
      '现在用的是 todo.md。想改用 Microsoft To Do：个人配置写 [todo] backend = "ms_todo"，共用配置写 [microsoft] client_id，重启后再发 /todo_login（见 README）',
    );
  }
  let login;
  try {
    login = await startDeviceLogin(msAuthOptions(config));
  } catch (error) {
    return io.reply(
      error instanceof MsLoginNeeded ? error.message : `登录失败：${describeError(error)}`,
    );
  }
  await io.reply(
    `打开 ${login.verificationUri} ，输入验证码 \`${login.userCode}\`，用你的 Microsoft 账号登录并同意授权（${login.expiresInMinutes} 分钟内有效）。`,
  );
  const logger = ctx.deps.logger ?? defaultLogger;
  void login.done
    .then(async (outcome) => {
      if (!outcome.ok) return io.reply(`Microsoft To Do 登录没有完成：${outcome.reason}`);
      ctx.invalidateData();
      const todos = await readTodos(config).catch(() => null);
      await io.reply(
        todos
          ? `已连接 Microsoft To Do，读到 ${todos.length} 条未完成待办`
          : '已连接 Microsoft To Do，但读取待办失败，用 /todo 再试试',
      );
    })
    .catch((error: unknown) => logger.warn('Microsoft To Do 登录结果没能发出', error));
};

async function today(ctx: CommandContext): Promise<string> {
  const location = await ctx.location();
  return ctx.now().setZone(location.timezone).toISODate()!;
}
