import { AiChatService, WORKER_MAX_ATTEMPTS, type WorkerReport } from '../ai/chat.js';
import { AiService } from '../ai/service.js';
import { SecretBox } from '../ai/secret-box.js';
import { RedisAiStore, UpstashRestClient, type AiStore } from '../ai/store.js';
import { AiProviderError, safeProviderMessage, type ProviderAdapter, type ProviderConnection } from '../ai/adapters.js';
import { CloudRunJobDispatcher, MetadataTokenSource } from '../ai/cloud-run.js';
import { AppError } from '../errors/app-error.js';
import type { FileStorage } from '../storage/file-storage.js';
import { RelayFileStorage } from './relay-storage.js';
import { loadWorkerConfig, WorkerConfigError, type WorkerConfig } from './config.js';

/**
 * The Cloud Run AI worker: one execution runs one job (and the continuations it needs). It never
 * receives a prompt or a secret in its arguments — only AI_JOB_ID — and logs ids, stages and
 * timings, never prompts, answers, file contents, names or keys.
 */

export type WorkerLog = (severity: 'INFO' | 'WARNING' | 'ERROR', event: string, fields?: Record<string, unknown>) => void;

export const jsonLog: WorkerLog = (severity, event, fields = {}) => {
  // One JSON object per line: Cloud Logging reads `severity` and `message` from it.
  process.stdout.write(`${JSON.stringify({ severity, message: event, ...fields, at: new Date().toISOString() })}\n`);
};

/** What an error may say in a log: its kind and a redacted, bounded message. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) return { error: error.code };
  if (error instanceof AiProviderError) return { error: `provider:${error.code}`, status: error.status };
  if (error instanceof WorkerConfigError) return { error: error.name, fields: error.fields };
  return { error: error instanceof Error ? error.name : 'unknown', detail: safeProviderMessage(error instanceof Error ? error.message : String(error)).slice(0, 160) };
}

export interface WorkerDeps {
  store?: AiStore;
  fetcher?: typeof fetch;
  adapterFactory?: (connection: ProviderConnection) => ProviderAdapter;
  fileStorage?: FileStorage | null;
  now?: () => Date;
  log?: WorkerLog;
  /** Tests point providers at a local mock. */
  allowLocalProviderUrls?: boolean;
  /** Tests start a "fresh execution" in-process instead of calling Google. */
  dispatcher?: AiService['deps']['dispatcher'];
}

export function createWorkerChat(config: WorkerConfig, deps: WorkerDeps = {}): AiChatService {
  const log = deps.log ?? jsonLog;
  const fetcher = deps.fetcher ?? fetch;
  const store = deps.store ?? new RedisAiStore(new UpstashRestClient(config.redis.url, config.redis.token), config.aiRedisPrefix);
  // Files come through short links from Vercel; the worker holds no storage credential.
  const relay = config.callback ? new RelayFileStorage({ url: config.callback.url, secret: config.callback.secret, fetch: fetcher }) : null;
  const fileStorage = deps.fileStorage !== undefined ? deps.fileStorage : relay;
  const dispatcher = deps.dispatcher !== undefined ? deps.dispatcher : config.handoff
    ? new CloudRunJobDispatcher({ ...config.handoff, tokens: new MetadataTokenSource(fetcher), fetch: fetcher })
    : null;
  const callback = config.callback;
  const ai = new AiService({
    store,
    secrets: SecretBox.fromEnv({ ...config.secrets, NODE_ENV: 'production' }),
    // The worker never reads the school's people; a code path that would is a bug to surface.
    roster: async () => { throw new Error('The AI worker has no access to the school roster'); },
    fileStorage,
    notifier: null,
    workerJobScope: jobId => relay?.scope(jobId),
    noticeRelay: callback ? async jobId => {
      const response = await fetcher(`${callback.url}/api/v1/internal/ai/jobs/${jobId}/notice`, {
        method: 'POST', headers: { authorization: `Bearer ${callback.secret}` }, signal: AbortSignal.timeout(10_000), redirect: 'error'
      });
      if (!response.ok) log('WARNING', 'notice.relay_failed', { jobId, status: response.status });
    } : null,
    dispatcher,
    requestTimeoutMs: config.requestTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
    fetcher,
    log: (error, message) => log('ERROR', message, describeError(error)),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
    ...(deps.allowLocalProviderUrls ? { allowLocalProviderUrls: true } : {})
  });
  return new AiChatService(ai);
}

export async function runWorker(env: NodeJS.ProcessEnv = process.env, deps: WorkerDeps = {}): Promise<{ exitCode: number; report: WorkerReport | null }> {
  const log = deps.log ?? jsonLog;
  let config: WorkerConfig;
  try { config = loadWorkerConfig(env); }
  catch (error) {
    log('ERROR', 'worker.config_invalid', describeError(error));
    return { exitCode: 2, report: null };
  }
  if (config.selfCheck) return selfCheck(config, deps, log);
  const startedAt = Date.now();
  // Cloud Run sends SIGTERM before it stops an execution: save and hand on instead of being cut off.
  const shutdown = new AbortController();
  const onTerm = () => { log('WARNING', 'worker.sigterm', { jobId: config.jobId }); shutdown.abort(); };
  process.once('SIGTERM', onTerm);
  log('INFO', 'worker.start', { jobId: config.jobId, worker: config.workerId, environment: config.environment });
  try {
    const chat = createWorkerChat(config, deps);
    const report = await chat.runWorkerJob(config.jobId, {
      workerId: config.workerId,
      stageBudgetMs: config.stageBudgetMs,
      leaseMs: config.leaseMs,
      deadlineAt: startedAt + config.maxRuntimeMs,
      maxAttempts: Math.max(1, Math.min(config.maxAttempts, WORKER_MAX_ATTEMPTS + 3)),
      shutdown: shutdown.signal,
      log: (event, fields) => log('INFO', event, fields)
    });
    log('INFO', 'worker.done', { jobId: config.jobId, stages: report.stages.map(stage => ({ jobId: stage.jobId, status: stage.status, round: stage.round })), handedOff: report.handedOff, ms: Date.now() - startedAt });
    return { exitCode: 0, report };
  } catch (error) {
    // Unexpected: exit non-zero so Cloud Run may retry the task; the job's lease keeps a retry from doubling work.
    log('ERROR', 'worker.crashed', { jobId: config.jobId, ...describeError(error) });
    return { exitCode: 1, report: null };
  } finally {
    process.removeListener('SIGTERM', onTerm);
  }
}

/**
 * AI_WORKER_SELF_CHECK=1: run once by hand in Cloud Run (Execute with this variable) to prove the
 * setup before any student job: Redis is reachable in the right namespace, every provider secret
 * opens with this worker's key, Google gives this job a token, and Vercel answers the worker secret.
 * Prints only pass/fail per step and counts — no values. Exit 0 when everything passed.
 */
async function selfCheck(config: WorkerConfig, deps: WorkerDeps, log: WorkerLog): Promise<{ exitCode: number; report: null }> {
  const fetcher = deps.fetcher ?? fetch;
  const store = deps.store ?? new RedisAiStore(new UpstashRestClient(config.redis.url, config.redis.token), config.aiRedisPrefix);
  const box = SecretBox.fromEnv({ ...config.secrets, NODE_ENV: 'production' });
  const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
  const step = async (name: string, run: () => Promise<string | undefined>) => {
    try { steps.push({ step: name, ok: true, ...(await run().then(detail => detail ? { detail } : {})) }); }
    catch (error) { steps.push({ step: name, ok: false, detail: String(describeError(error).error ?? 'failed') }); }
  };
  log('INFO', 'selfcheck.start', { worker: config.workerId, environment: config.environment, keyId: box.keyIds.main });
  await step('redis', async () => `${(await store.listProviders()).length} providers`);
  await step('provider-secrets', async () => {
    const [providers, plugins] = await Promise.all([store.listProviders(), store.listPlugins()]);
    let opened = 0, failed = 0;
    const tryOpen = (main: Parameters<SecretBox['openStored']>[0], second: Parameters<SecretBox['openStored']>[1]) => { try { box.openStored(main, second); opened += 1; } catch { failed += 1; } };
    for (const provider of providers) {
      for (const key of provider.keys) tryOpen(key.secret, key.secretNext);
      for (const header of provider.headers) tryOpen(header.secret, header.secretNext);
    }
    for (const plugin of plugins) for (const [name, sealed] of Object.entries(plugin.secrets)) tryOpen(sealed, plugin.secretsNext?.[name]);
    if (failed) throw new Error(`${failed} of ${opened + failed} secrets do not open with this key — run «Підготувати ключі» in Admin OS`);
    return `${opened} secrets open`;
  });
  if (config.handoff) await step('google-token', async () => { await new MetadataTokenSource(fetcher).token(); return 'metadata server token issued'; });
  if (config.callback) {
    const callback = config.callback;
    await step('vercel-callback', async () => {
      const response = await fetcher(`${callback.url}/api/v1/internal/ai/ping`, { method: 'POST', headers: { authorization: `Bearer ${callback.secret}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.status !== 204) throw new Error(`HTTP ${response.status}`);
      return 'worker secret accepted';
    });
  }
  const ok = steps.every(item => item.ok);
  log(ok ? 'INFO' : 'ERROR', 'selfcheck.done', { ok, steps });
  return { exitCode: ok ? 0 : 1, report: null };
}
