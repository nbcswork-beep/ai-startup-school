import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { createJwtService } from './auth/jwt-service.js';
import { createVercelPreviewApp, injectVercelRequest, loadVercelPreviewEnv } from './vercel-preview.js';

const BOT_TOKEN = '123456789:preview-test-token';
let apps: FastifyInstance[] = [];

async function previewVariables(): Promise<NodeJS.ProcessEnv> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return {
    LOG_LEVEL: 'silent',
    VERCEL_URL: 'preview.example.vercel.app',
    VERCEL_BRANCH_URL: 'telegram-vercel-preview.example.vercel.app',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    SESSION_TOKEN_PEPPER: 'preview-test-pepper-with-enough-entropy',
    APP_JWT_PRIVATE_KEY_BASE64: Buffer.from(await exportPKCS8(pair.privateKey)).toString('base64'),
    APP_JWT_PUBLIC_KEY_BASE64: Buffer.from(await exportSPKI(pair.publicKey)).toString('base64')
  };
}

function signedInitData(nowSeconds = Math.floor(Date.now() / 1000)): string {
  const params = new URLSearchParams({
    auth_date: String(nowSeconds),
    query_id: 'preview-query',
    user: JSON.stringify({ id: 987654321, first_name: 'Оля', language_code: 'uk' })
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

describe('Vercel Telegram preview adapter', () => {
  it('rewrites every public API path into the single backend function', () => {
    const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { rewrites: Array<{ source: string; destination: string }> };
    expect(config.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api/backend?__aiss_path=:path*' });
  });

  it('fails closed when persistent preview secrets are unavailable', async () => {
    expect(() => loadVercelPreviewEnv({ VERCEL_URL: 'preview.example.vercel.app' })).toThrow(/APP_JWT_PRIVATE_KEY_BASE64/);
  });

  it('uses the same persistent signing keys across function instances', async () => {
    const variables = await previewVariables();
    const first = await createJwtService(loadVercelPreviewEnv(variables));
    const second = await createJwtService(loadVercelPreviewEnv(variables));
    const token = await first.sign({ userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), provider: 'telegram' });
    await expect(second.verify(token)).resolves.toMatchObject({ provider: 'telegram' });
  });

  it('routes health and rejects fake Telegram data and development login', async () => {
    const app = await createVercelPreviewApp(await previewVariables());
    apps.push(app);
    const health = await request(app, 'health', { headers: { origin: 'https://telegram-vercel-preview.example.vercel.app' } });
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe('https://telegram-vercel-preview.example.vercel.app');
    expect((await request(app, 'v1/auth/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: 'fake' }) })).status).toBe(401);
    expect((await request(app, 'v1/auth/development', { method: 'POST' })).status).toBe(404);
  });

  it('authenticates valid initData, serves bootstrap, and rotates the refresh session', async () => {
    const app = await createVercelPreviewApp(await previewVariables());
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
});
