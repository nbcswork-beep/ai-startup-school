import type { AiWorkerDispatcher } from './service.js';

/**
 * Starting Cloud Run Job executions for AI answers.
 *
 * Only a job id travels to Google, as an environment override of one execution; the worker reads
 * everything else from Redis. Vercel holds no Google key: it trades its own short-lived OIDC token
 * for a Google token (Workload Identity Federation) and impersonates a service account that may
 * only run this one job. A worker that hands work on uses its own identity from the metadata server.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** A token is renewed this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

export interface GoogleTokenSource {
  token(): Promise<string>;
  invalidate?(): void;
}

export class CloudRunDispatchError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = 'CloudRunDispatchError';
  }
}

/** Never forward upstream bodies, SDK errors, headers or causes: credentials can have any shape. */
async function googleRequest(fetcher: typeof fetch, stage: string, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error' });
  } catch {
    throw new CloudRunDispatchError(null, `${stage}: request failed or timed out; outcome may be unknown`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const hint = ({
      400: 'INVALID_ARGUMENT: check configuration and provider audience/subject condition',
      401: 'UNAUTHENTICATED: check OIDC availability and token expiry',
      403: 'PERMISSION_DENIED: check provider condition, service-account binding and job IAM',
      404: 'NOT_FOUND: check project, region, job and service account',
      429: 'RESOURCE_EXHAUSTED: quota or rate limit'
    } as Record<number, string>)[response.status] ?? 'Google request rejected';
    throw new CloudRunDispatchError(response.status, `${stage}: HTTP ${response.status} ${hint}`);
  }
  return response;
}

async function googleJson(response: Response, stage: string): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new CloudRunDispatchError(null, `${stage}: invalid JSON response`);
  }
}

function safeDetail(error: unknown): string {
  return error instanceof CloudRunDispatchError ? error.message : 'Google authentication or request failed';
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768 && !/\s/.test(value);
}

export class CloudRunJobDispatcher implements AiWorkerDispatcher {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: { project: string; region: string; job: string; maxConcurrent: number; tokens: GoogleTokenSource; fetch?: typeof fetch; timeoutMs?: number }) {
    this.fetcher = config.fetch ?? fetch;
  }

  get maxConcurrent(): number { return this.config.maxConcurrent; }

  /** Fresh auth plus jobs.run validation, including overrides, without creating an execution. */
  async diagnose(): Promise<Array<{ step: string; ok: boolean; detail: string }>> {
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const tokens = this.config.tokens;
    // Do not report success using a previously cached credential after an IAM/OIDC change.
    tokens.invalidate?.();
    let token: string;
    try {
      token = await tokens.token();
      steps.push({ step: 'google-token', ok: true, detail: tokens instanceof WorkloadIdentityTokenSource
        ? 'Vercel OIDC → STS → service-account impersonation succeeded'
        : 'Google access token obtained' });
    } catch (error) { steps.push({ step: 'google-token', ok: false, detail: safeDetail(error) }); return steps; }
    try {
      await this.run('00000000-0000-4000-8000-000000000000', token, true);
      steps.push({ step: 'cloud-run-job', ok: true, detail: 'jobs.run with overrides validated (validateOnly=true); no execution started' });
    } catch (error) { steps.push({ step: 'cloud-run-job', ok: false, detail: safeDetail(error) }); }
    return steps;
  }

  async dispatch(jobId: string): Promise<void> {
    // The id is the only thing a worker is told; anything else is refused before Google sees it.
    if (!UUID.test(jobId)) throw new CloudRunDispatchError(null, 'Invalid job id');
    let token: string;
    try { token = await this.config.tokens.token(); }
    catch (error) { throw new CloudRunDispatchError(error instanceof CloudRunDispatchError ? error.status : null, safeDetail(error)); }
    await this.run(jobId, token, false);
  }

  private async run(jobId: string, token: string, validateOnly: boolean): Promise<void> {
    const { project, region, job } = this.config;
    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}:run`;
    // No automatic retries: a timeout/5xx can mean Google already started the execution.
    // The existing Redis lease/fallback/recovery path owns ambiguous outcomes.
    let response: Response;
    try { response = await googleRequest(this.fetcher, 'Cloud Run', url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(validateOnly ? { validateOnly: true } : {}), overrides: { containerOverrides: [{ env: [{ name: 'AI_JOB_ID', value: jobId }] }], taskCount: 1 } }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      redirect: 'error'
    }); } catch (error) {
      if (error instanceof CloudRunDispatchError && error.status === 401) this.config.tokens.invalidate?.();
      throw error;
    }
    const body = await googleJson(response, 'Cloud Run');
    if (body.error || (!validateOnly && (typeof body.name !== 'string' || !body.name))) {
      throw new CloudRunDispatchError(null, 'Cloud Run: invalid or failed operation; outcome may be unknown');
    }
  }
}

/**
 * Vercel → Google without a stored key: Vercel's OIDC token is exchanged at Google STS for a
 * federated token, which impersonates the dispatch service account for ten minutes.
 */
export class WorkloadIdentityTokenSource implements GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: {
    /** //iam.googleapis.com/projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider> */
    audience: string;
    serviceAccount: string;
    subjectToken: () => Promise<string | null>;
    fetch?: typeof fetch;
  }) {
    this.fetcher = config.fetch ?? fetch;
  }

  invalidate(): void { this.cached = null; }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.exchange();
    try { return await this.pending; }
    finally { this.pending = null; }
  }

  private async exchange(): Promise<string> {
    this.cached = null;
    let subject: string | null;
    try { subject = await this.config.subjectToken(); }
    catch { throw new CloudRunDispatchError(null, 'Vercel OIDC token retrieval failed'); }
    if (!validToken(subject)) throw new CloudRunDispatchError(null, 'Vercel OIDC token is not available in this function; enable team OIDC and redeploy');
    const exchange = await googleRequest(this.fetcher, 'STS', 'https://sts.googleapis.com/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
        audience: this.config.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
        subjectToken: subject,
        subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt'
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
    const federated = (await googleJson(exchange, 'STS')).access_token;
    if (!validToken(federated)) throw new CloudRunDispatchError(null, 'STS returned no valid token');
    const requestedAt = Date.now();
    const impersonate = await googleRequest(this.fetcher, 'IAM', `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.config.serviceAccount)}:generateAccessToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${federated}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: '600s' }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
    const body = await googleJson(impersonate, 'IAM');
    if (!validToken(body.accessToken)) throw new CloudRunDispatchError(null, 'IAM returned no valid token');
    const expiresAt = typeof body.expireTime === 'string' ? Math.min(Date.parse(body.expireTime), requestedAt + 600_000) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_MARGIN_MS) {
      throw new CloudRunDispatchError(null, 'IAM returned an invalid or expired token lifetime');
    }
    this.cached = { token: body.accessToken, expiresAt };
    return body.accessToken;
  }
}

/** Inside Cloud Run: the job's own service account, from the metadata server. */
export class MetadataTokenSource implements GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  invalidate(): void { this.cached = null; }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.cached.token;
    const response = await googleRequest(this.fetcher, 'metadata', 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(5_000), redirect: 'error'
    });
    const body = await googleJson(response, 'metadata');
    if (!validToken(body.access_token)) throw new CloudRunDispatchError(null, 'metadata returned no valid token');
    if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= TOKEN_MARGIN_MS / 1000) {
      throw new CloudRunDispatchError(null, 'metadata returned an invalid token lifetime');
    }
    this.cached = { token: body.access_token, expiresAt: Date.now() + Math.min(body.expires_in, 3600) * 1000 };
    return body.access_token;
  }
}

const VERCEL_KEYS = ['AI_WORKER_GCP_PROJECT', 'AI_WORKER_GCP_REGION', 'AI_WORKER_JOB_NAME', 'AI_WORKER_WIF_AUDIENCE', 'AI_WORKER_DISPATCH_SERVICE_ACCOUNT'] as const;

/**
 * The dispatcher for a Vercel deployment, from its environment. Nothing set: null, and every answer
 * stays on Vercel. Partly set: null too, with the names that are missing (never their values).
 */
export function vercelWorkerDispatcher(env: NodeJS.ProcessEnv, subjectToken: () => Promise<string | null>, fetcher?: typeof fetch): { dispatcher: CloudRunJobDispatcher | null; problem: string | null } {
  const values = Object.fromEntries(VERCEL_KEYS.map(key => [key, env[key]?.trim() ?? ''])) as Record<(typeof VERCEL_KEYS)[number], string>;
  const missing = VERCEL_KEYS.filter(key => !values[key]);
  if (missing.length === VERCEL_KEYS.length) return { dispatcher: null, problem: null };
  if (missing.length) return { dispatcher: null, problem: `Cloud Run worker is not configured: missing ${missing.join(', ')}` };
  if (!/^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/.test(values.AI_WORKER_WIF_AUDIENCE)) {
    return { dispatcher: null, problem: 'Cloud Run worker is not configured: AI_WORKER_WIF_AUDIENCE has the wrong form' };
  }
  const formats = {
    AI_WORKER_GCP_PROJECT: /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d+)$/,
    AI_WORKER_GCP_REGION: /^[a-z]+-[a-z]+\d+$/,
    AI_WORKER_JOB_NAME: /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    AI_WORKER_DISPATCH_SERVICE_ACCOUNT: /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/
  };
  for (const [key, pattern] of Object.entries(formats)) {
    if (!pattern.test(values[key as keyof typeof formats])) {
      return { dispatcher: null, problem: `Cloud Run worker is not configured: ${key} has the wrong form` };
    }
  }
  const tokens = new WorkloadIdentityTokenSource({ audience: values.AI_WORKER_WIF_AUDIENCE, serviceAccount: values.AI_WORKER_DISPATCH_SERVICE_ACCOUNT, subjectToken, ...(fetcher ? { fetch: fetcher } : {}) });
  return {
    dispatcher: new CloudRunJobDispatcher({
      project: values.AI_WORKER_GCP_PROJECT, region: values.AI_WORKER_GCP_REGION, job: values.AI_WORKER_JOB_NAME,
      maxConcurrent: clampInt(env.AI_WORKER_MAX_CONCURRENT, 3, 1, 50), tokens, ...(fetcher ? { fetch: fetcher } : {})
    }),
    problem: null
  };
}

export function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
