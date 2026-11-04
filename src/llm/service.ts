import { logger as defaultLogger, type Logger } from '#/infra/index.js';
import {
  type FeedFailure,
  formatNews,
  type GatherInput,
  gatherText,
  type NewsItem,
  type NumberedNews,
  numberNews,
} from '#/sources/index.js';
import { BRIEF_PROMPT, CHAT_PROMPT } from './prompts.js';
import { sanitizeOutput, stripThink, usedNewsIds } from './sanitize.js';
import type { ChatMessage, LlmClient } from './types.js';

export interface BriefData {
  /** Everything except news, which is formatted here so it can be trimmed to fit. */
  gather: Omit<GatherInput, 'news'>;
  /** Omitted when news is skipped today. */
  news?: { items: NewsItem[]; failures: FeedFailure[] };
}

export interface BriefResult {
  brief: string;
  /** Exactly what the model was given, for the archive. */
  input: string;
  /** The news the model saw, numbered as it saw them. */
  news: NumberedNews[];
  /** Ids the brief actually mentions; only these count as used for cross-day dedup. */
  usedIds: string[];
}

export type LlmTask = 'brief' | 'chat';

/** Rough token estimate: one per CJK character, one per four other characters. */
export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

const CONTEXT_BUDGET = 0.75;

/** Serializes model requests and knows what is running, so the bot can tell the user to wait. */
export class LlmService {
  private queue: Promise<unknown> = Promise.resolve();
  private running: LlmTask | null = null;
  private waiting = 0;

  constructor(
    private readonly client: LlmClient,
    private readonly numCtx: number,
    private readonly logger: Logger = defaultLogger,
  ) {}

  isBusy(): boolean {
    return this.running !== null || this.waiting > 0;
  }

  currentTask(): LlmTask | null {
    return this.running;
  }

  private run<T>(task: LlmTask, work: () => Promise<T>): Promise<T> {
    this.waiting++;
    const start = async () => {
      this.waiting--;
      this.running = task;
      try {
        return await work();
      } finally {
        this.running = null;
      }
    };
    const result = this.queue.then(start, start);
    this.queue = result.catch(() => undefined);
    return result;
  }

  writeBrief(data: BriefData): Promise<BriefResult> {
    const { input, news } = this.fitBriefInput(data);
    return this.run('brief', async () => {
      const reply = await this.client.chat([
        { role: 'system', content: BRIEF_PROMPT },
        { role: 'user', content: input },
      ]);
      const text = stripThink(reply);
      return {
        brief: sanitizeOutput(text, news),
        input,
        news,
        usedIds: usedNewsIds(text, news),
      };
    });
  }

  /** `context` is today's gathered data; `news` maps the ids that appear in it. */
  answer(
    context: { text: string; news: NumberedNews[] },
    history: ChatMessage[],
    question: string,
  ): Promise<string> {
    return this.run('chat', async () => {
      const reply = await this.client.chat([
        { role: 'system', content: `${CHAT_PROMPT}\n\n${context.text}` },
        ...history,
        { role: 'user', content: question },
      ]);
      return sanitizeOutput(stripThink(reply), context.news);
    });
  }

  /**
   * Builds the brief input, dropping news from the end until it fits in 75% of
   * num_ctx; Ollama would otherwise cut the input silently.
   */
  private fitBriefInput(data: BriefData): { input: string; news: NumberedNews[] } {
    const budget = Math.floor(this.numCtx * CONTEXT_BUDGET);
    const build = (count: number) => {
      const news = numberNews(data.news?.items.slice(0, count) ?? []);
      const newsText = data.news && formatNews(news, data.news.failures);
      const input = gatherText({
        ...data.gather,
        ...(newsText !== undefined && { news: newsText }),
      });
      return { input, news, tokens: estimateTokens(BRIEF_PROMPT) + estimateTokens(input) };
    };

    const total = data.news?.items.length ?? 0;
    let attempt = build(total);
    if (attempt.tokens <= budget) return attempt;

    const first = attempt.tokens;
    for (let count = total - 1; count >= 0 && attempt.tokens > budget; count--) {
      attempt = build(count);
    }
    this.logger.warn(
      `早报输入约 ${first} token，超过 num_ctx（${this.numCtx}）的 75%，新闻从 ${total} 条减到 ${attempt.news.length} 条`,
    );
    return attempt;
  }
}
