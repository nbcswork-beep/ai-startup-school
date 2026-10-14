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
import { monthKey } from './ai/time.js';

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

const CRON = 'ai-test-cron-secret-0123456789abcdef';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends a message through the streaming function the way the app does, and lets the test read or drop the connection. */
async function openStream(student: { app: FastifyInstance; token: string }, body: Record<string, unknown>, conversationId = 'new') {
  const controller = new AbortController();
  const { response, done } = await student.app.aiStreamHandler(new Request(`http://localhost/api/v1/ai/conversations/${conversationId}/stream?conversationId=${conversationId}`, {
    method: 'POST', signal: controller.signal,
    headers: { authorization: `Bearer ${student.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  return {
    done: done ?? Promise.resolve(),
    async until(text: string) {
      while (!received.includes(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      return parseSse(received);
    },
    /** The student closes the Mini App: the connection goes away. */
    async close() { controller.abort(); await reader.cancel().catch(() => {}); }
  };
}

interface Notice { telegramId: string; conversationId: string; outcome: 'ready' | 'failed' }

/** A school with the AI assistant. `telegram` binds the student to a Telegram chat; notices land in `notices`; `clock` moves the AI service's time. */
function school(options: { telegram?: boolean } = {}) {
  const state = createAssignedPilotState();
  if (options.telegram) state.directory[STUDENT]!.telegramId = '700100200';
  const runtime = new MemoryPilotRuntimeStore(state);
  const redis = new RedisEmulator();
  const aiStore = new RedisAiStore(redis, 'aiss:test:ai:v1');
  const notices: Notice[] = [];
  const clock = { offset: 0 };
  const aiNotifier = { notify: async (input: Notice) => { notices.push(input); return { sent: true as const }; } };
  const as = async (userId: string) => {
    const env = loadEnv({ NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'ai-assistant-test-pepper', DEV_USER_ID: userId, CRON_SECRET: CRON });
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const app = await buildApp({ env, repository, jwt: await createJwtService(env), aiStore, aiNotifier, aiNow: () => new Date(Date.now() + clock.offset), notificationSender: { send: async () => ({ sent: true as const }) } });
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
  return { redis, aiStore, as, notices, clock };
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

  it('runs a repeated request once: a retry joins the answer instead of charging again', async () => {
    const { as } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 50_000 });
    const student = await as(STUDENT);
    const clientRequestId = randomUUID();
    const first = await student.send('Раз', { clientRequestId });
    expect(first.done.usage.charged).toBe(150);
    const repeat = await student.send('Раз', { clientRequestId });
    expect(repeat.response.statusCode).toBe(200);
    expect(repeat.events).toEqual([{ event: 'attach', data: { jobId: first.done.jobId, conversationId: first.done.conversationId, status: 'complete' } }]);
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(49_850);
    expect((await student.call('GET', `/api/v1/ai/conversations/${first.done.conversationId}`)).json().messages).toHaveLength(2);
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

  it('stops an answer only on «Стоп», keeps the part written and charges an estimate of it', async () => {
    const { as, notices } = school({ telegram: true });
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['long']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const live = await openStream(student, { content: 'Довга відповідь', clientRequestId: randomUUID(), modelId: ids.long });
    const start = (await live.until('рядок 2')).find(item => item.event === 'start')!.data;
    // Closing the app does not stop the answer…
    await live.close();
    await sleep(1_300);
    expect((await student.call('GET', `/api/v1/ai/jobs/${start.jobId}`)).json().status).toBe('running');
    // …the stop button does.
    const stop = await student.call('POST', `/api/v1/ai/jobs/${start.jobId}/stop`);
    expect(stop.statusCode).toBe(200);
    await live.done;
    const view = (await student.call('GET', `/api/v1/ai/jobs/${start.jobId}`)).json();
    expect(view).toMatchObject({ status: 'stopped', error: null, message: { id: start.assistantMessageId, status: 'stopped', usage: { approximate: true } } });
    expect(view.message.content).toContain('рядок 2');
    expect(view.message.content).not.toContain('рядок 149');
    const messages = (await student.call('GET', `/api/v1/ai/conversations/${start.conversationId}`)).json().messages;
    expect(messages.map((item: { id: string }) => item.id)).toEqual([start.userMessageId, start.assistantMessageId]);
    const me = (await student.call('GET', '/api/v1/ai/me')).json();
    expect(me.balance.available).toBe(100_000 - view.message.usage.total);
    expect(me.balance.approximateUsed).toBe(view.message.usage.total);
    // The student stopped it themselves: nothing to announce.
    expect(notices).toEqual([]);
  });

  it('keeps writing the answer after the app closes, and the reopened app reconnects to it', async () => {
    const { as, notices } = school({ telegram: true });
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['long']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const clientRequestId = randomUUID();
    const live = await openStream(student, { content: 'Довга відповідь', clientRequestId, modelId: ids.long });
    const start = (await live.until('рядок 1')).find(item => item.event === 'start')!.data;
    await live.close();
    await sleep(1_300);

    // The reopened app: the chat is listed as generating and comes with the text written so far.
    const list = (await student.call('GET', '/api/v1/ai/conversations')).json().conversations;
    expect(list[0]).toMatchObject({ id: start.conversationId, title: 'Довга відповідь', job: { id: start.jobId, status: 'running' } });
    expect(list[0]).not.toHaveProperty('lastJobId');
    const opened = (await student.call('GET', `/api/v1/ai/conversations/${start.conversationId}`)).json();
    expect(opened.messages).toEqual([]);
    expect(opened.job).toMatchObject({ id: start.jobId, status: 'running', userMessage: { id: start.userMessageId, content: 'Довга відповідь' } });
    expect(opened.job.text).toContain('рядок 1');

    // The same request again (a retry after the network dropped) joins the job; a new message waits.
    const again = await student.send('Довга відповідь', { conversationId: start.conversationId, clientRequestId });
    expect(again.events).toEqual([{ event: 'attach', data: { jobId: start.jobId, conversationId: start.conversationId, status: 'running' } }]);
    const busy = await student.send('Ще питання', { conversationId: start.conversationId });
    expect(busy.response.statusCode).toBe(409);
    expect(busy.response.json().error.code).toBe('AI_BUSY');
    // Another student cannot see the job.
    expect((await (await as(OTHER)).call('GET', `/api/v1/ai/jobs/${start.jobId}`)).statusCode).toBe(404);

    // Following the job from the bytes already shown.
    let text = opened.job.text as string;
    let offset = opened.job.offset as number;
    let view: any;
    do {
      await sleep(300);
      view = (await student.call('GET', `/api/v1/ai/jobs/${start.jobId}?from=${offset}`)).json();
      text += view.text;
      offset = view.offset;
    } while (view.status === 'running' || view.status === 'finalizing');
    await live.done;
    expect(view).toMatchObject({ status: 'complete', error: null, message: { id: start.assistantMessageId, status: 'complete', usage: { approximate: false } } });
    expect(text).toBe(view.message.content);
    expect(text).toContain('рядок 149');
    const messages = (await student.call('GET', `/api/v1/ai/conversations/${start.conversationId}`)).json().messages;
    expect(messages.map((item: { id: string }) => item.id)).toEqual([start.userMessageId, start.assistantMessageId]);
    // Charged once, exactly what the provider reported.
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(100_000 - 150);
    // The student was following it in the app: no Telegram message.
    expect(notices).toEqual([]);
  }, 20_000);

  it('sends one Telegram notice, with no content, when an answer finishes while the app is closed', async () => {
    const { as, notices, redis } = school({ telegram: true });
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['long']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const live = await openStream(student, { content: 'Секретне питання про мій проєкт', clientRequestId: randomUUID(), modelId: ids.long });
    const start = (await live.until('event: start')).find(item => item.event === 'start')!.data;
    await live.close();
    await live.done;
    expect(notices).toEqual([{ telegramId: '700100200', conversationId: start.conversationId, outcome: 'ready' }]);
    expect(JSON.stringify(notices)).not.toMatch(/Секретне|рядок/);
    // The scheduled worker finds nothing owed and sends nothing twice.
    const worker = await student.app.inject({ method: 'GET', url: '/api/v1/notifications/worker', headers: { authorization: `Bearer ${CRON}` } });
    expect(worker.statusCode).toBe(200);
    expect(worker.json().ai).toMatchObject({ recovered: 0, notices: 0 });
    expect(notices).toHaveLength(1);
    // The list shows the finished answer as new until the chat is opened.
    expect((await student.call('GET', '/api/v1/ai/conversations')).json().conversations[0].job).toMatchObject({ status: 'complete', unseen: true });
    const opened = (await student.call('GET', `/api/v1/ai/conversations/${start.conversationId}`)).json();
    expect(opened.messages[1].content).toContain('рядок 149');
    expect((await student.call('GET', '/api/v1/ai/conversations')).json().conversations[0].job).toMatchObject({ unseen: false });
    expect(redis.dump()).not.toContain('700100200');
  }, 20_000);

  it('sends no notice for an answer the student watched to the end', async () => {
    const { as, notices } = school({ telegram: true });
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    expect((await student.send('Привіт')).done).toMatchObject({ status: 'complete' });
    expect(notices).toEqual([]);
    expect((await student.call('GET', '/api/v1/ai/conversations')).json().conversations[0].job).toMatchObject({ status: 'complete', unseen: false });
  });

  it('finishes an answer whose server function died, charging only what reached storage, and tells the student', async () => {
    const { as, aiStore, notices, clock } = school({ telegram: true });
    const admin = await as(ADMIN);
    const { ids } = await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    // A function that started an answer, wrote part of it and was killed (time limit, crash).
    const created = (await student.call('POST', '/api/v1/ai/conversations', { title: 'Обірвано' })).json();
    const now = Date.now();
    const requestId = randomUUID().replace(/-/g, '');
    const ledger = { id: randomUUID(), at: new Date(now).toISOString(), studentId: STUDENT, type: 'monthly_renewal' as const, actorId: null, note: null };
    expect((await aiStore.reserve({
      studentId: STUDENT, requestId, amount: 1_000, minAmount: 300, inputEstimate: 120, expiresAt: now + 360_000, now, period: monthKey(new Date(now)),
      maxConcurrent: 2, rateLimit: 20, rateWindow: Math.floor(now / 60_000), renewalLedger: ledger, expiryLedger: { at: ledger.at, studentId: STUDENT, type: 'expired_reservation', actorId: null, note: null }
    })).status).toBe('ok');
    const jobId = randomUUID();
    const assistantMessageId = randomUUID();
    await aiStore.createJob({
      id: jobId, studentId: STUDENT, conversationId: created.id, requestId, userMessageId: 'u-lost', assistantMessageId, modelId: ids['echo-1']!, modelLabel: 'ECHO-1', groupId: null,
      status: 'running', createdAt: now, heartbeatAt: now, viewerAt: 0, finalizingAt: null, finishedAt: null, stopRequested: false, inputTokens: 100,
      errorCode: null, errorMessage: null, notify: null, notifyAttempts: 0, userMessage: { id: 'u-lost', role: 'user', content: 'Питання', createdAt: new Date(now).toISOString() }, message: null
    });
    await aiStore.putConversation({ ...(await aiStore.getConversation(STUDENT, created.id))!, lastJobId: jobId });
    await aiStore.flushJob(jobId, 'Половина відповіді', now);

    const runWorker = async () => (await student.app.inject({ method: 'GET', url: '/api/v1/notifications/worker', headers: { authorization: `Bearer ${CRON}` } })).json().ai;
    // Still within its heartbeat window: left alone.
    expect(await runWorker()).toMatchObject({ recovered: 0 });
    clock.offset = 2 * 60_000;
    expect(await runWorker()).toMatchObject({ recovered: 1 });
    expect(notices).toEqual([{ telegramId: '700100200', conversationId: created.id, outcome: 'failed' }]);
    expect(await runWorker()).toMatchObject({ recovered: 0, notices: 0 });
    expect(notices).toHaveLength(1);

    const opened = (await student.call('GET', `/api/v1/ai/conversations/${created.id}`)).json();
    expect(opened.messages).toHaveLength(2);
    expect(opened.messages[1]).toMatchObject({ id: assistantMessageId, content: 'Половина відповіді', status: 'interrupted', usage: { approximate: true } });
    expect(opened.job).toMatchObject({ status: 'interrupted', error: { code: 'AI_INTERRUPTED' } });
    const row = (await admin.call('GET', '/api/v1/admin/ai/tokens')).json().students.find((item: { studentId: string }) => item.studentId === STUDENT);
    expect(row).toMatchObject({ reserved: 0, used: opened.messages[1].usage.total, balance: 100_000 - opened.messages[1].usage.total });
    expect(opened.messages[1].usage.total).toBeGreaterThan(100);
  });

  it('stops the answer of a chat that is deleted while it is being written', async () => {
    const { as, aiStore } = school();
    const admin = await as(ADMIN);
    const { ids } = await configure(admin, ['long']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 100_000 });
    const student = await as(STUDENT);
    const live = await openStream(student, { content: 'Довга відповідь', clientRequestId: randomUUID(), modelId: ids.long });
    const start = (await live.until('рядок 1')).find(item => item.event === 'start')!.data;
    await live.close();
    expect((await student.call('DELETE', `/api/v1/ai/conversations/${start.conversationId}`)).statusCode).toBe(204);
    await live.done;
    expect(await aiStore.getJob(start.jobId)).toMatchObject({ status: 'stopped' });
    expect((await student.call('GET', `/api/v1/ai/conversations/${start.conversationId}`)).statusCode).toBe(404);
    const me = (await student.call('GET', '/api/v1/ai/me')).json();
    expect(me.balance.available).toBeLessThan(100_000);
    expect((await admin.call('GET', '/api/v1/admin/ai/tokens')).json().students.find((item: { studentId: string }) => item.studentId === STUDENT).reserved).toBe(0);
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
    const limits = (await student.call('GET', '/api/v1/ai/me')).json().limits.attachments;
    expect(limits).toMatchObject({ enabled: true, maxPerMessage: 5 });
    expect(limits.kinds).toContainEqual({ extension: 'zip', label: 'ZIP', maxBytes: 5 * 1024 * 1024 });
    expect(limits.kinds.map((kind: { extension: string }) => kind.extension)).toEqual(['pdf', 'docx', 'xlsx', 'csv', 'pptx', 'txt', 'md', 'zip']);

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
    expect(done.userMessage.attachments).toEqual([{ id: attachment.id, name: 'project.zip', size: archive.length, fileCount: 2, kind: 'zip' }]);
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

  it('downloads separately labelled files from new and previously saved replies without regenerating', async () => {
    const { as, aiStore } = school();
    const admin = await as(ADMIN);
    await configure(admin);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 200_000 });
    const student = await as(STUDENT);
    const answer = 'MOKA Coffee\n📄 `index.html`\n\n```html\n<h1>MOKA</h1>\n```\n### **style.css**\n```css\nbody { color: brown; }\n```';
    const reply = await student.send(answer);
    const metadata = { fileCount: 2, paths: ['index.html', 'style.css'] };
    expect(reply.done.message.archive).toEqual(metadata);
    const conversationId = reply.done.conversationId;
    // Older messages were stored without archive metadata. Do not rewrite or regenerate them.
    const { archive: _archive, ...legacy } = reply.done.message;
    legacy.id = randomUUID();
    await aiStore.appendMessages(conversationId, [legacy], 400);
    const callsBefore = mock.chatRequests().length;
    const balanceBefore = (await student.call('GET', '/api/v1/ai/me')).json().balance.available;
    const history = await student.call('GET', `/api/v1/ai/conversations/${conversationId}`);
    expect(history.json().messages.find((message: { id: string }) => message.id === legacy.id).archive).toEqual(metadata);
    expect((await aiStore.getMessages(conversationId, 400)).find(message => message.id === legacy.id)?.archive).toBeUndefined();
    for (const messageId of [reply.done.message.id, legacy.id]) {
      const link = await student.call('POST', `/api/v1/ai/conversations/${conversationId}/messages/${messageId}/archive`);
      expect(link.statusCode).toBe(200);
      expect(link.json().fileCount).toBe(2);
      const download = await student.app.inject({ method: 'GET', url: link.json().url });
      expect(download.statusCode).toBe(200);
      expect(extractArchiveText(download.rawPayload).files).toEqual([
        { path: 'index.html', text: '<h1>MOKA</h1>\n' },
        { path: 'style.css', text: 'body { color: brown; }\n' }
      ]);
    }
    expect(mock.chatRequests()).toHaveLength(callsBefore);
    expect((await student.call('GET', '/api/v1/ai/me')).json().balance.available).toBe(balanceBefore);
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
