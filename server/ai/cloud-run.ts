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
}

export class CloudRunDispatchError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = 'CloudRunDispatchError';
  }
}

/** Google's error text without anything that looks like a credential, bounded. */
async function googleError(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown; status?: unknown } | string; error_description?: unknown };
    message = typeof parsed.error === 'string'
      ? `${parsed.error}${typeof parsed.error_description === 'string' ? `: ${parsed.error_description}` : ''}`
      : `${String(parsed.error?.status ?? '')} ${String(parsed.error?.message ?? '')}`.trim();
  } catch { /* plain text */ }
  return `HTTP ${response.status} ${message}`
    .replace(/(ya29\.|eyJ)[A-Za-z0-9._-]{10,}/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export class CloudRunJobDispatcher implements AiWorkerDispatcher {
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: { project: string; region: string; job: string; maxConcurrent: number; tokens: GoogleTokenSource; fetch?: typeof fetch; timeoutMs?: number }) {
    this.fetcher = config.fetch ?? fetch;
  }

  get maxConcurrent(): number { return this.config.maxConcurrent; }

  /**
   * Proves the real path to Google without starting anything: a token from Vercel OIDC through
   * STS and IAM, then a read of the job. Each step says pass or fail with Google's error text
   * (tokens removed). Claims of the OIDC token are shown (they name the team, project and
   * environment; they are not secret), the token itself never.
   */
  async diagnose(): Promise<Array<{ step: string; ok: boolean; detail: string }>> {
    const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
    const tokens = this.config.tokens;
    if (tokens instanceof WorkloadIdentityTokenSource) {
      const claims = await tokens.subjectClaims();
      steps.push(claims ? { step: 'vercel-oidc', ok: true, detail: JSON.stringify(claims) } : { step: 'vercel-oidc', ok: false, detail: 'No OIDC token in this function: turn on OIDC Federation for the project (Team issuer) and redeploy' });
      if (!claims) return steps;
    }
    let token: string;
    try { token = await tokens.token(); steps.push({ step: 'google-token', ok: true, detail: 'STS exchange and service-account impersonation succeeded' }); }
    catch (error) { steps.push({ step: 'google-token', ok: false, detail: error instanceof Error ? error.message : 'failed' }); return steps; }
    const { project, region, job } = this.config;
    const response = await this.fetcher(`https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: 'error'
    }).catch(error => error as Error);
    if (response instanceof Error) steps.push({ step: 'cloud-run-job', ok: false, detail: response.message });
    else if (response.ok) {
      const body = await response.json().catch(() => ({})) as { name?: unknown; template?: { template?: { containers?: Array<{ image?: unknown }> } } };
      steps.push({ step: 'cloud-run-job', ok: true, detail: `${String(body.name ?? job)} · image ${String(body.template?.template?.containers?.[0]?.image ?? '?')}` });
    } else steps.push({ step: 'cloud-run-job', ok: false, detail: await googleError(response) });
    return steps;
  }

  async dispatch(jobId: string): Promise<void> {
    // The id is the only thing a worker is told; anything else is refused before Google sees it.
    if (!UUID.test(jobId)) throw new CloudRunDispatchError(null, 'Invalid job id');
    const token = await this.config.tokens.token();
    const { project, region, job } = this.config;
    const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}:run`;
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ overrides: { containerOverrides: [{ env: [{ name: 'AI_JOB_ID', value: jobId }] }], taskCount: 1 } }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      redirect: 'error'
    });
    if (!response.ok) throw new CloudRunDispatchError(response.status, await googleError(response));
    await response.body?.cancel().catch(() => undefined);
  }
}

/**
 * Vercel → Google without a stored key: Vercel's OIDC token is exchanged at Google STS for a
 * federated token, which impersonates the dispatch service account for ten minutes.
 */
export class WorkloadIdentityTokenSource implements GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
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

  /** The claims of Vercel's OIDC token (iss, aud, sub, exp), for diagnostics. Null when there is none. */
  async subjectClaims(): Promise<Record<string, unknown> | null> {
    const subject = await this.config.subjectToken();
    if (!subject) return null;
    try {
      const payload = JSON.parse(Buffer.from(subject.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
      return { iss: payload.iss, aud: payload.aud, sub: payload.sub, exp: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : null };
    } catch { return { error: 'not a JWT' }; }
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.cached.token;
    const subject = await this.config.subjectToken();
    if (!subject) throw new CloudRunDispatchError(null, 'Vercel OIDC token is not available in this function');
    const exchange = await this.fetcher('https://sts.googleapis.com/v1/token', {
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
    if (!exchange.ok) throw new CloudRunDispatchError(exchange.status, `STS: ${await googleError(exchange)}`);
    const federated = (await exchange.json() as { access_token?: unknown }).access_token;
    if (typeof federated !== 'string' || !federated) throw new CloudRunDispatchError(null, 'STS returned no token');
    const impersonate = await this.fetcher(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.config.serviceAccount)}:generateAccessToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${federated}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE], lifetime: '600s' }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
    if (!impersonate.ok) throw new CloudRunDispatchError(impersonate.status, `IAM: ${await googleError(impersonate)}`);
    const body = await impersonate.json() as { accessToken?: unknown; expireTime?: unknown };
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new CloudRunDispatchError(null, 'IAM returned no token');
    const expiresAt = typeof body.expireTime === 'string' && Number.isFinite(Date.parse(body.expireTime)) ? Date.parse(body.expireTime) : Date.now() + 600_000;
    this.cached = { token: body.accessToken, expiresAt };
    return body.accessToken;
  }
}

/** Inside Cloud Run: the job's own service account, from the metadata server. */
export class MetadataTokenSource implements GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return this.cached.token;
    const response = await this.fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(5_000), redirect: 'error'
    });
    if (!response.ok) throw new CloudRunDispatchError(response.status, `metadata: HTTP ${response.status}`);
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) throw new CloudRunDispatchError(null, 'metadata returned no token');
    this.cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000 };
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
