import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { createJwtService } from './auth/jwt-service.js';
import { createVercelApp, injectVercelRequest, loadVercelEnv } from './vercel-preview.js';
import { hashPassword } from './auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, MemorySessionStore } from './auth/session-store.js';

const BOT_TOKEN = '123456789:preview-test-token';
let apps: FastifyInstance[] = [];
const testPasswordHash = hashPassword('correct horse battery staple');

async function previewVariables(): Promise<NodeJS.ProcessEnv> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return {
    LOG_LEVEL: 'silent',
    VERCEL_URL: 'preview.example.vercel.app',
    VERCEL_BRANCH_URL: 'telegram-vercel-preview.example.vercel.app',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_STUDENT_BINDINGS_JSON: JSON.stringify({ illia: '987654321' }),
    SESSION_TOKEN_PEPPER: 'preview-test-pepper-with-enough-entropy',
    APP_JWT_PRIVATE_KEY_BASE64: Buffer.from(await exportPKCS8(pair.privateKey)).toString('base64'),
    APP_JWT_PUBLIC_KEY_BASE64: Buffer.from(await exportSPKI(pair.publicKey)).toString('base64'),
    WEB_AUTH_ACCOUNTS_JSON: JSON.stringify([{ userId:'12000000-0000-4000-8000-000000000001',email:'admin@example.test',passwordHash:await testPasswordHash }]),
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: 'test-only-token',
    TELEGRAM_WEBHOOK_SECRET: 'preview_webhook_test_secret_123',
    MINI_APP_URL: 'https://preview.example.vercel.app'
  };
}

async function createTestApp(input: NodeJS.ProcessEnv, telegramWebhookHandler?:Parameters<typeof createVercelApp>[1]['telegramWebhookHandler']): Promise<FastifyInstance> {
  return createVercelApp(input, { sessionStore:new MemorySessionStore(), loginLimiter:new MemoryLoginAttemptLimiter(), ...(telegramWebhookHandler?{telegramWebhookHandler}:{}) });
}

function signedInitData(telegramId = 987654321, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({
    auth_date: String(nowSeconds),
    query_id: 'preview-query',
    user: JSON.stringify({ id: telegramId, first_name: 'Telegram name', language_code: 'uk' })
  });
  const data = [...params.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return params.toString();
}

async function request(app: FastifyInstance, path: string, init?: RequestInit): Promise<Response> {
  return injectVercelRequest(app, new Request(`https://preview.example.vercel.app/api/backend?__aiss_path=${encodeURIComponent(path)}`, init));
}

afterEach(async () => {
  await Promise.all(apps.map(app => app.close()));
  apps = [];
});

describe('Vercel Telegram deployment adapter', () => {
  it('rewrites every public API path into the single backend function', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { rewrites: Array<{ source: string; destination: string }> };
    expect(config.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api/backend?__aiss_path=:path*' });
  });

  it('fails closed with the detected deployment environment when persistent secrets are unavailable', async () => {
    expect(() => loadVercelEnv({ VERCEL_ENV: 'production', VERCEL_URL: 'app.example.vercel.app' })).toThrow(/Vercel production deployment requires APP_JWT_PRIVATE_KEY_BASE64/);
    const missingWebAccounts=await previewVariables();delete missingWebAccounts.WEB_AUTH_ACCOUNTS_JSON;
    expect(()=>loadVercelEnv(missingWebAccounts)).toThrow(/WEB_AUTH_ACCOUNTS_JSON/);
    const missingRedis=await previewVariables();delete missingRedis.UPSTASH_REDIS_REST_URL;
    expect(()=>loadVercelEnv(missingRedis)).toThrow(/UPSTASH_REDIS_REST_URL/);
  });

  it('uses production mode and the canonical production origin on a production deployment', async () => {
    const env = loadVercelEnv({
      ...await previewVariables(),
      VERCEL_ENV: 'production',
      VERCEL_URL: 'generated-deployment.example.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'ai-startup-school.vercel.app'
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.DEV_AUTH_ENABLED).toBe(false);
    expect(env.DEV_EPHEMERAL_JWT).toBe(false);
    expect(env.origins).toContain('https://ai-startup-school.vercel.app');
  });

  it('requires the webhook secret and derives the Production Mini App URL before routes start',async()=>{
    const missingSecret=await previewVariables();
    missingSecret.VERCEL_ENV='production';
    missingSecret.VERCEL_PROJECT_PRODUCTION_URL='ai-startup-school.vercel.app';
    delete missingSecret.TELEGRAM_WEBHOOK_SECRET;
    expect(()=>loadVercelEnv(missingSecret)).toThrow(/TELEGRAM_WEBHOOK_SECRET/);

    const derived=await previewVariables();
    derived.VERCEL_ENV='production';
    derived.VERCEL_PROJECT_PRODUCTION_URL='ai-startup-school.vercel.app';
    delete derived.MINI_APP_URL;
    expect(loadVercelEnv(derived).MINI_APP_URL).toBe('https://ai-startup-school.vercel.app');
  });

  it('rejects an invalid explicit Mini App URL with its field name only',async()=>{
    const variables=await previewVariables();
    variables.VERCEL_ENV='production';
    variables.MINI_APP_URL='http://private-mini-app.example.test';
    let caught:unknown;
    try{loadVercelEnv(variables)}catch(error){caught=error}
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('MINI_APP_URL');
    expect((caught as Error).message).not.toContain('private-mini-app.example.test');
  });

  it('resolves both standard and custom-prefixed Upstash REST integration variables', async () => {
    const standard=await previewVariables();
    expect(loadVercelEnv(standard).UPSTASH_REDIS_REST_URL).toBe('https://redis.example.test');
    const prefixed=await previewVariables();
    delete prefixed.UPSTASH_REDIS_REST_URL;delete prefixed.UPSTASH_REDIS_REST_TOKEN;
    prefixed.UPSTASH_REDIS_REST_KV_REST_API_URL='https://prefixed-redis.example.test';
    prefixed.UPSTASH_REDIS_REST_KV_REST_API_TOKEN='prefixed-test-token';
    const resolved=loadVercelEnv(prefixed);
    expect(resolved.UPSTASH_REDIS_REST_URL).toBe('https://prefixed-redis.example.test');
    expect(resolved.UPSTASH_REDIS_REST_TOKEN).toBe('prefixed-test-token');
  });

  it('prefers a complete standard Upstash pair and rejects incomplete pairs', async () => {
    const both=await previewVariables();
    both.UPSTASH_REDIS_REST_KV_REST_API_URL='https://fallback.example.test';
    both.UPSTASH_REDIS_REST_KV_REST_API_TOKEN='fallback-token';
    expect(loadVercelEnv(both).UPSTASH_REDIS_REST_URL).toBe('https://redis.example.test');
    const incomplete=await previewVariables();
    delete incomplete.UPSTASH_REDIS_REST_TOKEN;
    expect(()=>loadVercelEnv(incomplete)).toThrow(/complete Redis REST pair/);
  });

  it('uses the same persistent signing keys across function instances', async () => {
    const variables = await previewVariables();
    const first = await createJwtService(loadVercelEnv(variables));
    const second = await createJwtService(loadVercelEnv(variables));
    const token = await first.sign({ userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), provider: 'telegram' });
    await expect(second.verify(token)).resolves.toMatchObject({ provider: 'telegram' });
  });

  it('routes health and rejects fake Telegram data and development login', async () => {
    const app = await createTestApp(await previewVariables());
    apps.push(app);
    const health = await request(app, 'health', { headers: { origin: 'https://telegram-vercel-preview.example.vercel.app' } });
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe('https://telegram-vercel-preview.example.vercel.app');
    expect((await request(app, 'v1/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: 'fake' }) })).status).toBe(401);
    expect((await request(app, 'v1/auth/development', { method: 'POST' })).status).toBe(404);
  });

  it('routes the protected Telegram webhook through the Vercel catch-all function',async()=>{
    const handler=vi.fn(async(_request,reply)=>reply.status(200).send(''));
    const app=await createTestApp(await previewVariables(),handler);apps.push(app);
    expect((await request(app,'telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'preview_webhook_test_secret_123'},body:JSON.stringify({update_id:1})})).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect((await request(app,'telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'wrong-secret-value'},body:JSON.stringify({update_id:2})})).status).toBe(401);
  });

  it('authenticates valid initData, serves bootstrap, and rotates the refresh session', async () => {
    const app = await createTestApp({
      ...await previewVariables(),
      VERCEL_ENV: 'production',
      VERCEL_URL: 'generated-deployment.example.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'ai-startup-school.vercel.app'
    });
    apps.push(app);
    const login = await request(app, 'v1/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: signedInitData() }) });
    expect(login.status).toBe(200);
    const { accessToken } = await login.json() as { accessToken: string };
    const bootstrap = await request(app, 'v1/bootstrap', { headers: { authorization: `Bearer ${accessToken}` } });
    expect(bootstrap.status).toBe(200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^aiss_refresh=/);
    expect(login.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
    const refresh = await request(app, 'v1/auth/refresh', { method: 'POST', headers: { cookie: cookie! } });
    expect(refresh.status).toBe(200);
    expect((await refresh.json() as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it('authenticates each bound pilot student and rejects a valid but unbound Telegram account', async () => {
    const app = await createTestApp({
      ...await previewVariables(),
      TELEGRAM_STUDENT_BINDINGS_JSON: JSON.stringify({
        illia: '987654321', ivan: '987654322', rinat: '987654323', yuliia: '987654324'
      })
    });
    apps.push(app);

    const expectedNames = ['Ілля', 'Іван', 'Рінат', '🐭💗 Мишка'];
    for (let index = 0; index < expectedNames.length; index += 1) {
      const login = await request(app, 'v1/auth/telegram', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: signedInitData(987654321 + index) })
      });
      expect(login.status).toBe(200);
      const { accessToken } = await login.json() as { accessToken: string };
      const bootstrap = await request(app, 'v1/bootstrap', { headers: { authorization: `Bearer ${accessToken}` } });
      expect(bootstrap.status).toBe(200);
      expect((await bootstrap.json() as { home: { viewer: { firstName: string } } }).home.viewer.firstName).toBe(expectedNames[index]);
    }

    const unknown = await request(app, 'v1/auth/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: signedInitData(987654399) })
    });
    expect(unknown.status).toBe(403);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe('TELEGRAM_ACCOUNT_NOT_LINKED');
  });
});
