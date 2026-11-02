export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

type Writer = (level: LogLevel, line: string) => void;

const REDACTED = '***';

// Matches Telegram bot tokens even before config is loaded, e.g. inside
// grammY error messages like https://api.telegram.org/bot123:ABC/getUpdates.
const TELEGRAM_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

// Very short values would redact unrelated text, so they are not registered.
const MIN_SECRET_LENGTH = 6;

const secrets = new Set<string>();

export function registerSecrets(values: Iterable<string | undefined | null>): void {
  for (const value of values) {
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  }
}

export function clearSecretsForTesting(): void {
  secrets.clear();
}

export function redact(text: string): string {
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of ordered) result = result.split(secret).join(REDACTED);
  return result.replace(TELEGRAM_TOKEN_PATTERN, REDACTED);
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    const cause = detail.cause === undefined ? '' : `\nCaused by: ${formatDetail(detail.cause)}`;
    return (detail.stack ?? `${detail.name}: ${detail.message}`) + cause;
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function formatLine(level: LogLevel, message: string, details: unknown[], now = new Date()) {
  const parts = [message, ...details.map(formatDetail)];
  return redact(`${now.toISOString()} [${level.toUpperCase()}] ${parts.join(' ')}`);
}

const consoleWriter: Writer = (level, line) => {
  if (level === 'info') console.log(line);
  else console.error(line);
};

export function createLogger(writer: Writer = consoleWriter): Logger {
  const log =
    (level: LogLevel) =>
    (message: string, ...details: unknown[]) =>
      writer(level, formatLine(level, message, details));
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

export const logger = createLogger();
