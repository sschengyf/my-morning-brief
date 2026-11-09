import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../../test/helpers.js';
import { redact } from '#/infra/logger.js';
import { accessToken, MsLoginNeeded, startDeviceLogin } from './ms-auth.js';

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const NOW = 1_800_000_000_000;

async function tokenFile(tokens?: object): Promise<string> {
  const file = join(await makeTempDir(), 'ms-token.json');
  if (tokens) await writeFile(file, JSON.stringify(tokens));
  return file;
}

const stored = (expiresAt: number) => ({
  refresh_token: 'refresh-old-123',
  access_token: 'access-old-123',
  expires_at: expiresAt,
});

/** Answers token requests in order; records each request's form fields. */
function tokenServer(replies: object[]) {
  const forms: Record<string, string>[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
    const reply = replies.shift() ?? { error: 'authorization_pending' };
    return Response.json(reply, { status: 'error' in reply ? 400 : 200 });
  });
  return { fetchMock, forms };
}

describe('accessToken', () => {
  it('uses the stored token while it is valid, without a request', async () => {
    const file = await tokenFile(stored(NOW + 3_600_000));
    const { fetchMock } = tokenServer([]);
    expect(
      await accessToken({ clientId: CLIENT_ID, tokenFile: file, fetch: fetchMock, now: () => NOW }),
    ).toBe('access-old-123');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and stores the new pair, readable only by its owner', async () => {
    const file = await tokenFile(stored(NOW + 30_000));
    const { fetchMock, forms } = tokenServer([
      { access_token: 'access-new-456', refresh_token: 'refresh-new-456', expires_in: 3600 },
    ]);
    const token = await accessToken({
      clientId: CLIENT_ID,
      tokenFile: file,
      fetch: fetchMock,
      now: () => NOW,
    });
    expect(token).toBe('access-new-456');
    expect(forms).toEqual([
      {
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: 'refresh-old-123',
        scope: 'Tasks.Read offline_access',
      },
    ]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      refresh_token: 'refresh-new-456',
      access_token: 'access-new-456',
      expires_at: NOW + 3_600_000,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(redact('token refresh-new-456 and access-new-456')).not.toMatch(/new-456/);
  });

  it('keeps the old refresh token when the reply has none, and refreshes when forced', async () => {
    const file = await tokenFile(stored(NOW + 3_600_000));
    const { fetchMock } = tokenServer([{ access_token: 'access-new-789', expires_in: 3600 }]);
    await accessToken(
      { clientId: CLIENT_ID, tokenFile: file, fetch: fetchMock, now: () => NOW },
      true,
    );
    expect(JSON.parse(await readFile(file, 'utf8')).refresh_token).toBe('refresh-old-123');
  });

  it('does not write back a refreshed token in a dry run', async () => {
    const file = await tokenFile(stored(0));
    const before = await readFile(file, 'utf8');
    const { fetchMock } = tokenServer([
      { access_token: 'access-dry', refresh_token: 'refresh-dry', expires_in: 3600 },
    ]);
    const options = {
      clientId: CLIENT_ID,
      tokenFile: file,
      fetch: fetchMock,
      now: () => NOW,
      save: false,
    };
    expect(await accessToken(options)).toBe('access-dry');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('refreshes once when asked twice at the same time', async () => {
    const file = await tokenFile(stored(0));
    const { fetchMock } = tokenServer([
      { access_token: 'access-once', refresh_token: 'refresh-once', expires_in: 3600 },
    ]);
    const options = { clientId: CLIENT_ID, tokenFile: file, fetch: fetchMock, now: () => NOW };
    expect(await Promise.all([accessToken(options), accessToken(options)])).toEqual([
      'access-once',
      'access-once',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks to log in again when the refresh token is rejected, or there is none', async () => {
    const file = await tokenFile(stored(0));
    const { fetchMock } = tokenServer([{ error: 'invalid_grant' }]);
    const options = { clientId: CLIENT_ID, tokenFile: file, fetch: fetchMock, now: () => NOW };
    await expect(accessToken(options)).rejects.toThrow(
      new MsLoginNeeded('Microsoft To Do 的登录已失效，请发 /todo_login 重新登录'),
    );
    await expect(accessToken({ ...options, tokenFile: await tokenFile() })).rejects.toThrow(
      '还没有登录 Microsoft To Do',
    );
    await writeFile(file, 'not json');
    await expect(accessToken(options)).rejects.toBeInstanceOf(MsLoginNeeded);
  });
});

describe('startDeviceLogin', () => {
  const CODE = {
    device_code: 'device-secret',
    user_code: 'ABCD1234',
    verification_uri: 'https://www.microsoft.com/link',
    expires_in: 900,
    interval: 5,
  };

  /** A device code reply, then token replies; time moves on as the poller sleeps. */
  function loginServer(tokenReplies: object[]) {
    let now = NOW;
    const replies = [CODE, ...tokenReplies];
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      const reply = replies.shift() ?? { error: 'authorization_pending' };
      return Response.json(reply, { status: 'error' in reply ? 400 : 200 });
    });
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    };
    return { fetchMock, urls, sleeps, sleep, now: () => now };
  }

  it('gives the code at once and stores the tokens once the user signs in', async () => {
    const file = await tokenFile();
    const server = loginServer([
      { error: 'authorization_pending' },
      { error: 'slow_down' },
      { access_token: 'access-login', refresh_token: 'refresh-login', expires_in: 3600 },
    ]);
    const login = await startDeviceLogin({
      clientId: CLIENT_ID,
      tokenFile: file,
      fetch: server.fetchMock,
      now: server.now,
      sleep: server.sleep,
    });
    expect(login).toMatchObject({
      verificationUri: 'https://www.microsoft.com/link',
      userCode: 'ABCD1234',
      expiresInMinutes: 14,
    });
    expect(await login.done).toEqual({ ok: true });
    expect(server.urls[0]).toBe(
      'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
    );
    expect(server.sleeps).toEqual([5000, 5000, 10000]); // slow_down adds 5 seconds
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      refresh_token: 'refresh-login',
    });
  });

  it('reports a declined sign-in and an expired code', async () => {
    const declined = loginServer([{ error: 'authorization_declined' }]);
    const options = { clientId: CLIENT_ID, tokenFile: await tokenFile() };
    const first = await startDeviceLogin({
      ...options,
      fetch: declined.fetchMock,
      now: declined.now,
      sleep: declined.sleep,
    });
    expect(await first.done).toEqual({ ok: false, reason: '你拒绝了授权' });

    const waiting = loginServer([]); // pending until the code runs out
    const second = await startDeviceLogin({
      ...options,
      fetch: waiting.fetchMock,
      now: waiting.now,
      sleep: waiting.sleep,
    });
    expect(await second.done).toEqual({ ok: false, reason: '验证码已过期，请重新发 /todo_login' });
    expect(waiting.now() - NOW).toBeLessThanOrEqual(14 * 60_000);
  });

  it('allows one login at a time per person', async () => {
    const file = await tokenFile();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = loginServer([{ access_token: 'a', refresh_token: 'r', expires_in: 3600 }]);
    const login = await startDeviceLogin({
      clientId: CLIENT_ID,
      tokenFile: file,
      fetch: server.fetchMock,
      now: server.now,
      sleep: () => gate,
    });
    await expect(
      startDeviceLogin({ clientId: CLIENT_ID, tokenFile: file, fetch: server.fetchMock }),
    ).rejects.toThrow('上一个登录还在等待');
    release();
    expect(await login.done).toEqual({ ok: true });
  });

  it('fails clearly when Microsoft rejects the app', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'invalid_client' }, { status: 400 }),
    );
    await expect(
      startDeviceLogin({ clientId: CLIENT_ID, tokenFile: await tokenFile(), fetch: fetchMock }),
    ).rejects.toThrow('Microsoft 登录服务出错（invalid_client）');
  });
});
