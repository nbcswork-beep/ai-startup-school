import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv, resolveRedisRestCredentials, type AppEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { RedisRestMentoringStore, type MentoringStore } from './data/mentoring-store.js';
import { RedisRestPilotRuntimeStore, type PilotRuntimeStore } from './data/pilot-runtime-store.js';
import { MockAiProvider } from './services/ai-provider.js';
import { RedisRestLoginAttemptLimiter, RedisRestSessionStore, type LoginAttemptLimiter, type SessionStore } from './auth/session-store.js';
import type { TelegramWebhookHandler } from './routes/telegram-webhook.js';
import type { NotificationSender } from './services/telegram-notification-service.js';

const ROUTE_PARAMETER = '__aiss_path';
let vercelApp: Promise<FastifyInstance> | undefined;

type VercelEnvironment = 'production' | 'preview' | 'development' | 'unknown';

function vercelEnvironment(input: NodeJS.ProcessEnv): VercelEnvironment {
  const value = input.VERCEL_ENV?.trim() || input.VERCEL_TARGET_ENV?.trim();
  return value === 'production' || value === 'preview' || value === 'development' ? value : 'unknown';
}

function requireVercelSecret(input: NodeJS.ProcessEnv, name: string, environment: VercelEnvironment): string {
  const value = input[name]?.trim();
  if (!value) {
    const label = environment === 'unknown' ? 'deployment' : `${environment} deployment`;
    throw new Error(`Vercel ${label} requires ${name}`);
  }
  return value;
}

function vercelDeploymentUrl(value: string | undefined): string | undefined {
  const trimmed=value?.trim();
  if (!trimmed) return undefined;
  try {
    const url=new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined;
  } catch { return undefined; }
}

function miniAppUrl(input:NodeJS.ProcessEnv,environment:VercelEnvironment):string {
  const explicit=input.MINI_APP_URL?.trim();
  if (explicit) return explicit;
  const derived=[
    ...(environment === 'production' ? [input.VERCEL_PROJECT_PRODUCTION_URL] : []),
    input.VERCEL_URL,
    input.VERCEL_BRANCH_URL
  ].map(vercelDeploymentUrl).find((value):value is string=>Boolean(value));
  if (derived) return derived;
  const label=environment === 'unknown' ? 'deployment' : `${environment} deployment`;
  throw new Error(`Vercel ${label} requires MINI_APP_URL or a valid Vercel deployment URL`);
}

function vercelOrigins(input: NodeJS.ProcessEnv, environment: VercelEnvironment): string {
  const explicit = input.APP_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const vercel = [
    input.VERCEL_URL,
    input.VERCEL_BRANCH_URL,
    ...(environment === 'production' ? [input.VERCEL_PROJECT_PRODUCTION_URL] : [])
  ]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => `https://${value}`);
  const origins = [...new Set([...explicit, ...vercel])];
  return (origins.length ? origins : ['http://localhost:3000', 'http://localhost:5173']).join(',');
}

export function loadVercelEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  const environment = vercelEnvironment(input);
  const jwtPrivateKey = requireVercelSecret(input, 'APP_JWT_PRIVATE_KEY_BASE64', environment);
  const jwtPublicKey = requireVercelSecret(input, 'APP_JWT_PUBLIC_KEY_BASE64', environment);
  const sessionPepper = requireVercelSecret(input, 'SESSION_TOKEN_PEPPER', environment);
  const telegramBotToken = requireVercelSecret(input, 'TELEGRAM_BOT_TOKEN', environment);
  const webAccounts = requireVercelSecret(input, 'WEB_AUTH_ACCOUNTS_JSON', environment);
  const telegramWebhookSecret = environment === 'production'
    ? requireVercelSecret(input, 'TELEGRAM_WEBHOOK_SECRET', environment)
    : input.TELEGRAM_WEBHOOK_SECRET?.trim();
  const resolvedMiniAppUrl = miniAppUrl(input, environment);
  const redis = resolveRedisRestCredentials(input);
  if (!redis) {
    const label = environment === 'unknown' ? 'deployment' : `${environment} deployment`;
    throw new Error(`Vercel ${label} requires a complete Redis REST pair: UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or UPSTASH_REDIS_REST_KV_REST_API_URL/UPSTASH_REDIS_REST_KV_REST_API_TOKEN`);
  }
  return loadEnv({
    ...input,
    NODE_ENV: environment === 'production' ? 'production' : 'development',
    DATA_BACKEND: 'memory',
    ALLOW_VOLATILE_DATA_IN_PRODUCTION: environment === 'production' ? 'true' : 'false',
    APP_ORIGINS: vercelOrigins(input, environment),
    DEV_AUTH_ENABLED: 'false',
    DEV_EPHEMERAL_JWT: 'false',
    APP_JWT_PRIVATE_KEY_BASE64: jwtPrivateKey,
    APP_JWT_PUBLIC_KEY_BASE64: jwtPublicKey,
    SESSION_TOKEN_PEPPER: sessionPepper,
    TELEGRAM_BOT_TOKEN: telegramBotToken,
    TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret,
    MINI_APP_URL: resolvedMiniAppUrl,
    WEB_AUTH_ACCOUNTS_JSON: webAccounts,
    UPSTASH_REDIS_REST_URL: redis.url,
    UPSTASH_REDIS_REST_TOKEN: redis.token,
    SESSION_REDIS_PREFIX: input.SESSION_REDIS_PREFIX?.trim() || `aiss:${environment}:sessions:v1`,
    TRUST_PROXY: 'true'
  });
}

export async function createVercelApp(input: NodeJS.ProcessEnv = process.env, overrides: { sessionStore?: SessionStore; loginLimiter?: LoginAttemptLimiter; mentoringStore?: MentoringStore; runtimeStore?: PilotRuntimeStore; telegramWebhookHandler?: TelegramWebhookHandler; notificationSender?:NotificationSender } = {}): Promise<FastifyInstance> {
  const env = loadVercelEnv(input);
  const sessionStore = overrides.sessionStore ?? new RedisRestSessionStore(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!, env.SESSION_REDIS_PREFIX);
  const loginLimiter = overrides.loginLimiter ?? new RedisRestLoginAttemptLimiter(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!, env.SESSION_REDIS_PREFIX);
  const mentoringStore = overrides.mentoringStore ?? new RedisRestMentoringStore(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!, `${env.SESSION_REDIS_PREFIX}:mentoring`);
  // Production refuses to seed demo data over a missing state key: losing the key must surface as a
  // loud failure, not as a school that silently reopened with four seeded students.
  const runtimeStore = overrides.runtimeStore ?? new RedisRestPilotRuntimeStore(
    env.UPSTASH_REDIS_REST_URL!,
    env.UPSTASH_REDIS_REST_TOKEN!,
    env.runtimeRedisPrefix,
    { bootstrapPolicy: env.deployEnvironment === 'production' && !env.ALLOW_RUNTIME_STATE_BOOTSTRAP ? 'require' : 'seed' }
  );
  const app = await buildApp({
    env,
    repository: new MemoryRepository(env.WORKSPACE_URL, {
      telegramBindingsJson: env.TELEGRAM_STUDENT_BINDINGS_JSON,
      webAuthAccountsJson: env.WEB_AUTH_ACCOUNTS_JSON,
      requireSeededTelegramIdentity: true,
      sessionStore,
      mentoringStore,
      runtimeStore
    }),
    jwt: await createJwtService(env),
    aiProvider: new MockAiProvider(),
    loginLimiter,
    ...(overrides.telegramWebhookHandler ? { telegramWebhookHandler:overrides.telegramWebhookHandler } : {}),
    ...(overrides.notificationSender ? { notificationSender:overrides.notificationSender } : {})
  });
  await app.ready();
  return app;
}

export function getVercelApp(input: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  vercelApp ??= createVercelApp(input);
  return vercelApp;
}

function fastifyUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const routePath = url.searchParams.get(ROUTE_PARAMETER);
  url.searchParams.delete(ROUTE_PARAMETER);
  if (!routePath || routePath.startsWith('/') || routePath.includes('\\') || routePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid Vercel API route');
  }
  const query = url.searchParams.toString();
  return `/api/${routePath}${query ? `?${query}` : ''}`;
}

export async function injectVercelRequest(app: FastifyInstance, request: Request): Promise<Response> {
  let url: string;
  try {
    url = fastifyUrl(request.url);
  } catch {
    return Response.json({ error: { code: 'INVALID_API_ROUTE', message: 'Некоректний API маршрут' } }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (key !== 'content-length') headers[key] = value;
  });
  const hasBody = !['GET', 'HEAD'].includes(request.method.toUpperCase());
  const options: InjectOptions = {
    method: request.method as NonNullable<InjectOptions['method']>,
    url,
    headers,
    ...(hasBody ? { payload: Buffer.from(await request.arrayBuffer()) } : {})
  };
  const result = await app.inject(options);
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, String(item)));
    else if (value !== undefined) responseHeaders.set(key, String(value));
  }
  const bodyForbidden = request.method.toUpperCase() === 'HEAD' || [204, 205, 304].includes(result.statusCode);
  if (bodyForbidden) {
    responseHeaders.delete('content-length');
    responseHeaders.delete('content-type');
  }
  return new Response(bodyForbidden ? null : result.rawPayload, { status: result.statusCode, headers: responseHeaders });
}
