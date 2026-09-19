import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z.preprocess(value => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}, z.boolean());

const optionalString = z.preprocess(value => value === '' ? undefined : value, z.string().optional());

export function resolveRedisRestCredentials(input: NodeJS.ProcessEnv): { url: string; token: string } | null {
  const pairs = [
    [input.UPSTASH_REDIS_REST_URL, input.UPSTASH_REDIS_REST_TOKEN],
    [input.UPSTASH_REDIS_REST_KV_REST_API_URL, input.UPSTASH_REDIS_REST_KV_REST_API_TOKEN]
  ];
  for (const [rawUrl, rawToken] of pairs) {
    const url = rawUrl?.trim(), token = rawToken?.trim();
    if (url && token) return { url, token };
  }
  return null;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  DATA_BACKEND: z.enum(['postgres', 'memory']).default('postgres'),
  ALLOW_VOLATILE_DATA_IN_PRODUCTION: booleanFromEnv.default(false),
  DATABASE_URL: optionalString,
  DATABASE_SSL: booleanFromEnv.default(true),
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(value => value === '' ? undefined : value, z.string().regex(/^[A-Za-z0-9_-]{16,256}$/).optional()),
  MINI_APP_URL: optionalString,
  TELEGRAM_STUDENT_BINDINGS_JSON: optionalString,
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  APP_JWT_ISSUER: z.string().default('ai-startup-school'),
  APP_JWT_AUDIENCE: z.string().default('authenticated'),
  APP_JWT_KEY_ID: z.string().default('aiss-development'),
  APP_JWT_PRIVATE_KEY_BASE64: optionalString,
  APP_JWT_PUBLIC_KEY_BASE64: optionalString,
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SESSION_TOKEN_PEPPER: optionalString,
  WEB_AUTH_ACCOUNTS_JSON: optionalString,
  UPSTASH_REDIS_REST_URL: optionalString,
  UPSTASH_REDIS_REST_TOKEN: optionalString,
  SESSION_REDIS_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]{3,80}$/).default('aiss:local:sessions:v1'),
  DEV_AUTH_ENABLED: booleanFromEnv.default(false),
  DEV_EPHEMERAL_JWT: booleanFromEnv.default(false),
  DEV_USER_ID: z.string().uuid().default('10000000-0000-4000-8000-000000000001'),
  AI_PROVIDER: z.enum(['mock']).default('mock'),
  WORKSPACE_URL: optionalString,
  TRUST_PROXY: booleanFromEnv.default(false),
  STORAGE_PRIVATE_BUCKETS_CONFIGURED: booleanFromEnv.default(false),
  ADMIN_MFA_CONFIGURED: booleanFromEnv.default(false),
  SECURITY_MONITORING_CONFIGURED: booleanFromEnv.default(false)
}).superRefine((env, context) => {
  if (env.NODE_ENV === 'production') {
    if (env.DEV_AUTH_ENABLED || env.DEV_EPHEMERAL_JWT || (env.DATA_BACKEND === 'memory' && !env.ALLOW_VOLATILE_DATA_IN_PRODUCTION)) {
      context.addIssue({ code: 'custom', message: 'Development auth, ephemeral keys, and unapproved memory data are forbidden in production' });
    }
    const origins = env.APP_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
    const invalidOrigin = origins.length === 0 || origins.some(origin => {
      try {
        const url = new URL(origin);
        return url.protocol !== 'https:' || url.origin !== origin || Boolean(url.username || url.password);
      } catch {
        return true;
      }
    });
    if (invalidOrigin) {
      context.addIssue({ code:'custom', message:'Production APP_ORIGINS must be an explicit HTTPS allowlist' });
    }
    for (const [key, value] of [
      ['TELEGRAM_BOT_TOKEN', env.TELEGRAM_BOT_TOKEN],
      ['APP_JWT_PRIVATE_KEY_BASE64', env.APP_JWT_PRIVATE_KEY_BASE64],
      ['APP_JWT_PUBLIC_KEY_BASE64', env.APP_JWT_PUBLIC_KEY_BASE64],
      ['SESSION_TOKEN_PEPPER', env.SESSION_TOKEN_PEPPER],
      ['WEB_AUTH_ACCOUNTS_JSON', env.WEB_AUTH_ACCOUNTS_JSON]
    ] as const) {
      if (!value) context.addIssue({ code: 'custom', message: `${key} is required in production` });
    }
    if (env.DATA_BACKEND === 'memory' && (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)) {
      context.addIssue({ code: 'custom', message: 'Persistent Upstash Redis REST storage is required for production memory sessions' });
    }
  }
  if (env.DATA_BACKEND === 'postgres' && !env.DATABASE_URL) {
    context.addIssue({ code: 'custom', message: 'DATABASE_URL is required when DATA_BACKEND=postgres' });
  }
  if (!env.DEV_EPHEMERAL_JWT && (!env.APP_JWT_PRIVATE_KEY_BASE64 || !env.APP_JWT_PUBLIC_KEY_BASE64)) {
    context.addIssue({ code: 'custom', message: 'JWT keys are required unless DEV_EPHEMERAL_JWT=true' });
  }
  if (!env.SESSION_TOKEN_PEPPER && env.NODE_ENV !== 'test') {
    context.addIssue({ code: 'custom', message: 'SESSION_TOKEN_PEPPER is required' });
  }
  if (Boolean(env.UPSTASH_REDIS_REST_URL) !== Boolean(env.UPSTASH_REDIS_REST_TOKEN)) {
    context.addIssue({ code: 'custom', message: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be configured together' });
  }
  if (env.UPSTASH_REDIS_REST_URL) {
    try { if (new URL(env.UPSTASH_REDIS_REST_URL).protocol !== 'https:') throw new Error(); }
    catch { context.addIssue({ code: 'custom', message: 'UPSTASH_REDIS_REST_URL must be HTTPS' }); }
  }
});

export type AppEnv = z.infer<typeof envSchema> & { origins: string[] };

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  const redis = resolveRedisRestCredentials(input);
  const parsed = envSchema.parse({ ...input, ...(redis ? { UPSTASH_REDIS_REST_URL:redis.url, UPSTASH_REDIS_REST_TOKEN:redis.token } : {}) });
  return { ...parsed, origins: parsed.APP_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean) };
}
