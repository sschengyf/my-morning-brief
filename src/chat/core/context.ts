import type { DateTime } from 'luxon';
import type { BriefDeps } from '#/brief/index.js';
import type { CityMatch, Location } from '#/location/index.js';
import type { ChatIO } from '../channel.js';

export interface ChatDeps extends BriefDeps {
  searchCity?: (name: string, country?: string) => Promise<CityMatch[]>;
}

/** What a command can use; ChatCore provides it. */
export interface CommandContext {
  deps: ChatDeps;
  now(): DateTime;
  /** The effective location, read fresh each time. */
  location(): Promise<Location>;
  /** Drops cached weather, calendar and todos, after a todo change or a city switch. */
  invalidateData(): void;
}

export type Command = (args: string, io: ChatIO, ctx: CommandContext) => Promise<void>;
