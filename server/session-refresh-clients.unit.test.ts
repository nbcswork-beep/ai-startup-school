import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A browser and the school's auth server in miniature: the cookie jar holds one refresh token,
 * every refresh rotates it, and presenting a replaced token ends the whole session (as the Redis
 * session store does). Access tokens expire on demand.
 */
function fakeSchool() {
  let jar = 'refresh-0';
  let rotations = 0;
  let revoked = false;
  const replaced = new Set<string>();
  const valid = new Set<string>();
  const log: string[] = [];
  const slow = new Map<string, number>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tick = (url: string) => new Promise(resolve => setTimeout(resolve, slow.get(url) ?? 5));

  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const cookie = jar; // the browser attaches the cookie it has when the request leaves
    const auth = new Headers(init.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    log.push(`${method} ${url}`);
    await tick(url);
    if (url === '/api/v1/auth/refresh' || url === '/api/v1/auth/development') {
      if (url === '/api/v1/auth/refresh' && (revoked || replaced.has(cookie))) { revoked = true; return json(401, { error: { code: 'REFRESH_TOKEN_REUSE', message: 'Сесію завершено. Увійди ще раз.' } }); }
      replaced.add(cookie);
      rotations += 1;
      jar = `refresh-${rotations}`;
      const accessToken = `access-${rotations}`;
      valid.add(accessToken);
      return json(200, { accessToken, expiresIn: 600, user: { id: 'u1', displayName: 'Адмін' } });
    }
    if (revoked || !valid.has(auth)) return json(401, { error: { code: 'ACCESS_TOKEN_INVALID', message: 'Сесія недійсна або завершилася' } });
    return json(200, { ok: true, url });
  });

  return {
    fetch, log,
    expireAccess: () => valid.clear(),
    slowDown: (url: string, ms: number) => slow.set(url, ms),
    refreshes: () => log.filter(line => line === 'POST /api/v1/auth/refresh').length,
    get revoked() { return revoked; }
  };
}

let school: ReturnType<typeof fakeSchool>;
beforeEach(() => {
  vi.resetModules();
  school = fakeSchool();
  vi.stubGlobal('fetch', school.fetch);
  vi.stubGlobal('window', { dispatchEvent: () => true, Telegram: undefined });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('one shared session refresh per page', () => {
  it('admin: parallel 401s after the access token expires share one refresh and keep the session', async () => {
    const { adminApi } = await import('../src/admin-api.js');
    await adminApi.authenticate();
    school.expireAccess();
    const before = school.refreshes();
    const results = await Promise.all([adminApi.revision(), adminApi.aiProviders(), adminApi.aiTokens()]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(school.refreshes() - before).toBe(1);
    expect(school.revoked).toBe(false);
  });

  it('teacher: a poll and a click at the same moment do not end the session', async () => {
    const { teacherApi } = await import('../src/teacher-api.js');
    await teacherApi.authenticate();
    school.expireAccess();
    const before = school.refreshes();
    await Promise.all([teacherApi.revision(), teacherApi.workspace()]);
    expect(school.refreshes() - before).toBe(1);
    expect(school.revoked).toBe(false);
    // Later calls still work: the session was not revoked.
    school.expireAccess();
    await expect(teacherApi.revision()).resolves.toMatchObject({ ok: true });
  });

  it('student: requests and an AI stream after expiry refresh once', async () => {
    const { api } = await import('../src/api.js');
    await api.authenticate();
    school.expireAccess();
    const before = school.refreshes();
    await Promise.all([api.home(), api.homework(), api.revision()]);
    expect(school.refreshes() - before).toBe(1);
    expect(school.revoked).toBe(false);
  });

  it('retries a stale 401 with the token another call already got, without refreshing again', async () => {
    const { adminApi } = await import('../src/admin-api.js');
    await adminApi.authenticate();
    school.expireAccess();
    // The slow call leaves with the expired token and gets its 401 only after the refresh is done.
    school.slowDown('/api/v1/admin/ai/providers', 40);
    const late = adminApi.aiProviders();
    await new Promise(resolve => setTimeout(resolve, 2));
    await adminApi.revision();
    await expect(late).resolves.toMatchObject({ ok: true });
    expect(school.refreshes()).toBe(2); // sign-in + exactly one renewal
    expect(school.revoked).toBe(false);
  });

  it('waits for other tabs through a Web Lock when the browser has one', async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    const { refreshSession } = await import('../src/session-refresh.js');
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(a).toBe(b);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('aiss-session-refresh');
  });

  it('a refused refresh surfaces the original error once instead of looping', async () => {
    const { adminApi } = await import('../src/admin-api.js');
    await adminApi.authenticate();
    school.expireAccess();
    const refused = async () => new Response(JSON.stringify({ error: { message: 'Сесію завершено. Увійди ще раз.' } }), { status: 401 });
    school.fetch.mockImplementationOnce(async () => new Response('{}', { status: 401 })).mockImplementationOnce(refused);
    await expect(adminApi.revision()).rejects.toMatchObject({ status: 401 });
    expect(school.fetch).toHaveBeenCalledTimes(3); // sign-in, the call, one refresh — no retry loop
    school.fetch.mockImplementationOnce(refused);
    await expect(adminApi.authenticate()).rejects.toMatchObject({ status: 401, message: 'Сесію завершено. Увійди ще раз.' });
  });
});
