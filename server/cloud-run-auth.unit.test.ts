import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudRunDispatchError, CloudRunJobDispatcher, MetadataTokenSource, vercelWorkerDispatcher, WorkloadIdentityTokenSource } from './ai/cloud-run.js';
import { vercelOidcToken } from './vercel-runtime-env.js';
import { getVercelOidcToken } from '@vercel/oidc';

vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const env = {
  AI_WORKER_GCP_PROJECT: 'student-os-ai',
  AI_WORKER_GCP_REGION: 'europe-west3',
  AI_WORKER_JOB_NAME: 'ai-worker',
  AI_WORKER_WIF_AUDIENCE: '//iam.googleapis.com/projects/752806759634/locations/global/workloadIdentityPools/vercel/providers/vercel-oidc',
  AI_WORKER_DISPATCH_SERVICE_ACCOUNT: 'ai-dispatch@student-os-ai.iam.gserviceaccount.com'
};
const jobId = '00000000-0000-4000-8000-000000000001';
// Deliberately opaque: redaction must not depend on JWT/ya29 prefixes.
const secret = 'opaque-sensitive-value-123';
const scope = 'https://www.googleapis.com/auth/cloud-platform';
type Call = { url: string; init: RequestInit };

function google(override?: (call: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const response = await override?.(call);
    if (response) return response;
    if (call.url.includes('sts.googleapis.com')) return Response.json({ access_token: secret });
    if (call.url.includes(':generateAccessToken')) return Response.json({ accessToken: secret, expireTime: new Date(Date.now() + 600_000).toISOString() });
    if (call.url.endsWith(':run')) return Response.json({ name: 'projects/student-os-ai/locations/europe-west3/operations/test' });
    throw new Error(`Unexpected request ${call.url}`);
  });
  return { calls, fetcher };
}

function source(fetcher: typeof fetch, subjectToken = vi.fn(async () => secret)) {
  return new WorkloadIdentityTokenSource({
    audience: env.AI_WORKER_WIF_AUDIENCE,
    serviceAccount: env.AI_WORKER_DISPATCH_SERVICE_ACCOUNT,
    subjectToken, fetch: fetcher
  });
}

describe('Vercel OIDC → Google STS → impersonation → Cloud Run', () => {
  it('uses the SDK at call time with the default team audience and hides SDK failures', async () => {
    const sdk = vi.mocked(getVercelOidcToken);
    sdk.mockResolvedValueOnce(secret).mockRejectedValueOnce(new Error(secret));
    expect(await vercelOidcToken()).toBe(secret);
    expect(await vercelOidcToken()).toBeNull();
    expect(sdk.mock.calls).toEqual([[], []]);
  });

  it('sends tokens only to their intended endpoints and only a job id in overrides', async () => {
    const { calls, fetcher } = google();
    const dispatcher = vercelWorkerDispatcher(env, async () => secret, fetcher).dispatcher!;
    await dispatcher.dispatch(jobId);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe('https://sts.googleapis.com/v1/token');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      audience: env.AI_WORKER_WIF_AUDIENCE, scope,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken: secret, subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt'
    });
    expect(calls[1]!.url).toBe(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.AI_WORKER_DISPATCH_SERVICE_ACCOUNT)}:generateAccessToken`);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ scope: [scope], lifetime: '600s' });
    expect(calls[2]!.url).toBe('https://run.googleapis.com/v2/projects/student-os-ai/locations/europe-west3/jobs/ai-worker:run');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({
      overrides: { containerOverrides: [{ env: [{ name: 'AI_JOB_ID', value: jobId }] }], taskCount: 1 }
    });
    for (const call of calls) {
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calls.slice(1).map(call => new Headers(call.init.headers).get('authorization'))).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
  });

  it('shares concurrent exchanges, refreshes before expiry, and reads a fresh subject on refresh', async () => {
    vi.useFakeTimers();
    const { calls, fetcher } = google();
    const subject = vi.fn(async () => secret);
    const tokens = source(fetcher, subject);
    expect(await Promise.all(Array.from({ length: 12 }, () => tokens.token()))).toEqual(Array(12).fill(secret));
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(539_000);
    await tokens.token();
    expect(subject).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await tokens.token();
    expect(subject).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(4);
  });

  it.each([null, '', ' ', 'bad\nheader'])('does not call Google with an absent/invalid OIDC token (%j)', async value => {
    const { fetcher } = google();
    const tokens = new WorkloadIdentityTokenSource({ audience: env.AI_WORKER_WIF_AUDIENCE, serviceAccount: env.AI_WORKER_DISPATCH_SERVICE_ACCOUNT, subjectToken: async () => value, fetch: fetcher });
    await expect(tokens.token()).rejects.toThrow('OIDC');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['sts.googleapis.com', ':generateAccessToken', ':run'])('hides opaque credentials from HTTP and transport errors at %s; never retries', async endpoint => {
    for (const transport of [false, true]) {
      const { calls, fetcher } = google(call => {
        if (!call.url.includes(endpoint)) return;
        if (transport) throw new Error(`Bearer ${secret}`, { cause: { token: secret } });
        return Response.json({ error: { status: secret, message: secret }, error_description: secret }, { status: 403 });
      });
      const dispatcher = vercelWorkerDispatcher(env, async () => secret, fetcher).dispatcher!;
      const error = await dispatcher.dispatch(jobId).catch(e => e);
      expect(error).toBeInstanceOf(CloudRunDispatchError);
      expect(error.status).toBe(transport ? null : 403);
      expect(String(error)).not.toContain(secret);
      expect(error.cause).toBeUndefined();
      expect(calls.filter(call => call.url.includes(endpoint))).toHaveLength(1);
      expect(calls.at(-1)!.url).toContain(endpoint);
    }
  });

  it.each(['not-json', 'null', '[]', '{}'])('fails closed on malformed STS response %s', async body => {
    const { calls, fetcher } = google(call => call.url.includes('sts.googleapis.com') ? new Response(body) : undefined);
    await expect(source(fetcher).token()).rejects.toBeInstanceOf(CloudRunDispatchError);
    expect(calls).toHaveLength(1);
  });

  it.each([undefined, 'invalid', new Date(0).toISOString()])('refuses missing/invalid/expired IAM expiry %s', async expireTime => {
    const { fetcher } = google(call => call.url.includes(':generateAccessToken') ? Response.json({ accessToken: secret, expireTime }) : undefined);
    await expect(source(fetcher).token()).rejects.toThrow('lifetime');
  });

  it('does not retain a failed exchange and can recover on the next request', async () => {
    let failing = true;
    const { fetcher } = google(call => failing && call.url.includes('sts.googleapis.com') ? new Response(secret, { status: 503 }) : undefined);
    const tokens = source(fetcher);
    await expect(tokens.token()).rejects.toThrow('STS: HTTP 503');
    failing = false;
    await expect(tokens.token()).resolves.toBe(secret);
  });

  it('diagnostics refresh auth and always validate overrides without starting a Job or needing jobs.get', async () => {
    const { calls, fetcher } = google();
    const dispatcher = vercelWorkerDispatcher(env, async () => secret, fetcher).dispatcher!;
    await dispatcher.diagnose();
    const result = await dispatcher.diagnose();
    expect(result.every(step => step.ok)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(calls.filter(call => call.url.includes('sts.googleapis.com'))).toHaveLength(2);
    const runs = calls.filter(call => call.url.endsWith(':run'));
    expect(runs).toHaveLength(2);
    for (const call of runs) {
      expect(call.init.method).toBe('POST');
      expect(JSON.parse(String(call.init.body))).toMatchObject({ validateOnly: true, overrides: { taskCount: 1 } });
    }
    expect(calls.some(call => !call.init.method || call.init.method === 'GET')).toBe(false);
  });

  it('diagnostics return safe failures and stop before validation on an OIDC failure', async () => {
    const { fetcher } = google();
    const dispatcher = vercelWorkerDispatcher(env, async () => { throw new Error(secret); }, fetcher).dispatcher!;
    expect(await dispatcher.diagnose()).toEqual([{ step: 'google-token', ok: false, detail: 'Vercel OIDC token retrieval failed' }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { error: { message: secret } }])('rejects an unsuccessful/malformed operation without repeating jobs.run', async body => {
    const { calls, fetcher } = google(call => call.url.endsWith(':run') ? Response.json(body) : undefined);
    const dispatcher = vercelWorkerDispatcher(env, async () => secret, fetcher).dispatcher!;
    await expect(dispatcher.dispatch(jobId)).rejects.toThrow('outcome may be unknown');
    expect(calls.filter(call => call.url.endsWith(':run'))).toHaveLength(1);
  });

  it('invalidates a rejected credential for the next dispatch but never replays the current run', async () => {
    let reject = true;
    const { calls, fetcher } = google(call => reject && call.url.endsWith(':run') ? new Response(secret, { status: 401 }) : undefined);
    const dispatcher = vercelWorkerDispatcher(env, async () => secret, fetcher).dispatcher!;
    await expect(dispatcher.dispatch(jobId)).rejects.toThrow('401');
    expect(calls).toHaveLength(3);
    reject = false;
    await dispatcher.dispatch(jobId);
    expect(calls).toHaveLength(6);
  });

  it.each(['../x', '', 'not-a-uuid'])('rejects invalid job id %j before acquiring credentials', async id => {
    const tokens = { token: vi.fn(async () => secret) };
    const { fetcher } = google();
    const dispatcher = new CloudRunJobDispatcher({ project: 'student-os-ai', region: 'europe-west3', job: 'ai-worker', maxConcurrent: 1, tokens, fetch: fetcher });
    await expect(dispatcher.dispatch(id)).rejects.toThrow('Invalid job id');
    expect(tokens.token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(Object.keys(env))('fails closed on malformed configuration %s without displaying values', key => {
    const result = vercelWorkerDispatcher({ ...env, [key]: `https://invalid/${secret}` }, async () => secret);
    expect(result.dispatcher).toBeNull();
    expect(result.problem).toContain(key);
    expect(result.problem).not.toContain(secret);
  });

  it('keeps Cloud Run handoff on metadata identity, with expiry refresh and no OIDC calls', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ access_token: secret, expires_in: 300 }));
    const tokens = new MetadataTokenSource(fetcher);
    await tokens.token();
    await tokens.token();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { 'metadata-flavor': 'Google' }, redirect: 'error' });
    vi.advanceTimersByTime(240_000);
    await tokens.token();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
