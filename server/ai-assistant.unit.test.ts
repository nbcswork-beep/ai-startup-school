import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { createAssignedPilotState } from './data/assigned-pilot.test-fixture.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MemoryPilotRuntimeStore } from './data/pilot-runtime-store.js';
import { DEV_IDS, PILOT_STUDENTS } from './data/seed.js';
import { RedisAiStore } from './ai/store.js';
import { MockProviderServer, MOCK_USAGE } from './ai/testing/mock-provider.js';
import { RedisEmulator } from './ai/testing/redis-emulator.js';
import { extractArchiveText } from './ai/files.js';
import { createZip } from './ai/zip.js';

const ADMIN = '14000000-0000-4000-8000-000000000001';
const STUDENT = DEV_IDS.user;
const OTHER = PILOT_STUDENTS[1].id;
const KEY = 'test-key-1234567890';
const apps: FastifyInstance[] = [];
let mock: MockProviderServer;

beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface SseEvent { event: string; data: any }

function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').filter(frame => frame.startsWith('event:')).map(frame => {
    const [eventLine, dataLine] = frame.split('\n');
    return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
  });
}

function school() {
  const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
  const redis = new RedisEmulator();
  const aiStore = new RedisAiStore(redis, 'aiss:test:ai:v1');
  const as = async (userId: string) => {
    const env = loadEnv({ NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'ai-assistant-test-pepper', DEV_USER_ID: userId });
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const app = await buildApp({ env, repository, jwt: await createJwtService(env), aiStore });
    apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;
    const headers = { authorization: `Bearer ${token}` };
    const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    const send = async (content: string, options: { conversationId?: string; modelId?: string; clientRequestId?: string } = {}) => {
      const response = await call('POST', `/api/v1/ai/conversations/${options.conversationId ?? 'new'}/stream`, { content, clientRequestId: options.clientRequestId ?? randomUUID(), ...(options.modelId ? { modelId: options.modelId } : {}) });
      const events = response.statusCode === 200 ? parseSse(response.body) : [];
      return { response, events, done: events.find(item => item.event === 'done')?.data, error: events.find(item => item.event === 'error')?.data };
    };
    return { app, token, headers, call, send };
  };
  return { redis, aiStore, as };
}

async function configure(admin: Awaited<ReturnType<ReturnType<typeof school>['as']>>, models: string[] = ['echo-1']) {
  const created = await admin.call('POST', '/api/v1/admin/ai/providers', { name: 'Mock reseller', protocol: 'openai', baseUrl: mock.baseUrl, apiKey: KEY, headers: [{ name: 'X-Title', value: 'AI Startup School' }] });
  expect(created.statusCode).toBe(201);
  const provider = created.json();
  const ids: Record<string, string> = {};
  for (const apiModelId of models) {
    const model = await admin.call('POST', '/api/v1/admin/ai/models', { providerId: provider.id, apiModelId, label: apiModelId.toUpperCase(), family: 'gpt', maxOutputTokens: 512, maxInputTokens: 8000, pricing: { currency: 'USD', inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 1 } });
    expect(model.statusCode).toBe(201);
    const enabled = await admin.call('PATCH', `/api/v1/admin/ai/models/${model.json().id}`, { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true });
    expect(enabled.json().verifiedAt).toBeTruthy();
    ids[apiModelId] = model.json().id;
  }
  expect((await admin.call('PUT', '/api/v1/admin/ai/settings', { defaultModelId: ids[models[0]!] })).statusCode).toBe(200);
  return { provider, ids };
}

describe('AI assistant — admin configuration', () => {
  it('connects a third-party API, keeps the key on the server and verifies models with a real request', async () => {
    const { as, redis } = school();
    const admin = await as(ADMIN);
    const created = await admin.call('POST', '/api/v1/admin/ai/providers', { name: 'Reseller', protocol: 'openai', baseUrl: mock.baseUrl, apiKey: KEY, headers: [] });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(KEY);
    expect(created.json().keys[0]).toMatchObject({ hint: '7890', enabled: true });
    const id = created.json().id;

    const test = await admin.call('POST', `/api/v1/admin/ai/providers/${id}/test`);
    expect(test.json()).toMatchObject({ ok: true, modelCount: 6 });
    const listed = await admin.call('GET', `/api/v1/admin/ai/providers/${id}/models`);
    expect(listed.json().models.map((model: { id: string }) => model.id)).toContain('echo-1');

    // A model that the API does not serve is never switched on.
    const ghost = await admin.call('POST', '/api/v1/admin/ai/models', { providerId: id, apiModelId: 'gpt-imaginary-9', label: 'Ghost' });
    const refused = await admin.call('PATCH', `/api/v1/admin/ai/models/${ghost.json().id}`, { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toContain('does not exist');

    const real = await admin.call('POST', '/api/v1/admin/ai/models', { providerId: id, apiModelId: 'echo-1', label: 'Echo', pricing: { currency: 'USD', inputPer1M: 2, outputPer1M: 8 } });
    const probe = await admin.call('POST', `/api/v1/admin/ai/models/${real.json().id}/test`, {});
    expect(probe.json()).toMatchObject({ ok: true, usage: { input: MOCK_USAGE.input, output: MOCK_USAGE.output, approximate: false } });
    expect(probe.json().text).toContain('Відповідь:');

    // Wrong key: the error is shown to the admin, the key is not.
    const badKey = await admin.call('POST', `/api/v1/admin/ai/providers/${id}/keys`, { label: 'Старий', apiKey: 'sk-wrong-0000000000000000' });
    expect(badKey.body).not.toContain('sk-wrong');
    const providers = await admin.call('GET', '/api/v1/admin/ai/providers');
    expect(providers.body).not.toContain(KEY);
    expect(providers.json().providers[0].keys).toHaveLength(2);

    expect(redis.dump()).toContain('Reseller');
    expect(redis.dump()).not.toContain(KEY);
    expect(redis.dump()).not.toContain('sk-wrong');
  });

  it('rejects non-admins from every AI admin endpoint and records the attempt', async () => {
    const { as } = school();
    const student = await as(STUDENT);
    for (const [method, url] of [['GET', '/api/v1/admin/ai/providers'], ['GET', '/api/v1/admin/ai/tokens'], ['POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`], ['GET', '/api/v1/admin/ai/analytics'], ['GET', '/api/v1/admin/ai/resources']] as const) {
      const response = await student.call(method, url, method === 'POST' ? { op: 'add', amount: 1_000_000 } : undefined);
      expect(response.statusCode, url).toBe(403);
    }
    const admin = await as(ADMIN);
    expect((await admin.call('GET', '/api/v1/ai/me')).statusCode).toBe(403);
  });
});

describe('AI assistant — student chat and honest token accounting', () => {
  it('blocks a student without tokens, then charges exactly the usage the provider reports', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin);
    const student = await as(STUDENT);

    expect((await student.call('GET', '/api/v1/ai/me')).json()).toMatchObject({ configured: true, balance: { available: 0, exhausted: true }, models: [{ id: ids['echo-1'] }] });
    const empty = await student.send('Привіт!');
    expect(empty.response.statusCode).toBe(402);
    expect(empty.response.json().error).toMatchObject({ code: 'AI_LIMIT_EXHAUSTED', message: 'Ваш ліміт ШІ-токенів вичерпано. Зверніться до викладача.' });

    const grant = await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 1_000_000, note: 'Перший мільйон' });
    expect(grant.json()).toEqual({ before: 0, after: 1_000_000 });
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance).toMatchObject({ available: 1_000_000, exhausted: false });

    const chat = await student.send('Поясни, що таке MVP');
    expect(chat.response.statusCode).toBe(200);
    expect(chat.response.headers['content-type']).toContain('text/event-stream');
    expect(chat.events.map(item => item.event)).toEqual(['start', ...Array(chat.events.length - 2).fill('delta'), 'done']);
    expect(chat.events.filter(item => item.event === 'delta').map(item => item.data.text).join('')).toBe('Відповідь: Поясни, що таке MVP');
    expect(chat.done).toMatchObject({ status: 'complete', usage: { input: 120, output: 30, total: 150, charged: 150, approximate: false }, balance: { available: 999_850 } });

    // Saved and reloadable.
    const conversations = (await student.call('GET', '/api/v1/ai/conversations')).json().conversations;
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ title: 'Поясни, що таке MVP', messageCount: 2 });
    const reloaded = await (await as(STUDENT)).call('GET', `/api/v1/ai/conversations/${conversations[0].id}`);
    expect(reloaded.json().messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);

    // A follow-up in the same chat sends the history; the provider never sees the student's name.
    const followUp = await student.send('А коротше?', { conversationId: conversations[0].id });
    expect(followUp.done.usage.charged).toBe(150);
    const lastRequest = mock.chatRequests().at(-1)!;
    expect(lastRequest.body.messages.map((message: { role: string }) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.stringify(lastRequest.body)).not.toMatch(/Ілля|Анохін|10000000-0000-4000-8000-000000000001/);
    expect(lastRequest.body.user).toBeUndefined();

    const tokens = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json();
    expect(tokens.students.find((row: { studentId: string }) => row.studentId === STUDENT)).toMatchObject({ balance: 999_700, used: 300, allocated: 1_000_000, requests: 2, lastModel: 'ECHO-1', approxUsed: 0 });
    const ledger = (await admin.call('GET', `/api/v1/admin/ai/tokens/ledger?studentId=${STUDENT}`)).json().entries;
    expect(ledger.map((entry: { type: string; amount: number }) => [entry.type, entry.amount])).toEqual([['charge', -150], ['charge', -150], ['grant', 1_000_000]]);

    const analytics = (await admin.call('GET', '/api/v1/admin/ai/analytics?range=week')).json();
    expect(analytics.totals).toMatchObject({ requests: 3, charged: 300 });
    expect(analytics.byStudent[0]).toMatchObject({ id: STUDENT, tokens: 300, requests: 2 });
    expect(analytics.costs[0].currency).toBe('USD');
    expect((await admin.call('GET', `/api/v1/admin/ai/analytics?range=day&studentId=${STUDENT}`)).json().totals.tokens).toBe(300);
  });

  it('keeps chats and balances private to each student', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const owner = await as(STUDENT);
    const chat = await owner.send('Мій секрет');
    const conversationId = chat.done.conversationId;
    const intruder = await as(OTHER);
    expect((await intruder.call('GET', `/api/v1/ai/conversations/${conversationId}`)).statusCode).toBe(404);
    expect((await intruder.call('PATCH', `/api/v1/ai/conversations/${conversationId}`, { title: 'зламано' })).statusCode).toBe(404);
    expect((await intruder.call('DELETE', `/api/v1/ai/conversations/${conversationId}`)).statusCode).toBe(404);
    expect((await intruder.send('Допиши', { conversationId })).response.statusCode).toBe(404);
    expect((await intruder.call('GET', '/api/v1/ai/conversations')).json().conversations).toEqual([]);
    // A forged student id in the body changes nothing: the server uses the session.
    const forged = await intruder.call('POST', '/api/v1/ai/conversations/new/stream', { content: 'x', clientRequestId: randomUUID(), studentId: STUDENT });
    expect(forged.statusCode).toBe(402);
    expect((await intruder.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(0);
    expect((await owner.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(100_000 - 150);
  });

  it('names a new chat with the plain words of its first message', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 50_000 });
    const student = await as(STUDENT);
    await student.send('## План\n- **крок 1**: перевірити `ідею`\n```js\nconst x = 1;\n```');
    expect((await student.call('GET', '/api/v1/ai/conversations')).json().conversations[0].title).toBe('План крок 1: перевірити ідею');
  });

  it('runs a repeated request once', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 50_000 });
    const student = await as(STUDENT);
    const clientRequestId = randomUUID();
    expect((await student.send('Раз', { clientRequestId })).done.usage.charged).toBe(150);
    const repeat = await student.send('Раз', { clientRequestId });
    expect(repeat.response.statusCode).toBe(409);
    expect(repeat.response.json().error.code).toBe('AI_DUPLICATE_REQUEST');
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(49_850);
  });

  it('never spends more than the balance under parallel requests, and serves several students at once', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('PUT', '/api/v1/admin/ai/settings', { maxConcurrentPerStudent: 5, requestsPerMinute: 100 });
    // Enough for one reservation (input estimate + 512 output), not for two.
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'set', amount: 1_200 });
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${OTHER}`, { op: 'set', amount: 10_000 });
    const [first, second] = [await as(STUDENT), await as(OTHER)];
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, index) => first.send(`Паралельний запит ${index}`)),
      ...Array.from({ length: 3 }, (_, index) => second.send(`Інший учень ${index}`))
    ]);
    const mine = results.slice(0, 8);
    const theirs = results.slice(8);
    const succeeded = mine.filter(result => result.response.statusCode === 200 && result.done);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.length).toBeLessThanOrEqual(2);
    expect(mine.filter(result => result.response.statusCode === 402).length).toBe(8 - succeeded.length);
    expect(theirs.every(result => result.done?.status === 'complete')).toBe(true);
    const rows = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json().students;
    const row = rows.find((item: { studentId: string }) => item.studentId === STUDENT);
    expect(row.balance).toBe(1_200 - 150 * succeeded.length);
    expect(row.balance).toBeGreaterThanOrEqual(0);
    expect(row.reserved).toBe(0);
    expect(row.used + row.balance).toBe(1_200);
    expect(rows.find((item: { studentId: string }) => item.studentId === OTHER)).toMatchObject({ used: 450, balance: 9_550 });
  });

  it('falls back to the reserve model on a provider failure, and charges nothing when the provider refused', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['echo-1', 'echo-2']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);

    mock.failNextChats(500, 1);
    const failed = await student.send('Без резерву');
    expect(failed.error).toMatchObject({ code: 'AI_PROVIDER_ERROR', usage: { charged: 0 } });
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(100_000);

    mock.failNextChats(429, 1);
    expect((await student.send('Перевантаження')).error).toMatchObject({ code: 'AI_PROVIDER_BUSY' });

    expect((await admin.call('PATCH', `/api/v1/admin/ai/models/${ids['echo-1']}`, { fallbackModelId: ids['echo-2'] })).statusCode).toBe(200);
    mock.failNextChats(500, 1);
    const rescued = await student.send('З резервом');
    expect(rescued.events.find(item => item.event === 'model')?.data).toMatchObject({ id: ids['echo-2'], reason: 'fallback' });
    expect(rescued.done).toMatchObject({ status: 'complete', message: { modelId: ids['echo-2'] }, usage: { charged: 150 } });
    const analytics = (await admin.call('GET', '/api/v1/admin/ai/analytics?range=day')).json();
    expect(analytics.errors.length).toBeGreaterThanOrEqual(3);
    expect(analytics.errors[0]).toMatchObject({ providerName: 'Mock reseller', status: 500 });
  });

  it('flags the charge as approximate when the provider reports no usage', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['no-usage']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const chat = await student.send('Скільки токенів?', { modelId: ids['no-usage'] });
    expect(chat.done.usage.approximate).toBe(true);
    expect(chat.done.usage.charged).toBeGreaterThan(0);
    expect(chat.done.message.usage.approximate).toBe(true);
    const row = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json().students.find((item: { studentId: string }) => item.studentId === STUDENT);
    expect(row.approxUsed).toBe(chat.done.usage.charged);
  });

  it('stops a generation, keeps the partial answer and charges an estimate of what was used', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['slow']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const controller = new AbortController();
    const { response, done } = await student.app.aiStreamHandler(new Request('http://localhost/api/v1/ai/conversations/new/stream?conversationId=new', {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${student.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Довга відповідь', clientRequestId: randomUUID(), modelId: ids.slow })
    }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('частина 2')) received += decoder.decode((await reader.read()).value);
    controller.abort();
    await reader.cancel().catch(() => {});
    await done;
    const conversations = (await student.call('GET', '/api/v1/ai/conversations')).json().conversations;
    const messages = (await student.call('GET', `/api/v1/ai/conversations/${conversations[0].id}`)).json().messages;
    expect(messages[1]).toMatchObject({ role: 'assistant', status: 'stopped', usage: { approximate: true } });
    expect(messages[1].content).toContain('частина 2');
    expect(messages[1].content).not.toContain('частина 39');
    const me = (await student.call('GET', '/api/v1/ai/me')).json();
    expect(me.balance.available).toBe(100_000 - messages[1].usage.total);
    expect(me.balance.approximateUsed).toBe(messages[1].usage.total);
  });

  it('honours blocking, per-group model access and forbids models outside it', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['echo-1', 'echo-2']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const groupId = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json().students.find((row: { studentId: string }) => row.studentId === STUDENT).groupId;
    expect((await admin.call('PUT', `/api/v1/admin/ai/access/group/${groupId}`, { modelIds: [ids['echo-2']], defaultModelId: ids['echo-2'] })).statusCode).toBe(200);
    const student = await as(STUDENT);
    const me = (await student.call('GET', '/api/v1/ai/me')).json();
    expect(me.models.map((model: { id: string }) => model.id)).toEqual([ids['echo-2']]);
    expect(me.defaultModelId).toBe(ids['echo-2']);
    const forbidden = await student.send('Хочу іншу', { modelId: ids['echo-1'] });
    expect(forbidden.response.statusCode).toBe(403);
    expect(forbidden.response.json().error.code).toBe('AI_MODEL_FORBIDDEN');
    expect((await student.send('Можна?')).done.message.modelId).toBe(ids['echo-2']);

    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}/flags`, { blocked: true, note: 'Перевірка' });
    const blocked = await student.send('А тепер?');
    expect(blocked.response.statusCode).toBe(403);
    expect(blocked.response.json().error.message).toBe('Доступ до ШІ тимчасово призупинено. Зверніться до викладача.');
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}/flags`, { blocked: false });
    expect((await student.send('Знову можна?')).done.status).toBe('complete');
  });

  it('grants tokens to a whole group in one journaled batch', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const before = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json();
    const groupId = before.students.find((row: { studentId: string }) => row.studentId === STUDENT).groupId;
    const members = before.students.filter((row: { groupId: string; status: string }) => row.groupId === groupId && row.status === 'active');
    const result = await admin.call('POST', `/api/v1/admin/ai/tokens/groups/${groupId}`, { op: 'add', amount: 500_000, note: 'Старт модуля' });
    expect(result.json()).toMatchObject({ count: members.length, delta: 500_000 * members.length });
    const after = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json();
    for (const member of members) expect(after.students.find((row: { studentId: string }) => row.studentId === member.studentId).balance).toBe(500_000);
    const journal = (await admin.call('GET', '/api/v1/admin/ai/tokens/ledger')).json().entries;
    expect(new Set(journal.map((entry: { batchId?: string }) => entry.batchId)).size).toBe(1);
    expect(journal).toHaveLength(members.length);
  });

  it('tracks purchased provider resources apart from student allowances', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    const { provider } = await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 900_000 });
    const tokensPackage = await admin.call('POST', '/api/v1/admin/ai/resources/packages', { name: 'Пакет 1M', providerId: provider.id, unit: 'tokens', purchasedAmount: 1_000_000, cost: 20, costCurrency: 'USD', purchasedAt: '2026-10-01' });
    expect(tokensPackage.statusCode).toBe(201);
    await admin.call('POST', '/api/v1/admin/ai/resources/packages', { name: 'Кредити $10', providerId: provider.id, unit: 'money', currency: 'USD', purchasedAmount: 10, cost: 10, purchasedAt: '2026-10-01' });
    const student = await as(STUDENT);
    await student.send('Рахуємо ресурс');
    const resources = (await admin.call('GET', '/api/v1/admin/ai/resources')).json();
    const tokens = resources.packages.find((item: { unit: string }) => item.unit === 'tokens');
    // admin test request (150) + student request (150)
    expect(tokens).toMatchObject({ usedTokens: 300, estimatedRemaining: 999_700, usedBasis: 'tokens', confirmedRemaining: null });
    const money = resources.packages.find((item: { unit: string }) => item.unit === 'money');
    expect(money.usedBasis).toBe('cost');
    expect(money.used).toBeGreaterThanOrEqual(0);
    expect(resources.summary).toMatchObject({ purchasedTokens: 1_000_000, allocatedToStudents: 900_000 - 150 });

    const balance = await admin.call('PATCH', `/api/v1/admin/ai/providers/${provider.id}`, { balanceSource: 'openrouter' });
    expect(balance.statusCode).toBe(200);
    expect((await admin.call('POST', `/api/v1/admin/ai/providers/${provider.id}/balance`)).json()).toMatchObject({ amount: 37.5, currency: 'USD' });
  });

  it('lets a student send a ZIP the model reads, and download the files the model wrote as a ZIP', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 200_000 });
    const student = await as(STUDENT);
    expect((await student.call('GET', '/api/v1/ai/me')).json().limits.attachments).toMatchObject({ enabled: true, maxBytes: 5 * 1024 * 1024 });

    const archive = createZip([
      { path: 'src/app.js', content: "console.log('мій код');\n" },
      { path: 'README.md', content: '# Мій проєкт\n' },
      { path: 'node_modules/big/index.js', content: 'module.exports = 1;\n' },
      { path: 'logo.png', content: 'PNG' }
    ]);
    const reserved = await student.call('POST', '/api/v1/ai/attachments', { name: 'project.zip', size: archive.length });
    expect(reserved.statusCode).toBe(201);
    const { attachment, upload } = reserved.json();
    expect(JSON.stringify(reserved.json())).not.toContain(STUDENT);
    expect((await student.app.inject({ method: upload.method, url: upload.url, headers: upload.headers, payload: archive })).statusCode).toBe(200);
    const completed = await student.call('POST', `/api/v1/ai/attachments/${attachment.id}/complete`);
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'ready', files: [{ path: 'src/app.js' }, { path: 'README.md' }] });
    expect(completed.json().skipped.map((item: { path: string }) => item.path)).toEqual(['node_modules/big/index.js', 'logo.png']);

    // Another student can neither use nor touch it.
    const other = await as(OTHER);
    expect((await other.call('POST', `/api/v1/ai/attachments/${attachment.id}/complete`)).statusCode).toBe(404);
    expect((await other.call('DELETE', `/api/v1/ai/attachments/${attachment.id}`)).statusCode).toBe(404);

    const sent = await student.call('POST', '/api/v1/ai/conversations/new/stream', { content: 'Що робить мій код?', clientRequestId: randomUUID(), attachmentIds: [attachment.id] });
    const done = parseSse(sent.body).find(item => item.event === 'done')!.data;
    expect(done.userMessage.attachments).toEqual([{ id: attachment.id, name: 'project.zip', size: archive.length, fileCount: 2 }]);
    const providerMessage = mock.chatRequests().at(-1)!.body.messages.at(-1).content as string;
    expect(providerMessage).toContain('Що робить мій код?');
    expect(providerMessage).toContain("--- файл: src/app.js ---\nconsole.log('мій код');");
    expect(providerMessage).not.toContain('module.exports');
    expect(mock.chatRequests().at(-1)!.body.messages[0].content).toContain('Інтерфейс сам збере такі блоки в ZIP-архів');
    expect((await student.call('POST', '/api/v1/ai/conversations/new/stream', { content: 'Ще раз', clientRequestId: randomUUID(), attachmentIds: [attachment.id] })).statusCode).toBe(409);
    expect((await student.call('DELETE', `/api/v1/ai/attachments/${attachment.id}`)).statusCode).toBe(409);

    // The follow-up keeps the archive in context and gets an answer with a named code block.
    const reply = await student.send("Готово\n```js src/hello.js\nconsole.log('привіт');\n```", { conversationId: done.conversationId });
    expect(reply.done.message.archive).toEqual({ fileCount: 1, paths: ['src/hello.js'] });
    expect(mock.chatRequests().at(-1)!.body.messages.some((message: { content: string }) => message.content.includes('--- файл: src/app.js ---'))).toBe(true);

    const link = await student.call('POST', `/api/v1/ai/conversations/${done.conversationId}/messages/${reply.done.message.id}/archive`);
    expect(link.json()).toMatchObject({ fileCount: 1 });
    expect(link.json().fileName).toMatch(/\.zip$/);
    const download = await student.app.inject({ method: 'GET', url: link.json().url });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toContain('attachment; filename=');
    expect(download.headers['access-control-allow-origin']).toBe('https://web.telegram.org');
    expect(extractArchiveText(download.rawPayload).files).toEqual([{ path: 'src/hello.js', text: "console.log('привіт');\n" }]);

    const forged = link.json().url.replace(/.{6}$/, 'AAAAAA');
    expect((await student.app.inject({ method: 'GET', url: forged })).statusCode).toBe(403);
    expect((await other.call('POST', `/api/v1/ai/conversations/${done.conversationId}/messages/${reply.done.message.id}/archive`)).statusCode).toBe(404);
    expect((await student.call('POST', `/api/v1/ai/conversations/${done.conversationId}/messages/${done.message.id}/archive`)).statusCode).toBe(404);

    // Deleting the chat removes the archive it carried.
    expect((await student.call('DELETE', `/api/v1/ai/conversations/${done.conversationId}`)).statusCode).toBe(204);
    expect((await student.call('POST', `/api/v1/ai/attachments/${attachment.id}/complete`)).statusCode).toBe(404);
  });

  it('accepts only real ZIP archives with readable text', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    const student = await as(STUDENT);
    expect((await student.call('POST', '/api/v1/ai/attachments', { name: 'virus.exe', size: 100 })).statusCode).toBe(415);
    expect((await student.call('POST', '/api/v1/ai/attachments', { name: 'huge.zip', size: 6 * 1024 * 1024 })).statusCode).toBe(413);
    const upload = async (name: string, bytes: Buffer) => {
      const reserved = (await student.call('POST', '/api/v1/ai/attachments', { name, size: bytes.length })).json();
      await student.app.inject({ method: reserved.upload.method, url: reserved.upload.url, headers: reserved.upload.headers, payload: bytes });
      return { id: reserved.attachment.id as string, complete: await student.call('POST', `/api/v1/ai/attachments/${reserved.attachment.id}/complete`) };
    };
    const fake = await upload('fake.zip', Buffer.from('this is not a zip archive at all'));
    expect(fake.complete.statusCode).toBe(415);
    expect(fake.complete.json().error.code).toBe('AI_ATTACHMENT_INVALID');
    expect((await student.call('POST', `/api/v1/ai/attachments/${fake.id}/complete`)).statusCode).toBe(404);
    const images = await upload('images.zip', createZip([{ path: 'a.png', content: 'x' }]));
    expect(images.complete.statusCode).toBe(422);
    expect(images.complete.json().error.message).toBe('В архіві немає текстових файлів, які може прочитати ШІ.');
    const unsent = await upload('ok.zip', createZip([{ path: 'a.txt', content: 'текст' }]));
    expect(unsent.complete.statusCode).toBe(200);
    expect((await student.call('DELETE', `/api/v1/ai/attachments/${unsent.id}`)).statusCode).toBe(204);
  });

  it('serves the stream route through the standalone fetch handler with the same checks', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    const student = await as(STUDENT);
    const request = (headers: Record<string, string>, body: unknown = { content: 'x', clientRequestId: randomUUID() }) => student.app.aiStreamHandler(new Request('http://localhost/api/v1/ai/conversations/new/stream?conversationId=new', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
    expect((await request({})).response.status).toBe(401);
    expect((await request({ authorization: 'Bearer forged.token.value' })).response.status).toBe(401);
    expect((await request({ authorization: `Bearer ${student.token}`, origin: 'https://evil.example' })).response.status).toBe(403);
    const exhausted = await request({ authorization: `Bearer ${student.token}` });
    expect(exhausted.response.status).toBe(402);
    expect((await exhausted.response.json()).error.code).toBe('AI_LIMIT_EXHAUSTED');
    expect((await request({ authorization: `Bearer ${student.token}` }, { content: 'x' })).response.status).toBe(400);
  });
});
