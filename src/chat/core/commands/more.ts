import { logger as defaultLogger } from '#/infra/index.js';
import { LlmError } from '#/llm/index.js';
import {
  type ArticleResult,
  describeError,
  fetchArticle,
  type NumberedNews,
} from '#/sources/index.js';
import type { ChatIO } from '../../channel.js';
import type { ChatDeps } from '../context.js';
import { linksToIds } from '../links.js';

const USAGE =
  '用法：/more 编号或描述，例如 /more 3、/more 加州富人税（编号是早报里新闻前面的数字）';
const NOT_MATCHED = '没认出是哪条，用编号试试，例如 /more 3';

/** A news number the user typed, and whether they typed more than one. */
export interface NewsNumber {
  number: number;
  more: boolean;
}

/**
 * "3", "３", "#3", "N3", "第3条" (several separated by spaces or commas also
 * count, the first one wins); null for anything else, which is a description
 * for the model. "第三条" stays a description.
 */
export function parseNewsNumber(args: string): NewsNumber | null {
  const normal = args
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/＃/g, '#')
    .trim();
  const spaced = /^第\s*(\d+)\s*[条则]?$/.exec(normal);
  if (spaced) return { number: Number(spaced[1]), more: false };
  const parts = normal.split(/[\s,，、]+/).filter((part) => part !== '');
  const numbers = parts.map((part) => /^(?:#|N)?(\d+)$/i.exec(part)?.[1]);
  if (numbers.length === 0 || numbers.some((n) => n === undefined)) return null;
  return { number: Number(numbers[0]), more: numbers.length > 1 };
}

export interface MoreOptions {
  /** Today's latest brief's news, null when there is no brief yet; may wait for the model. */
  news: () => Promise<NumberedNews[] | null>;
  /** Tells the user when the model is busy; called only right before /more queues for it. */
  noticeIfBusy: () => Promise<void>;
  /** Records the round in the conversation, so follow-up questions see the summary. */
  remember: (question: string, answer: string) => void;
}

/** /more: an in-depth summary of one story of today's latest brief, from its article. */
export async function moreCommand(
  args: string,
  io: ChatIO,
  deps: ChatDeps,
  options: MoreOptions,
): Promise<void> {
  const description = args.trim();
  if (!description) return io.reply(USAGE);
  const stop = io.typing();
  try {
    const news = await options.news();
    if (!news) return await io.reply('今天的早报还没生成');
    await summarize(description, news, io, deps, options);
  } finally {
    stop();
  }
}

async function summarize(
  description: string,
  news: NumberedNews[],
  io: ChatIO,
  deps: ChatDeps,
  { noticeIfBusy, remember }: MoreOptions,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  const parsed = parseNewsNumber(description);
  let item: NumberedNews | undefined;
  if (parsed) {
    item = news.find((candidate) => candidate.id === `N${parsed.number}`);
    if (!item) return io.reply(`今天最近一份早报里没有第 ${parsed.number} 条`);
  } else {
    if (news.length === 0) return io.reply(NOT_MATCHED);
    await noticeIfBusy();
    const id = await deps.llm
      .matchNews(news, description, deps.config.news.select_timeout_seconds)
      .catch((error: unknown) => {
        logger.warn(`/more 认新闻失败（描述“${description}”）`, error);
        return undefined;
      });
    item = news.find((candidate) => candidate.id === id);
    if (id !== undefined && !item) logger.info(`/more 没认出描述“${description}”是哪条`);
    if (!item) return io.reply(NOT_MATCHED);
  }
  const label = `/more ${item.id}（${parsed ? '' : `按描述“${description}”认出；`}${item.source}，${domain(item.link)}）`;

  if (parsed) await noticeIfBusy();
  await io.reply('正在读原文，稍等');
  const started = performance.now();
  let reply: string;
  try {
    const article = await (deps.fetchArticle ?? fetchArticle)(item.link);
    const read = performance.now() - started;
    const { text, truncated } = await deps.llm.summarizeArticle(item, article);
    logger.info(
      `${label}：${describeRead(article, truncated)}，网页 ${seconds(read)}，模型 ${seconds(performance.now() - started - read)}`,
    );
    reply = parsed?.more ? `${text}\n\n（一次看一条，其他的再发 /more）` : text;
  } catch (error) {
    logger.warn(`${label}总结失败`, error);
    const reason = error instanceof LlmError ? error.message : describeError(error);
    return io.reply(`总结失败：${reason}，稍后再试\n[原文](${item.link})`);
  }
  remember(`/more ${item.id.slice(1)}（${item.title}）`, linksToIds(reply, news));
  await io.reply(reply);
}

function describeRead(article: ArticleResult, truncated: boolean): string {
  if (!article.ok) return `没读到原文（${article.reason}），用摘要`;
  return `读到原文 ${article.text.length} 字，${truncated ? '截断' : '未截断'}`;
}

function domain(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return '未知域名';
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}
