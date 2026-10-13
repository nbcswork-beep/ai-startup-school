import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z, ZodError } from 'zod';
import type { JwtService } from '../auth/jwt-service.js';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';
import type { AiChatService } from '../ai/chat.js';
import { AiService } from '../ai/service.js';

const uuid = z.string().uuid();
const note = z.string().trim().max(300).optional();
const amount = z.number().int().min(0).max(100_000_000_000);
const currency = z.string().trim().regex(/^[A-Za-z]{3}$/, 'Код валюти з трьох літер').transform(value => value.toUpperCase());
const price = z.number().min(0).max(100_000).nullable();
const family = z.enum(['gpt', 'claude', 'gemini', 'deepseek', 'qwen', 'llama', 'mistral', 'other']);
const header = z.object({ name: z.string().trim().min(1).max(64), value: z.string().max(2000) });
const isoDate = z.string().trim().refine(value => Number.isFinite(Date.parse(value)), 'Некоректна дата').transform(value => new Date(value).toISOString());

const providerCreate = z.object({
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().min(8).max(500),
  apiKey: z.string().trim().min(8).max(1000),
  keyLabel: z.string().trim().max(60).optional(),
  headers: z.array(header).max(10).default([]),
  balanceSource: z.enum(['none', 'openrouter', 'deepseek']).default('none'),
  enabled: z.boolean().default(true)
});
const providerPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  protocol: z.enum(['openai', 'anthropic']).optional(),
  baseUrl: z.string().trim().min(8).max(500).optional(),
  enabled: z.boolean().optional(),
  balanceSource: z.enum(['none', 'openrouter', 'deepseek']).optional(),
  headers: z.array(header).max(10).optional()
});
const pricing = z.object({ currency: currency.default('USD'), inputPer1M: price.default(null), outputPer1M: price.default(null), cachedInputPer1M: price.default(null) });
const modelCreate = z.object({
  providerId: uuid,
  apiModelId: z.string().trim().min(1).max(200).regex(/^[^\s\u0000-\u001f]+$/, 'ID моделі без пробілів'),
  label: z.string().trim().max(80).default(''),
  family: family.default('other'),
  maxOutputTokens: z.number().int().min(16).max(200_000).default(2048),
  maxInputTokens: z.number().int().min(512).max(2_000_000).default(16_000),
  pricing: pricing.default({ currency: 'USD', inputPer1M: null, outputPer1M: null, cachedInputPer1M: null }),
  fallbackModelId: uuid.nullable().default(null)
});
const modelPatch = z.object({
  apiModelId: z.string().trim().min(1).max(200).regex(/^[^\s\u0000-\u001f]+$/).optional(),
  label: z.string().trim().max(80).optional(),
  family: family.optional(),
  enabled: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(16).max(200_000).optional(),
  maxInputTokens: z.number().int().min(512).max(2_000_000).optional(),
  pricing: pricing.optional(),
  fallbackModelId: uuid.nullable().optional()
});
const settingsPatch = z.object({
  defaultModelId: uuid.nullable().optional(),
  systemPrompt: z.string().trim().min(1).max(8000).optional(),
  maxMessageChars: z.number().int().min(200).max(32_000).optional(),
  requestsPerMinute: z.number().int().min(1).max(120).optional(),
  maxConcurrentPerStudent: z.number().int().min(1).max(5).optional(),
  lowBalanceTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  resourceWarningPercent: z.number().int().min(1).max(90).optional()
});
const packageBody = z.object({
  name: z.string().trim().min(1).max(80),
  providerId: uuid,
  unit: z.enum(['tokens', 'credits', 'money']),
  currency: currency.default('USD'),
  purchasedAmount: z.number().min(0).max(10_000_000_000_000),
  cost: z.number().min(0).max(100_000_000).nullable().default(null),
  costCurrency: currency.default('USD'),
  purchasedAt: isoDate,
  expiresAt: isoDate.nullable().default(null),
  manualRemaining: z.number().min(0).max(10_000_000_000_000).nullable().default(null),
  note: z.string().trim().max(500).default('')
});

type Secured = { preHandler: preHandlerHookHandler[] };

export function registerAiRoutes(app: FastifyInstance, deps: { repository: AppRepository; authenticate: preHandlerHookHandler; ai: AiService; chat: AiChatService }): void {
  const { ai, chat, repository, authenticate } = deps;

  const requireAdmin = async (request: FastifyRequest) => {
    if (!request.access.roles.includes('admin')) {
      await repository.recordSecurityEvent({ eventType: 'unauthorized_admin_endpoint_attempt', severity: 'high', actorUserId: request.auth.userId, metadata: { method: request.method, path: request.routeOptions.url }, correlationId: request.id });
      throw new AppError('ADMIN_REQUIRED', 403, 'Потрібні права адміністратора');
    }
  };
  const requireStudent = async (request: FastifyRequest) => {
    if (!request.access.roles.includes('student')) throw new AppError('STUDENT_REQUIRED', 403, 'ШІ-асистент доступний учням');
  };
  const admin = (max = 60): Secured & { config: { rateLimit: { max: number; timeWindow: string } } } => ({ preHandler: [authenticate, requireAdmin], config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const student = (max = 60): Secured & { config: { rateLimit: { max: number; timeWindow: string } } } => ({ preHandler: [authenticate, requireStudent], config: { rateLimit: { max, timeWindow: '1 minute' } } });
  const A = '/api/v1/admin/ai';

  // ---- Admin: providers, keys, models
  app.get(`${A}/providers`, admin(), async () => {
    const [providers, models, settings] = await Promise.all([ai.listProviders(), ai.listModels(), ai.settings()]);
    return { providers, models, settings, secretsAvailable: ai.deps.secrets.available };
  });
  app.post(`${A}/providers`, admin(30), async (request, reply) => reply.status(201).send(await ai.createProvider(providerCreate.parse(request.body))));
  app.patch(`${A}/providers/:id`, admin(30), async request => ai.updateProvider(z.object({ id: uuid }).parse(request.params).id, providerPatch.parse(request.body)));
  app.delete(`${A}/providers/:id`, admin(30), async (request, reply) => { await ai.deleteProvider(z.object({ id: uuid }).parse(request.params).id); return reply.status(204).send(); });
  app.post(`${A}/providers/:id/test`, admin(15), async request => ai.testProvider(z.object({ id: uuid }).parse(request.params).id));
  app.get(`${A}/providers/:id/models`, admin(15), async request => ({ models: await ai.discoverModels(z.object({ id: uuid }).parse(request.params).id) }));
  app.post(`${A}/providers/:id/balance`, admin(15), async request => ai.syncBalance(z.object({ id: uuid }).parse(request.params).id));
  app.post(`${A}/providers/:id/keys`, admin(30), async (request, reply) => reply.status(201).send(await ai.addKey(z.object({ id: uuid }).parse(request.params).id, z.object({ label: z.string().trim().max(60).optional(), apiKey: z.string().trim().min(8).max(1000) }).parse(request.body))));
  app.patch(`${A}/providers/:id/keys/:keyId`, admin(30), async request => {
    const params = z.object({ id: uuid, keyId: uuid }).parse(request.params);
    return ai.updateKey(params.id, params.keyId, z.object({ label: z.string().trim().max(60).optional(), enabled: z.boolean().optional() }).parse(request.body));
  });
  app.delete(`${A}/providers/:id/keys/:keyId`, admin(30), async request => {
    const params = z.object({ id: uuid, keyId: uuid }).parse(request.params);
    return ai.deleteKey(params.id, params.keyId);
  });
  app.post(`${A}/models`, admin(30), async (request, reply) => reply.status(201).send(await ai.createModel(modelCreate.parse(request.body))));
  app.patch(`${A}/models/:id`, admin(30), async request => {
    const patch = modelPatch.parse(request.body);
    return ai.updateModel(z.object({ id: uuid }).parse(request.params).id, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
  });
  app.delete(`${A}/models/:id`, admin(30), async (request, reply) => { await ai.deleteModel(z.object({ id: uuid }).parse(request.params).id); return reply.status(204).send(); });
  app.post(`${A}/models/:id/test`, admin(15), async request => ai.testModel(z.object({ id: uuid }).parse(request.params).id, z.object({ prompt: z.string().trim().max(2000).optional() }).parse(request.body ?? {}).prompt));
  app.put(`${A}/settings`, admin(30), async request => {
    const patch = settingsPatch.parse(request.body);
    return ai.updateSettings(Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
  });
  app.put(`${A}/access/:scope/:targetId`, admin(30), async request => {
    const params = z.object({ scope: z.enum(['student', 'group']), targetId: uuid }).parse(request.params);
    const body = z.object({ modelIds: z.array(uuid).max(50).nullable(), defaultModelId: uuid.nullable().default(null) }).parse(request.body);
    return ai.setAccessRule(params.scope, params.targetId, body);
  });
  app.delete(`${A}/access/:scope/:targetId`, admin(30), async (request, reply) => {
    const params = z.object({ scope: z.enum(['student', 'group']), targetId: uuid }).parse(request.params);
    await ai.deleteAccessRule(params.scope, params.targetId);
    return reply.status(204).send();
  });

  // ---- Admin: tokens and limits. The student id always comes from the path and is checked against the roster.
  app.get(`${A}/tokens`, admin(), async () => ai.tokens());
  app.post(`${A}/tokens/students/:studentId`, admin(60), async request => {
    const { studentId } = z.object({ studentId: uuid }).parse(request.params);
    const body = z.object({ op: z.enum(['add', 'set', 'reset']), amount: amount.optional(), note }).parse(request.body);
    return ai.adjustStudent(request.auth.userId, studentId, body);
  });
  app.post(`${A}/tokens/students/:studentId/flags`, admin(60), async request => {
    const { studentId } = z.object({ studentId: uuid }).parse(request.params);
    const body = z.object({ blocked: z.boolean().optional(), monthlyLimit: amount.optional(), note }).parse(request.body);
    if (body.blocked !== undefined) await ai.setBlocked(request.auth.userId, studentId, body.blocked, body.note);
    if (body.monthlyLimit !== undefined) await ai.setMonthly(request.auth.userId, studentId, body.monthlyLimit, body.note);
    return { ok: true };
  });
  app.post(`${A}/tokens/groups/:groupId`, admin(20), async request => {
    const { groupId } = z.object({ groupId: uuid }).parse(request.params);
    const body = z.object({ op: z.enum(['add', 'set']), amount, note }).parse(request.body);
    const result = await ai.adjustGroup(request.auth.userId, groupId, body);
    return { batchId: result.batchId, count: result.count, delta: result.delta };
  });
  app.get(`${A}/tokens/ledger`, admin(), async request => {
    const query = z.object({ studentId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { entries: await ai.ledger(query.studentId ?? null, query.limit) };
  });

  // ---- Admin: purchased provider resources
  app.get(`${A}/resources`, admin(), async () => ai.resources());
  app.post(`${A}/resources/packages`, admin(30), async (request, reply) => reply.status(201).send(await ai.createPackage(packageBody.parse(request.body))));
  app.patch(`${A}/resources/packages/:id`, admin(30), async request => {
    const patch = packageBody.partial().parse(request.body);
    return ai.updatePackage(z.object({ id: uuid }).parse(request.params).id, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
  });
  app.delete(`${A}/resources/packages/:id`, admin(30), async (request, reply) => { await ai.deletePackage(z.object({ id: uuid }).parse(request.params).id); return reply.status(204).send(); });

  // ---- Admin: analytics
  app.get(`${A}/analytics`, admin(), async request => ai.analytics(z.object({
    range: z.enum(['day', 'week', 'month']).default('week'), studentId: uuid.optional(), groupId: uuid.optional(), modelId: uuid.optional()
  }).parse(request.query)));
  app.get(`${A}/usage`, admin(), async request => ({ usage: await ai.store.listUsage(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query).limit) }));

  // ---- Student: assistant. Every id comes from the session; conversations are looked up under it.
  app.get('/api/v1/ai/me', student(), async request => chat.me(request.auth.userId));
  app.get('/api/v1/ai/conversations', student(), async request => ({ conversations: await chat.listConversations(request.auth.userId) }));
  app.post('/api/v1/ai/conversations', student(20), async (request, reply) => reply.status(201).send(await chat.createConversation(request.auth.userId, z.object({ title: z.string().trim().max(80).optional() }).parse(request.body ?? {}).title)));
  app.get('/api/v1/ai/conversations/:id', student(), async request => chat.getConversation(request.auth.userId, z.object({ id: uuid }).parse(request.params).id));
  app.patch('/api/v1/ai/conversations/:id', student(30), async request => chat.renameConversation(request.auth.userId, z.object({ id: uuid }).parse(request.params).id, z.object({ title: z.string().trim().min(1).max(80) }).parse(request.body).title));
  app.delete('/api/v1/ai/conversations/:id', student(30), async (request, reply) => { await chat.deleteConversation(request.auth.userId, z.object({ id: uuid }).parse(request.params).id); return reply.status(204).send(); });
  app.post('/api/v1/ai/conversations/:id/stream', { ...student(30), bodyLimit: 262_144 }, async (request, reply) => {
    const { id } = z.object({ id: z.union([uuid, z.literal('new')]) }).parse(request.params);
    const body = chatBody.parse(request.body);
    const abort = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) abort.abort(); });
    const session = await chat.start(request.auth.userId, id, body, abort.signal);
    void session.done;
    reply.header('content-type', 'text/event-stream; charset=utf-8').header('x-accel-buffering', 'no').header('cache-control', 'no-store');
    return reply.send(Readable.fromWeb(session.stream as unknown as NodeReadableStream<Uint8Array>));
  });
}

const chatBody = z.object({
  content: z.string().max(40_000),
  modelId: z.string().uuid().optional(),
  clientRequestId: z.string().uuid()
});

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/**
 * The streaming endpoint as a plain fetch handler, for the Vercel function that serves it: the main
 * backend function buffers responses, which would turn a live answer into one late blob. Same checks
 * as the Fastify route: signed access token, active session, student role, same-origin request.
 */
export function createAiStreamHandler(deps: { jwt: JwtService; repository: AppRepository; chat: AiChatService; origins: string[] }) {
  return async (request: Request): Promise<{ response: Response; done: Promise<void> | null }> => {
    try {
      if (request.method !== 'POST') return { response: jsonError(405, 'METHOD_NOT_ALLOWED', 'Метод не підтримується'), done: null };
      const origin = request.headers.get('origin');
      if (origin && !deps.origins.includes(origin)) return { response: jsonError(403, 'ORIGIN_FORBIDDEN', 'Запит з іншого сайту відхилено'), done: null };
      const header = request.headers.get('authorization');
      if (!header?.startsWith('Bearer ')) return { response: jsonError(401, 'AUTH_REQUIRED', 'Потрібна авторизація'), done: null };
      const principal = await deps.jwt.verify(header.slice(7));
      const access = await deps.repository.getAccessContext(principal.userId, principal.sessionId);
      if (!access.sessionActive || access.status !== 'active') return { response: jsonError(401, 'SESSION_REVOKED', 'Сесію завершено. Увійдіть ще раз.'), done: null };
      if (!access.roles.includes('student')) return { response: jsonError(403, 'STUDENT_REQUIRED', 'ШІ-асистент доступний учням'), done: null };
      const url = new URL(request.url);
      const conversationId = z.union([z.string().uuid(), z.literal('new')]).parse(url.searchParams.get('conversationId') ?? url.pathname.split('/').at(-2));
      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > 262_144) return { response: jsonError(413, 'BODY_TOO_LARGE', 'Повідомлення завелике'), done: null };
      const raw = await request.text();
      if (raw.length > 262_144) return { response: jsonError(413, 'BODY_TOO_LARGE', 'Повідомлення завелике'), done: null };
      const body = chatBody.parse(JSON.parse(raw || '{}'));
      const session = await deps.chat.start(principal.userId, conversationId, body, request.signal);
      return { response: new Response(session.stream, { status: 200, headers: SSE_HEADERS }), done: session.done };
    } catch (error) {
      if (error instanceof AppError) return { response: jsonError(error.statusCode, error.code, error.message), done: null };
      if (error instanceof ZodError || error instanceof SyntaxError) return { response: jsonError(400, 'VALIDATION_ERROR', 'Некоректні дані запиту'), done: null };
      console.error('AI stream request failed', error instanceof Error ? error.message : 'unknown error');
      return { response: jsonError(500, 'INTERNAL_ERROR', 'Внутрішня помилка сервера'), done: null };
    }
  };
}
