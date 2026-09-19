import { createJwtService } from '../server/auth/jwt-service.js';
import { loadEnv } from '../server/config/env.js';
import { MemoryRepository } from '../server/data/memory-repository.js';
import { MockAiProvider } from '../server/services/ai-provider.js';
import { buildApp } from '../server/app.js';

/**
 * Vercel-only Telegram preview backend.
 *
 * This intentionally uses the in-memory repository and ephemeral signing keys,
 * but it does NOT enable the development-login endpoint. Telegram initData is
 * still validated by the existing server-side auth flow with TELEGRAM_BOT_TOKEN.
 *
 * This file lives only on the telegram-vercel-preview branch and is not a
 * production deployment configuration.
 */
const deploymentOrigin = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://localhost.invalid';

const env = loadEnv({
  ...process.env,
  NODE_ENV: 'development',
  DATA_BACKEND: 'memory',
  APP_ORIGINS: deploymentOrigin,
  DEV_AUTH_ENABLED: 'false',
  DEV_EPHEMERAL_JWT: 'true',
  SESSION_TOKEN_PEPPER:
    process.env.SESSION_TOKEN_PEPPER || 'telegram-preview-ephemeral-session-pepper',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || ''
});

const repository = new MemoryRepository(env.WORKSPACE_URL);
const jwt = await createJwtService(env);
const app = await buildApp({
  env,
  repository,
  jwt,
  aiProvider: new MockAiProvider()
});

await app.ready();

export default async function handler(request: any, response: any) {
  app.server.emit('request', request, response);
}
