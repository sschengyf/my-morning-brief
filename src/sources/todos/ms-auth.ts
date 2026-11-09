import { readFile } from 'node:fs/promises';
import { isNotFound, registerSecrets, writeFileAtomic } from '#/infra/index.js';
import { REQUEST_TIMEOUT_MS } from '../common.js';

// Personal Microsoft accounts only, as the app registration allows.
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'Tasks.Read offline_access';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** Discord interaction replies expire after 15 minutes, so the login must finish before. */
const MAX_LOGIN_MS = 14 * 60_000;

export const NOT_LOGGED_IN = '还没有登录 Microsoft To Do，在聊天里发 /todo_login';
const LOGIN_EXPIRED = 'Microsoft To Do 的登录已失效，请发 /todo_login 重新登录';

/** A failure only logging in again fixes; its message tells the user how. */
export class MsLoginNeeded extends Error {
  override name = 'MsLoginNeeded';
}

export interface MsAuthOptions {
  clientId: string;
  /** data_dir/ms-token.json */
  tokenFile: string;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * False for brief:dry: a refreshed token is used but not written back, so a
   * dry run never replaces the token a running container relies on.
   */
  save?: boolean;
}

interface StoredTokens {
  refresh_token: string;
  access_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
}

// One refresh at a time per token file: refresh tokens rotate, so two refreshes
// racing could each store a token the other has already replaced.
const queues = new Map<string, Promise<unknown>>();
const loginsWaiting = new Set<string>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * A valid access token, refreshed (and stored) when it is about to expire, or
 * when `forceRefresh` because Microsoft Graph rejected the current one.
 */
export function accessToken(options: MsAuthOptions, forceRefresh = false): Promise<string> {
  return serialized(options.tokenFile, async () => {
    const now = (options.now ?? Date.now)();
    const stored = await readTokens(options.tokenFile);
    if (!forceRefresh && stored.expires_at - EXPIRY_MARGIN_MS > now) return stored.access_token;
    const reply = await postToken(options, {
      grant_type: 'refresh_token',
      refresh_token: stored.refresh_token,
      scope: SCOPES,
    });
    if (reply.error === 'invalid_grant') throw new MsLoginNeeded(LOGIN_EXPIRED);
    const tokens = toStored(reply, stored.refresh_token, now);
    if (!tokens) throw new Error(`Microsoft 登录服务出错（${reply.error ?? '回复不完整'}）`);
    if (options.save !== false) await saveTokens(options.tokenFile, tokens);
    return tokens.access_token;
  });
}

export interface DeviceLogin {
  /** Shown to the user: open this page and enter the code. */
  verificationUri: string;
  userCode: string;
  expiresInMinutes: number;
  /** Settles once the user has signed in, declined, or the code expired. */
  done: Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Starts the device code flow: returns the code for the user at once and
 * polls for the tokens in the background. One login per token file at a time.
 */
export async function startDeviceLogin(
  options: MsAuthOptions & { sleep?: (ms: number) => Promise<void> },
): Promise<DeviceLogin> {
  if (loginsWaiting.has(options.tokenFile)) {
    throw new MsLoginNeeded('上一个登录还在等待，先完成它，或者等验证码过期后再试');
  }
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${AUTHORITY}/devicecode`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: options.clientId, scope: SCOPES }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const code = (await response.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
  };
  if (!response.ok || !code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error(`Microsoft 登录服务出错（${code.error ?? `HTTP ${response.status}`}）`);
  }
  const now = options.now ?? Date.now;
  const waitMs = Math.min((code.expires_in ?? 900) * 1000, MAX_LOGIN_MS);
  loginsWaiting.add(options.tokenFile);
  const done = pollForTokens(options, code.device_code, (code.interval ?? 5) * 1000, now() + waitMs)
    .catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => loginsWaiting.delete(options.tokenFile));
  return {
    verificationUri: code.verification_uri,
    userCode: code.user_code,
    expiresInMinutes: Math.floor(waitMs / 60_000),
    done,
  };
}

async function pollForTokens(
  options: MsAuthOptions & { sleep?: (ms: number) => Promise<void> },
  deviceCode: string,
  intervalMs: number,
  deadline: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let interval = intervalMs;
  while (now() + interval < deadline) {
    await sleep(interval);
    // A network blip while waiting is not fatal: the next poll tries again.
    const reply = await postToken(options, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
    }).catch((): TokenReply => ({ error: 'authorization_pending' }));
    const tokens = toStored(reply, null, now());
    if (tokens) {
      await saveTokens(options.tokenFile, tokens);
      return { ok: true };
    }
    if (reply.error === 'authorization_pending') continue;
    if (reply.error === 'slow_down') {
      interval += 5_000;
      continue;
    }
    if (reply.error === 'authorization_declined') return { ok: false, reason: '你拒绝了授权' };
    if (reply.error === 'expired_token') break;
    return { ok: false, reason: `Microsoft 登录服务出错（${reply.error ?? '回复不完整'}）` };
  }
  return { ok: false, reason: '验证码已过期，请重新发 /todo_login' };
}

async function postToken(options: MsAuthOptions, params: Record<string, string>) {
  const response = await (options.fetch ?? fetch)(`${AUTHORITY}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: options.clientId, ...params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const reply = (await response.json().catch(() => ({}))) as TokenReply;
  if (!response.ok && !reply.error) reply.error = `HTTP ${response.status}`;
  return reply;
}

/** The tokens to store from a token reply; a refresh may not return a new refresh token. */
function toStored(reply: TokenReply, previousRefresh: string | null, now: number) {
  const refresh = reply.refresh_token ?? previousRefresh;
  if (!reply.access_token || !refresh || !reply.expires_in) return null;
  return {
    refresh_token: refresh,
    access_token: reply.access_token,
    expires_at: now + reply.expires_in * 1000,
  } satisfies StoredTokens;
}

async function readTokens(file: string): Promise<StoredTokens> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw new MsLoginNeeded(NOT_LOGGED_IN);
    throw error;
  }
  let tokens: Partial<StoredTokens>;
  try {
    tokens = JSON.parse(text) as Partial<StoredTokens>;
  } catch {
    throw new MsLoginNeeded(LOGIN_EXPIRED);
  }
  if (typeof tokens.refresh_token !== 'string' || typeof tokens.access_token !== 'string') {
    throw new MsLoginNeeded(LOGIN_EXPIRED);
  }
  registerSecrets([tokens.refresh_token, tokens.access_token]);
  return { ...tokens, expires_at: Number(tokens.expires_at) || 0 } as StoredTokens;
}

async function saveTokens(file: string, tokens: StoredTokens): Promise<void> {
  registerSecrets([tokens.refresh_token, tokens.access_token]);
  await writeFileAtomic(file, `${JSON.stringify(tokens, null, 2)}\n`, 0o600);
}
