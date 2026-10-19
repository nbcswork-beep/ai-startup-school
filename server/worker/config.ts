import { randomUUID } from 'node:crypto';
import { assertRedisNamespaceIsolation, resolveRedisRestCredentials } from '../config/env.js';
import { clampInt } from '../ai/cloud-run.js';

/**
 * Configuration of the Cloud Run AI worker. It gets only what generating an answer needs: the AI
 * part of Redis, the key that opens provider keys, read access to attached files, and a way to ask
 * Vercel to send the «answer ready» notice. No bot token, no session keys, no school roster.
 * Errors name the missing variables, never their values.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MINUTE = 60_000;

export interface WorkerConfig {
  jobId: string;
  workerId: string;
  environment: 'production' | 'preview';
  redis: { url: string; token: string };
  aiRedisPrefix: string;
  secrets: { AI_SECRETS_KEY?: string; SESSION_TOKEN_PEPPER?: string };
  /** Photos and scanned PDFs are read from the private Blob store (read-only use in the worker). */
  blobReadable: boolean;
  callback: { url: string; secret: string } | null;
  stageBudgetMs: number;
  maxRuntimeMs: number;
  leaseMs: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  /** Where to start a fresh execution when this one runs out of time. */
  handoff: { project: string; region: string; job: string; maxConcurrent: number } | null;
}

export class WorkerConfigError extends Error {
  constructor(readonly fields: string[], detail: string) {
    super(`AI worker configuration — ${detail}`);
    this.name = 'WorkerConfigError';
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const problems: string[] = [];
  const fields: string[] = [];
  const need = (name: string, ok: boolean, why = 'is required') => { if (!ok) { problems.push(`${name} ${why}`); fields.push(name); } };

  const jobId = env.AI_JOB_ID?.trim() ?? '';
  need('AI_JOB_ID', UUID.test(jobId), 'must be a job id');
  const environment = env.AI_WORKER_ENVIRONMENT?.trim();
  need('AI_WORKER_ENVIRONMENT', environment === 'production' || environment === 'preview', 'must be production or preview');
  const redis = resolveRedisRestCredentials(env);
  need('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN', Boolean(redis));
  const sessionPrefix = env.SESSION_REDIS_PREFIX?.trim();
  const aiPrefix = env.AI_REDIS_PREFIX?.trim();
  // The prefix is never guessed: the worker must address exactly the namespace Vercel uses.
  need('SESSION_REDIS_PREFIX or AI_REDIS_PREFIX', Boolean(sessionPrefix || aiPrefix));
  const secretsKey = env.AI_SECRETS_KEY?.trim();
  const pepper = env.SESSION_TOKEN_PEPPER?.trim();
  need('AI_SECRETS_KEY or SESSION_TOKEN_PEPPER', Boolean(secretsKey || pepper), 'is required to open provider keys (the same value as on Vercel)');
  const callbackUrl = env.AI_WORKER_CALLBACK_URL?.trim();
  const callbackSecret = env.AI_WORKER_CALLBACK_SECRET?.trim();
  if (callbackUrl || callbackSecret) {
    need('AI_WORKER_CALLBACK_URL', Boolean(callbackUrl && /^https:\/\/[^/\s]+$/.test(callbackUrl.replace(/\/$/, ''))), 'must be the https origin of the Vercel deployment');
    need('AI_WORKER_CALLBACK_SECRET', Boolean(callbackSecret && callbackSecret.length >= 32), 'must be at least 32 characters');
  }
  if (problems.length) throw new WorkerConfigError(fields, problems.join('; '));

  const aiRedisPrefix = aiPrefix || `${sessionPrefix}:ai:v1`;
  // The same rule as on Vercel: a production worker can never touch a preview namespace, and back.
  assertRedisNamespaceIsolation({
    deployEnvironment: environment as 'production' | 'preview',
    prefixes: [
      ...(sessionPrefix ? [{ field: 'SESSION_REDIS_PREFIX', value: sessionPrefix }] : []),
      ...(aiPrefix ? [{ field: 'AI_REDIS_PREFIX', value: aiPrefix }] : [])
    ]
  });
  const project = env.AI_WORKER_GCP_PROJECT?.trim(), region = env.AI_WORKER_GCP_REGION?.trim(), job = env.AI_WORKER_JOB_NAME?.trim();
  const maxRuntimeMs = clampInt(env.AI_WORKER_MAX_RUNTIME_MS, 55 * MINUTE, 5 * MINUTE, 23 * 60 * MINUTE);
  return {
    jobId,
    workerId: `${env.CLOUD_RUN_EXECUTION?.trim() || 'local'}:${env.CLOUD_RUN_TASK_ATTEMPT?.trim() || '0'}:${randomUUID().slice(0, 8)}`,
    environment: environment as 'production' | 'preview',
    redis: { url: redis!.url, token: redis!.token },
    aiRedisPrefix,
    secrets: { ...(secretsKey ? { AI_SECRETS_KEY: secretsKey } : {}), ...(pepper ? { SESSION_TOKEN_PEPPER: pepper } : {}) },
    blobReadable: Boolean(env.BLOB_READ_WRITE_TOKEN?.trim()),
    callback: callbackUrl && callbackSecret ? { url: callbackUrl.replace(/\/$/, ''), secret: callbackSecret } : null,
    stageBudgetMs: Math.min(clampInt(env.AI_WORKER_STAGE_BUDGET_MS, 15 * MINUTE, MINUTE, 50 * MINUTE), maxRuntimeMs - 2 * MINUTE),
    maxRuntimeMs,
    leaseMs: clampInt(env.AI_WORKER_LEASE_MS, 90_000, 30_000, 10 * MINUTE),
    maxAttempts: clampInt(env.AI_WORKER_MAX_ATTEMPTS, 2, 1, 5),
    requestTimeoutMs: clampInt(env.AI_WORKER_REQUEST_TIMEOUT_MS, 15 * MINUTE, MINUTE, 45 * MINUTE),
    idleTimeoutMs: clampInt(env.AI_WORKER_IDLE_TIMEOUT_MS, 3 * MINUTE, 30_000, 15 * MINUTE),
    handoff: project && region && job ? { project, region, job, maxConcurrent: clampInt(env.AI_WORKER_MAX_CONCURRENT, 3, 1, 50) } : null
  };
}
