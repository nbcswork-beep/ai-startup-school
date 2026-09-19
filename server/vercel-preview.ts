import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'light-my-request';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv, type AppEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MockAiProvider } from './services/ai-provider.js';

const ROUTE_PARAMETER = '__aiss_path';
let previewApp: Promise<FastifyInstance> | undefined;

function requirePreviewSecret(input: NodeJS.ProcessEnv, name: string): string {
  const value = input[name]?.trim();
  if (!value) throw new Error(`Vercel Preview requires ${name}`);
  return value;
}

function previewOrigins(input: NodeJS.ProcessEnv): string {
  const explicit = input.APP_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const vercel = [input.VERCEL_URL, input.VERCEL_BRANCH_URL]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => `https://${value}`);
  const origins = [...new Set([...explicit, ...vercel])];
  return (origins.length ? origins : ['http://localhost:3000', 'http://localhost:5173']).join(',');
}

export function loadVercelPreviewEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return loadEnv({
    ...input,
    NODE_ENV: 'development',
    DATA_BACKEND: 'memory',
    APP_ORIGINS: previewOrigins(input),
    DEV_AUTH_ENABLED: 'false',
    DEV_EPHEMERAL_JWT: 'false',
    APP_JWT_PRIVATE_KEY_BASE64: requirePreviewSecret(input, 'APP_JWT_PRIVATE_KEY_BASE64'),
    APP_JWT_PUBLIC_KEY_BASE64: requirePreviewSecret(input, 'APP_JWT_PUBLIC_KEY_BASE64'),
    SESSION_TOKEN_PEPPER: requirePreviewSecret(input, 'SESSION_TOKEN_PEPPER'),
    TELEGRAM_BOT_TOKEN: requirePreviewSecret(input, 'TELEGRAM_BOT_TOKEN')
  });
}

export async function createVercelPreviewApp(input: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const env = loadVercelPreviewEnv(input);
  const app = await buildApp({
    env,
    repository: new MemoryRepository(env.WORKSPACE_URL),
    jwt: await createJwtService(env),
    aiProvider: new MockAiProvider()
  });
  await app.ready();
  return app;
}

export function getVercelPreviewApp(): Promise<FastifyInstance> {
  previewApp ??= createVercelPreviewApp();
  return previewApp;
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
  return new Response(result.rawPayload, { status: result.statusCode, headers: responseHeaders });
}
