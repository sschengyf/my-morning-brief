import { DateTime } from 'luxon';
import type { Archive } from '../../archive/index.js';
import type { BriefRunResult } from '../../brief/index.js';
import type { ChatMessage } from '../../llm/index.js';
import type { NumberedNews } from '../../sources/index.js';
import { linksToIds } from './links.js';

/** Ten rounds of question and answer. */
const MAX_HISTORY = 20;

export interface TodayBrief {
  date: string;
  /** Epoch ms, to tell whether the archive holds a newer brief. */
  generatedAt: number;
  /** The brief with links turned back into ids, as the model wrote it. */
  text: string;
  news: NumberedNews[];
}

/**
 * Today's brief and the conversation about it. The brief opens the history,
 * so follow-up questions refer to it; only memory, never saved.
 */
export class Conversation {
  private brief: TodayBrief | null = null;
  private messages: ChatMessage[] = [];
  /** The date the conversation belongs to. */
  private date: string | null = null;

  constructor(private readonly archive: Archive) {}

  get today(): TodayBrief | null {
    return this.brief;
  }

  get history(): ChatMessage[] {
    return this.messages;
  }

  /** A brief was just delivered: it starts a new conversation. */
  startWith(result: BriefRunResult): void {
    if (result.text === undefined) return;
    const text = linksToIds(result.text, result.news);
    const generatedAt = DateTime.fromISO(result.generatedAt).toMillis();
    this.brief = { date: result.date, generatedAt, text, news: result.news };
    this.messages = [{ role: 'assistant', content: text }];
    this.date = result.date;
  }

  /**
   * Makes `today` the latest brief of `date`: keeps the one in memory unless
   * the archive has a newer one (brief:once runs in another process). Once
   * the date has moved on, yesterday's brief and questions are dropped, so
   * "the first story" cannot mean yesterday's.
   */
  async sync(date: string): Promise<void> {
    if (this.date !== date) {
      this.date = date;
      this.brief = null;
      this.messages = [];
    }
    const stored = await this.archive.latestBrief(date);
    const current = this.brief;
    const storedAt = stored ? DateTime.fromISO(stored.raw.generatedAt).toMillis() : -Infinity;
    if (!stored || (current && current.generatedAt >= storedAt)) {
      this.brief = current;
      return;
    }
    const news = stored.raw.news?.selected ?? [];
    const text = linksToIds(stored.text, news);
    this.brief = { date, generatedAt: storedAt, text, news };
    if (this.messages[0]?.content !== text) this.messages = [{ role: 'assistant', content: text }];
  }

  /** Records one round, keeping the brief that opened the conversation plus the latest rounds. */
  add(question: string, answer: string): void {
    this.messages.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    const pinned = this.brief && this.messages[0]?.content === this.brief.text ? 1 : 0;
    const rest = this.messages.slice(pinned);
    if (rest.length > MAX_HISTORY) {
      this.messages = [...this.messages.slice(0, pinned), ...rest.slice(-MAX_HISTORY)];
    }
  }

  /** Forgets the questions, keeping today's brief. */
  clear(): void {
    this.messages = this.brief ? [{ role: 'assistant', content: this.brief.text }] : [];
  }
}
