import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEV_IDS, PILOT_STUDENTS } from './data/seed.js';
import { MockProviderServer } from './ai/testing/mock-provider.js';
import { ADMIN_ID, aiSchool, configureMock, parseSse } from './ai/testing/app-harness.js';
import { MemoryAiStore, RedisAiStore } from './ai/store.js';
import { RedisEmulator } from './ai/testing/redis-emulator.js';
import { probeImage } from './ai/probe-image.js';
import { AiService } from './ai/service.js';
import { SecretBox } from './ai/secret-box.js';
import type { ProviderAdapter } from './ai/adapters.js';
import type { AiProviderRecord } from './ai/types.js';

let mock: MockProviderServer;
const schools: ReturnType<typeof aiSchool>[] = [];
beforeAll(async () => { mock = await new MockProviderServer().start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });
async function ready() {
  const school = aiSchool(); schools.push(school);
  const admin = await school.as(ADMIN_ID);
  const config = await configureMock(admin, mock, 'test-key-1234567890', ['echo-1', 'agent']);
  await admin.call('POST', '/api/v1/admin/ai/tokens/students/' + DEV_IDS.user, { op: 'add', amount: 500000 });
  const student = await school.as(DEV_IDS.user);
  const send = async (content: string, options: Record<string, unknown> = {}, id = 'new') => {
    const response = await student.call('POST', '/api/v1/ai/conversations/' + id + '/stream', { content, clientRequestId: randomUUID(), ...options });
    const events = response.statusCode === 200 ? parseSse(response.body) : [];
    return { response, events, done: events.find(event => event.event === 'done')?.data };
  };
  return { ...school, ...config, admin, student, send };
}

describe('AI improvements over the authenticated API', () => {
  it('waits after a temporary 429, emits queue status, and charges only the successful response', async () => {
    const { send } = await ready(); mock.failNextChats(429);
    const result = await send('Спробуй');
    expect(result.events.some(event => event.event === 'queue' && event.data.waitMs > 0)).toBe(true);
    expect(result.done).toMatchObject({ status: 'complete', usage: { charged: 150 } });
  });

  it('queues answers under the provider limit and charges nothing for one stopped in line', async () => {
    const { admin, student, send, providerId, aiStore } = await ready();
    expect((await admin.call('PATCH', '/api/v1/admin/ai/providers/' + providerId, { rateLimitPerMinute: 1 })).statusCode).toBe(200);
    const first = await send('Перше');
    expect(first.done.status).toBe('complete');
    // The second answer waits for the next slot; «Стоп» ends it before the provider is asked.
    const second = send('Друге');
    let jobId: string | undefined;
    for (let i = 0; i < 100 && !jobId; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      jobId = (await aiStore.listActiveJobs())[0]?.jobId;
    }
    expect(jobId).toBeTruthy();
    for (let i = 0; i < 100; i += 1) {
      if ((await aiStore.getJob(jobId!))?.queuedUntil) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect((await student.call('GET', '/api/v1/ai/jobs/' + jobId + '?from=0')).json().queuedUntil).toBeTruthy();
    const requestsBefore = mock.chatRequests().length;
    expect((await student.call('POST', '/api/v1/ai/jobs/' + jobId + '/stop')).statusCode).toBe(200);
    const stopped = await second;
    expect(stopped.events.some(event => event.event === 'queue' && event.data.waitMs > 0)).toBe(true);
    expect(stopped.done).toMatchObject({ status: 'stopped', usage: { charged: 0 } });
    expect(mock.chatRequests().length).toBe(requestsBefore);
  });

  it('routes agent requests to the configured agent model while respecting an explicit choice', async () => {
    const { admin, ids, send } = await ready();
    await admin.call('PATCH', '/api/v1/admin/ai/models/' + ids['echo-1'], { agent: false });
    expect((await admin.call('PUT', '/api/v1/admin/ai/settings', { agentModelId: ids.agent })).statusCode).toBe(200);
    expect((await send('Поясни', { mode: 'agent' })).done.message.modelId).toBe(ids.agent);
    expect((await send('Поясни', { mode: 'agent', modelId: ids['echo-1'] })).response.statusCode).toBe(400);
  });

  it('checks actual tool invocation and records a failed vision probe without exposing keys', async () => {
    const { admin, ids } = await ready();
    const result = await admin.call('POST', '/api/v1/admin/ai/models/' + ids.agent + '/probe');
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ tools: true, vision: false });
    expect(result.body).not.toContain('test-key-1234567890');
  });

  it('uploads a real photo, rejects a text-only model, then sends image parts and restores them on follow-up', async () => {
    const { student, admin, ids, send } = await ready();
    const uploaded = await student.attach('сторінка.png', Buffer.from(probeImage(), 'base64'));
    expect(uploaded.completed?.statusCode).toBe(200);
    const attachmentIds = [uploaded.completed!.json().id];
    expect((await send('Прочитай', { attachmentIds })).response.json().error.code).toBe('AI_VISION_REQUIRED');
    await admin.call('PATCH', '/api/v1/admin/ai/models/' + ids['echo-1'], { vision: true });
    const result = await send('Прочитай', { attachmentIds });
    expect(result.done.status).toBe('complete');
    expect(mock.chatRequests().at(-1)!.body.messages.at(-1).content[0]).toMatchObject({ type: 'image_url' });
    const followup = await send('Поясни ще раз', {}, result.done.conversationId);
    expect(followup.done.status).toBe('complete');
    expect(mock.chatRequests().at(-1)!.body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url'))).toBe(true);
    expect((await send('Повторне вкладення', { attachmentIds })).response.statusCode).toBe(409);
  });

  it('rejects disguised images and oversized uploads', async () => {
    const { student } = await ready();
    expect((await student.attach('fake.png', Buffer.from('not an image'))).completed?.statusCode).toBe(415);
    expect((await student.call('POST', '/api/v1/ai/attachments', { name: 'huge.jpg', size: 140000 })).statusCode).toBe(413);
  });

  it('revises the last exchange only after success, reuses its attachment, and rejects stale edits', async () => {
    const { student, send, aiStore } = await ready();
    const file = await student.attach('нотатки.txt', Buffer.from('Важлива умова'));
    const first = await send('Перше питання', { attachmentIds: [file.completed!.json().id] });
    const id = first.done.conversationId;
    const reviseMessageId = first.done.userMessage.id;
    mock.failNextChats(400);
    expect((await send('Невдала зміна', { reviseMessageId }, id)).done).toBeUndefined();
    expect((await student.call('GET', '/api/v1/ai/conversations/' + id)).json().messages).toHaveLength(2);
    const revised = await send('Нове питання', { reviseMessageId }, id);
    expect(revised.done.status).toBe('complete');
    const visible = (await student.call('GET', '/api/v1/ai/conversations/' + id)).json().messages;
    expect(visible).toHaveLength(2);
    expect(visible[0].content).toBe('Нове питання');
    expect(await aiStore.getMessages(id, 20)).toHaveLength(4);
    expect((await send('Застаріла правка', { reviseMessageId }, id)).response.statusCode).toBe(409);
  });

  it('persists changeable feedback, summarizes by model and skill, and prevents cross-student access', async () => {
    const { student, admin, as, send } = await ready();
    const result = await send('Поясни', { skillId: 'skill-summary' });
    const id = result.done.conversationId, messageId = result.done.message.id;
    const url = '/api/v1/ai/conversations/' + id + '/messages/' + messageId + '/feedback';
    expect((await student.call('PUT', url, { value: 'up' })).statusCode).toBe(200);
    expect((await student.call('PUT', url, { value: 'down' })).statusCode).toBe(200);
    expect((await admin.call('GET', '/api/v1/admin/ai/feedback')).json().rows[0]).toMatchObject({ up: 0, down: 1, skillId: 'skill-summary' });
    expect((await student.call('GET', '/api/v1/ai/conversations/' + id)).json().messages[1].feedback).toBe('down');
    const other = await as(PILOT_STUDENTS[1]!.id);
    expect((await other.call('PUT', url, { value: 'up' })).statusCode).toBe(404);
    await student.call('PUT', url, { value: null });
    expect((await admin.call('GET', '/api/v1/admin/ai/feedback')).json().rows).toHaveLength(0);
  });

  it('summarizes older turns, includes that memory later, and accounts for the extra model call', async () => {
    const { send, aiStore } = await ready();
    const first = await send('Мій проєкт — навчальний бот');
    const id = first.done.conversationId;
    await aiStore.appendMessages(id, Array.from({ length: 14 }, (_, i) => ({ id: randomUUID(), role: i % 2 ? 'assistant' as const : 'user' as const, content: 'Крок ' + i, createdAt: new Date().toISOString() })), 200);
    const result = await send('Наступний крок', {}, id);
    expect(result.done.usage.charged).toBe(300);
    expect((await aiStore.getConversation(DEV_IDS.user, id))?.memory?.text).toBeTruthy();
    await send('Що ми обговорювали?', {}, id);
    expect(mock.chatRequests().at(-1)!.body.messages[0].content).toContain('Стислий виклад попередньої розмови');
  });

  it('loads homework instructions server-side and refuses inaccessible context', async () => {
    const { student, send } = await ready();
    const homework = (await student.call('GET', '/api/v1/homework')).json()[0];
    expect(homework).toBeTruthy();
    const result = await send('Допоможи', { context: { type: 'homework', id: homework.id } });
    expect(result.done.status).toBe('complete');
    const prompt = mock.chatRequests().at(-1)!.body.messages[0].content;
    expect(prompt).toContain('Режим підказок'); expect(prompt).toContain(homework.title);
    expect((await send('Чужий урок', { context: { type: 'lesson', id: randomUUID() } })).response.statusCode).toBe(404);
    expect((await send('Інший контекст', { context: { type: 'homework', id: randomUUID() } }, result.done.conversationId)).response.statusCode).toBe(409);
  });
});

describe.each(['memory', 'redis'])('provider pacing in %s storage', kind => {
  it('shares slots between requests, isolates providers, and releases capacity with time', async () => {
    const store = kind === 'memory' ? new MemoryAiStore() : new RedisAiStore(new RedisEmulator(), 'pacing-test');
    const now = 600000;
    expect(await store.acquireRateSlot('one', 2, now)).toBe(0);
    expect(await store.acquireRateSlot('one', 2, now)).toBe(0);
    expect(await store.acquireRateSlot('one', 2, now)).toBeGreaterThan(0);
    expect(await store.acquireRateSlot('two', 2, now)).toBe(0);
    expect(await store.acquireRateSlot('one', 2, now + 90000)).toBe(0);
  });

  it('keeps the sliding minute right with real millisecond timestamps', async () => {
    // Real clocks are far past 2^31 ms; the window must not overflow in either store.
    const store = kind === 'memory' ? new MemoryAiStore() : new RedisAiStore(new RedisEmulator(), 'pacing-real');
    const now = Date.UTC(2026, 9, 14, 12, 30, 20);
    expect(await store.acquireRateSlot('nvidia', 2, now)).toBe(0);
    expect(await store.acquireRateSlot('nvidia', 2, now + 1_000)).toBe(0);
    expect(await store.acquireRateSlot('nvidia', 2, now + 2_000)).toBe(38_000);
    expect(await store.acquireRateSlot('nvidia', 2, now + 70_000)).toBe(0);
    expect(await store.acquireRateSlot('nvidia', 2, now + 71_000)).toBeGreaterThan(20_000);
  });
});

describe('a model call under the provider limit', () => {
  it('waits in line, reports the wait, then streams the answer', async () => {
    const store = new MemoryAiStore();
    const waits = [400, 0];
    store.acquireRateSlot = async () => waits.shift() ?? 0;
    const adapter: ProviderAdapter = {
      listModels: async () => [],
      balance: async () => null,
      async *stream() { yield { type: 'text', text: 'Готово' }; yield { type: 'finish', reason: 'stop' }; }
    };
    const ai = new AiService({ store, secrets: SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: 'pepper-for-tests', NODE_ENV: 'development' }), roster: async () => ({ students: [], groups: [] }), adapterFactory: () => adapter });
    const secret = ai.deps.secrets.seal('test-key-1234567890');
    const provider = { id: 'p', name: 'NVIDIA', protocol: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', enabled: true, balanceSource: 'none', lastCheck: null, syncedBalance: null, createdAt: '', updatedAt: '', headers: [], keys: [{ id: 'k', label: 'k', secret, hint: '', enabled: true, createdAt: '', lastUsedAt: null, lastError: null }] } as unknown as AiProviderRecord;
    const queue: Array<number | null> = [];
    const text: string[] = [];
    const started = Date.now();
    for await (const event of ai.streamPaced(provider, 'k', { model: 'm', messages: [{ role: 'user', content: 'Привіт' }], maxOutputTokens: 16, signal: new AbortController().signal }, wait => queue.push(wait))) {
      if (event.type === 'text') text.push(event.text);
    }
    expect(queue).toEqual([400, null]);
    expect(text.join('')).toBe('Готово');
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('gives up with a clear message when the line is longer than the wait allows', async () => {
    const store = new MemoryAiStore();
    store.acquireRateSlot = async () => 120_000;
    const ai = new AiService({ store, secrets: SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: 'pepper-for-tests', NODE_ENV: 'development' }), roster: async () => ({ students: [], groups: [] }) });
    const provider = { id: 'p', baseUrl: 'https://integrate.api.nvidia.com/v1', rateLimitPerMinute: 35, keys: [] } as unknown as AiProviderRecord;
    const run = async () => { for await (const _ of ai.streamPaced(provider, 'k', { model: 'm', messages: [], maxOutputTokens: 16, signal: new AbortController().signal })) { /* nothing */ } };
    await expect(run()).rejects.toMatchObject({ code: 'rate_limit', message: expect.stringContaining('Забагато запитів') });
  });
});
