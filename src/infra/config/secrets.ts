import type { Config } from './schema.js';

/** Values that must never appear in logs. */
export function secretsOf(config: Config): string[] {
  return [
    config.telegram.bot_token,
    config.discord.bot_token,
    config.discord.user_id,
    ...config.calendar.ics_urls,
    ...config.calendar.ics_urls.map((url) => url.replace(/^webcal:\/\//i, 'https://')),
    config.monitor.healthcheck_url,
  ].filter((value) => value.length > 0);
}
