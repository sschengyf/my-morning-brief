import type { Logger } from '#/infra/index.js';

const TIMEOUT_MS = 10_000;

export type HealthOutcome = 'success' | 'fail';

/** Reports how a scheduled brief went; never throws. */
export type Healthcheck = (outcome: HealthOutcome, message: string) => Promise<void>;

/**
 * Pings monitor.healthcheck_url (healthchecks.io style): the URL on success,
 * `<url>/fail` when a brief is given up. The message goes in the body, which
 * the service shows in its event log. No URL, no requests.
 */
export function createHealthcheck(
  url: string,
  logger: Logger,
  fetchFn: typeof fetch = fetch,
): Healthcheck {
  if (!url) return async () => undefined;
  return async (outcome, message) => {
    try {
      const response = await fetchFn(outcome === 'fail' ? failUrl(url) : url, {
        method: 'POST',
        body: message,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) logger.warn(`健康检查请求失败：HTTP ${response.status}`);
    } catch (error) {
      logger.warn('健康检查请求失败', error);
    }
  };
}

export function failUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/fail`;
  return parsed.toString();
}
