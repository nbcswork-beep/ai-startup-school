import { getVercelApp, injectVercelRequest } from '../server/vercel-preview.js';

// Keep explicit references here so Vercel's function bundler includes the
// server-only runtime variables. Values are never serialized to the client.
const runtimeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  APP_JWT_PRIVATE_KEY_BASE64: process.env.APP_JWT_PRIVATE_KEY_BASE64,
  APP_JWT_PUBLIC_KEY_BASE64: process.env.APP_JWT_PUBLIC_KEY_BASE64,
  SESSION_TOKEN_PEPPER: process.env.SESSION_TOKEN_PEPPER,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_STUDENT_BINDINGS_JSON: process.env.TELEGRAM_STUDENT_BINDINGS_JSON,
  WEB_AUTH_ACCOUNTS_JSON: process.env.WEB_AUTH_ACCOUNTS_JSON,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  UPSTASH_REDIS_REST_KV_REST_API_URL: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  UPSTASH_REDIS_REST_KV_REST_API_TOKEN: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
  SESSION_REDIS_PREFIX: process.env.SESSION_REDIS_PREFIX,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  PARENT_WEEKLY_REPORT_DAY: process.env.PARENT_WEEKLY_REPORT_DAY,
  PARENT_WEEKLY_REPORT_HOUR_KYIV: process.env.PARENT_WEEKLY_REPORT_HOUR_KYIV,
  MINI_APP_URL: process.env.MINI_APP_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL
};

export default {
  async fetch(request: Request): Promise<Response> {
    const app = await getVercelApp(runtimeEnvironment);
    return injectVercelRequest(app, request);
  }
};
