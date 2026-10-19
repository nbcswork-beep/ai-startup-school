import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from './ai/secret-box.js';
import { ADMIN_ID, aiSchool, configureMock } from './ai/testing/app-harness.js';
import { MockProviderServer } from './ai/testing/mock-provider.js';
import type { AiProviderRecord } from './ai/types.js';

/**
 * Moving provider secrets to AI_SECRETS_KEY_NEXT without re-entering them, against the real Lua
 * scripts. «Old deployment» is the code before this change: one key, main copies only.
 */

const KEY = 'test-key-1234567890';
const HEADER_VALUE = 'team-header-value-0042';
const PLUGIN_SECRET = 'dict-secret-0042';
const PEPPER = 'ai-agent-test-pepper';
const NEXT_KEY = Buffer.alloc(32, 41).toString('base64');
const NEXT_ENV = { AI_SECRETS_KEY_NEXT: NEXT_KEY };

let mock: MockProviderServer;
const schools: Array<ReturnType<typeof aiSchool>> = [];
beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

/** The keys an older deployment has (pepper only) and the key a worker has (the new one only). */
const oldDeployment = SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: PEPPER, NODE_ENV: 'production' });
const worker = SecretBox.fromEnv({ AI_SECRETS_KEY: NEXT_KEY, NODE_ENV: 'production' });

/** A school whose secrets were all written by the current production (before the new key existed). */
async function legacySchool() {
  const school = aiSchool(); schools.push(school);
  const before = await school.as(ADMIN_ID);
  const { providerId, ids } = await configureMock(before, mock, KEY, ['echo-1']);
  expect((await before.call('PATCH', `/api/v1/admin/ai/providers/${providerId}`, { headers: [{ name: 'X-Team', value: HEADER_VALUE }] })).statusCode).toBe(200);
  const manifest = {
    id: 'dictionary', name: 'Довідник', version: '1.0.0', description: 'Шкільний словник термінів', permissions: ['network'], baseUrl: `${mock.anthropicBaseUrl}/dictionary`,
    secrets: [{ key: 'apiKey', label: 'API-ключ', header: 'X-Api-Key' }],
    tools: [{ name: 'lookup_term', description: 'Знайти визначення терміна', parameters: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'] }, http: { method: 'GET', path: '/lookup' } }]
  };
  expect((await before.call('POST', '/api/v1/admin/ai/plugins/import', { manifest })).statusCode).toBe(201);
  expect((await before.call('PATCH', '/api/v1/admin/ai/plugins/dictionary', { secrets: { apiKey: PLUGIN_SECRET } })).statusCode).toBe(200);
  // The same school after a deploy that has AI_SECRETS_KEY_NEXT.
  const after = await school.as(ADMIN_ID, NEXT_ENV);
  return { school, before, after, providerId, ids };
}

const provider = async (school: ReturnType<typeof aiSchool>, id: string) => (await school.aiStore.listProviders()).find(item => item.id === id)!;

describe('moving secrets to the new key', () => {
  it('gives every secret a copy under the new key without re-entry; the old deployment and the worker both read them', async () => {
    const { school, before, after, providerId, ids } = await legacySchool();
    const status = (await after.call('GET', '/api/v1/admin/ai/secrets/status')).json();
    expect(status).toMatchObject({ nextConfigured: true, total: 3, ready: 0, unreadable: 0, readyForWorkers: false });
    expect(status.keys.next).toMatch(/^[0-9a-f]{12}$/);

    const prepared = (await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json();
    expect(prepared).toMatchObject({ total: 3, ready: 3, unreadable: 0, readyForWorkers: true, updated: 2, skipped: 0 });
    // Running it again changes nothing.
    expect((await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json()).toMatchObject({ updated: 0, ready: 3 });

    const record = await provider(school, providerId);
    const plugin = (await school.aiStore.listPlugins()).find(item => item.id === 'dictionary')!;
    // The old deployment knows only the main copies, and they are untouched: it reads everything.
    expect(oldDeployment.open(record.keys[0]!.secret)).toBe(KEY);
    expect(oldDeployment.open(record.headers[0]!.secret)).toBe(HEADER_VALUE);
    expect(oldDeployment.open(plugin.secrets.apiKey!)).toBe(PLUGIN_SECRET);
    // …and a real request through it still works after the move.
    expect((await before.call('POST', `/api/v1/admin/ai/models/${ids['echo-1']}/test`, {})).json()).toMatchObject({ ok: true });
    // The worker has no pepper: it cannot open main copies, only the new ones.
    expect(() => worker.open(record.keys[0]!.secret)).toThrow();
    // Why the new key is AI_SECRETS_KEY_NEXT on Vercel: old code given it as AI_SECRETS_KEY (no pepper fallback
    // there) would be exactly this box, and would lose every main copy.
    const oldCodeWithRenamedKey = SecretBox.fromEnv({ AI_SECRETS_KEY: NEXT_KEY, NODE_ENV: 'production' });
    expect(() => oldCodeWithRenamedKey.open(record.headers[0]!.secret)).toThrow();
    expect(worker.openStored(record.keys[0]!.secret, record.keys[0]!.secretNext)).toBe(KEY);
    expect(worker.openStored(record.headers[0]!.secret, record.headers[0]!.secretNext)).toBe(HEADER_VALUE);
    expect(worker.openStored(plugin.secrets.apiKey!, plugin.secretsNext?.apiKey)).toBe(PLUGIN_SECRET);
    // Neither copy, nor any value, leaves the server.
    const admin = JSON.stringify([(await after.call('GET', '/api/v1/admin/ai/providers')).json(), (await after.call('GET', '/api/v1/admin/ai/agent')).json(), prepared]);
    for (const value of [KEY, HEADER_VALUE, PLUGIN_SECRET, record.keys[0]!.secret.data, record.keys[0]!.secretNext!.data]) expect(admin).not.toContain(value);
  }, 30_000);

  it('a move cut off half-way is safe: everything still reads, workers wait, a second run finishes it', async () => {
    const { school, after, providerId } = await legacySchool();
    const store = school.aiStore;
    const original = store.replaceRecordIf.bind(store);
    store.replaceRecordIf = async (kind, id, expected, next) => {
      if (kind === 'plugins') throw new Error('connection reset');
      return original(kind, id, expected, next);
    };
    try {
      expect((await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).statusCode).toBe(500);
    } finally {
      store.replaceRecordIf = original;
    }
    const half = (await after.call('GET', '/api/v1/admin/ai/secrets/status')).json();
    expect(half).toMatchObject({ total: 3, ready: 2, unreadable: 0, readyForWorkers: false });
    expect(half.pending).toEqual(['Плагін dictionary: apiKey']);
    expect(oldDeployment.open((await provider(school, providerId)).keys[0]!.secret)).toBe(KEY);
    expect((await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json()).toMatchObject({ ready: 3, readyForWorkers: true });
  }, 30_000);

  it('a secret changed later by an older deployment is not read from its stale copy; workers wait until it is prepared again', async () => {
    const { school, after, providerId } = await legacySchool();
    await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next');
    // An older deployment replaces the header the way it always did: a new main copy, the second one left as it was.
    const record = await provider(school, providerId);
    const changed: AiProviderRecord = { ...record, headers: [{ ...record.headers[0]!, secret: oldDeployment.seal('rotated-header-value') }] };
    await school.aiStore.putProvider(changed);
    const box = SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: PEPPER, AI_SECRETS_KEY_NEXT: NEXT_KEY, NODE_ENV: 'production' });
    expect(box.openStored(changed.headers[0]!.secret, changed.headers[0]!.secretNext)).toBe('rotated-header-value');
    expect(() => worker.openStored(changed.headers[0]!.secret, changed.headers[0]!.secretNext)).toThrow();
    const status = (await after.call('GET', '/api/v1/admin/ai/secrets/status')).json();
    expect(status).toMatchObject({ ready: 2, readyForWorkers: false });
    await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next');
    const fresh = await provider(school, providerId);
    expect(worker.openStored(fresh.headers[0]!.secret, fresh.headers[0]!.secretNext)).toBe('rotated-header-value');
  }, 30_000);

  it('an admin edit made while the move runs wins; that record is moved on the next run', async () => {
    const { school, after, providerId } = await legacySchool();
    const store = school.aiStore;
    const list = store.listProviders.bind(store);
    let edited = false;
    store.listProviders = async () => {
      const providers = await list();
      if (!edited) { edited = true; await store.putProvider({ ...providers[0]!, name: 'Перейменовано' }); }
      return providers;
    };
    const first = (await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json();
    store.listProviders = list;
    expect(first.skipped).toBe(1);
    expect((await provider(school, providerId)).name).toBe('Перейменовано');
    expect((await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json()).toMatchObject({ readyForWorkers: true });
    expect((await provider(school, providerId)).name).toBe('Перейменовано');
  }, 30_000);

  it('new secrets entered after the switch get both copies at once', async () => {
    const school = aiSchool({ secretsNext: NEXT_KEY }); schools.push(school);
    const admin = await school.as(ADMIN_ID);
    const { providerId } = await configureMock(admin, mock, KEY, ['echo-1']);
    expect((await admin.call('GET', '/api/v1/admin/ai/secrets/status')).json()).toMatchObject({ total: 1, ready: 1, readyForWorkers: true });
    const record = await provider(school, providerId);
    expect(oldDeployment.open(record.keys[0]!.secret)).toBe(KEY);
    expect(worker.openStored(record.keys[0]!.secret, record.keys[0]!.secretNext)).toBe(KEY);
  }, 30_000);

  it('without the new key nothing changes and the move refuses to run', async () => {
    const school = aiSchool(); schools.push(school);
    const admin = await school.as(ADMIN_ID);
    await configureMock(admin, mock, KEY, ['echo-1']);
    expect((await admin.call('GET', '/api/v1/admin/ai/secrets/status')).json()).toMatchObject({ nextConfigured: false, readyForWorkers: false });
    expect((await admin.call('POST', '/api/v1/admin/ai/secrets/prepare-next')).json().error.code).toBe('AI_SECRETS_NEXT_MISSING');
  }, 30_000);
});

describe('workers wait for the keys', () => {
  it('agent answers stay on Vercel until every secret has its new copy', async () => {
    const jobs: string[] = [];
    const school = aiSchool({ worker: { dispatcher: { maxConcurrent: 3, dispatch: async id => { jobs.push(id); } }, callbackSecret: 'worker-callback-secret-for-tests-0123456789' } }); schools.push(school);
    const before = await school.as(ADMIN_ID);
    await configureMock(before, mock, KEY, ['agent']);
    const after = await school.as(ADMIN_ID, NEXT_ENV);
    await after.call('PUT', '/api/v1/admin/ai/settings', { runnerMode: 'cloud-run-all' });
    await after.call('POST', '/api/v1/admin/ai/tokens/students/10000000-0000-4000-8000-000000000001', { op: 'add', amount: 500_000 });
    const student = await school.as('10000000-0000-4000-8000-000000000001', NEXT_ENV);
    const first = await student.send('Привіт', { mode: 'agent' });
    expect(first.done).toBeTruthy();
    expect(jobs).toHaveLength(0);
    await after.call('POST', '/api/v1/admin/ai/secrets/prepare-next');
    // The readiness check is cached for 30 s per app instance: a fresh instance sees it at once.
    const fresh = await school.as('10000000-0000-4000-8000-000000000001', NEXT_ENV);
    const second = await fresh.send('Привіт ще раз', { mode: 'agent' });
    expect(second.events.some(item => item.event === 'attach')).toBe(true);
    expect(jobs).toHaveLength(1);
  }, 30_000);
});
