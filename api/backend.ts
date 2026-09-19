import { getVercelApp, injectVercelRequest } from '../server/vercel-preview.js';

// Keep explicit references here so Vercel's function bundler includes the
// server-only runtime variables. Values are never serialized to the client.
const runtimeEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  APP_JWT_PRIVATE_KEY_BASE64: process.env.APP_JWT_PRIVATE_KEY_BASE64,
  APP_JWT_PUBLIC_KEY_BASE64: process.env.APP_JWT_PUBLIC_KEY_BASE64,
  SESSION_TOKEN_PEPPER: process.env.SESSION_TOKEN_PEPPER,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
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
