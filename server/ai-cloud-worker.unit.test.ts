import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AiChatService, WorkerOptions } from './ai/chat.js';
import { CloudRunDispatchError, CloudRunJobDispatcher, vercelWorkerDispatcher, WorkloadIdentityTokenSource } from './ai/cloud-run.js';
import { projectFromContent } from './ai/projects.js';
import type { AiWorkerDispatcher } from './ai/service.js';
import { MemoryAiStore, RedisAiStore } from './ai/store.js';
import { ADMIN_ID, aiSchool, configureMock } from './ai/testing/app-harness.js';
import { MockProviderServer, STREAMED_PAGE } from './ai/testing/mock-provider.js';
import { RedisEmulator } from './ai/testing/redis-emulator.js';
import { readZipEntries, readZipEntry } from './ai/zip.js';
import { AiProviderError } from './ai/adapters.js';
import { runAgent } from './ai/agent/run.js';
import { DEV_IDS } from './data/seed.js';
import { createWorkerChat, runWorker, type WorkerDeps } from './worker/ai-worker.js';
import { loadWorkerConfig, WorkerConfigError, type WorkerConfig } from './worker/config.js';

/**
 * The Cloud Run worker path, end to end against the real Lua scripts (Redis emulator), the mock
 * provider over HTTP and the app's own routes. No Google call is made: a fake dispatcher records
 * job ids, and the tests run the worker the way a Cloud Run execution would, in-process.
 */

const STUDENT = DEV_IDS.user;
const KEY = 'test-key-1234567890';
const CALLBACK_SECRET = 'worker-callback-secret-for-tests-0123456789';
/** The new key: AI_SECRETS_KEY_NEXT on Vercel, AI_SECRETS_KEY in the worker. */
const NEXT_KEY = Buffer.alloc(32, 41).toString('base64');
const STAGE_MS = 1_500;

let mock: MockProviderServer;
const schools: Array<ReturnType<typeof aiSchool>> = [];
beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

class FakeDispatcher implements AiWorkerDispatcher {
  maxConcurrent = 5;
  jobs: string[] = [];
  fail = false;
  async dispatch(jobId: string) {
    if (this.fail) throw new Error('Google is unreachable');
    this.jobs.push(jobId);
  }
}

/**
 * A Redis client whose calls fail while `down` is set, like a network blip to Upstash. `only`
 * limits the outage to calls that touch matching keys (the job's own records, say).
 */
class FlakyRedis {
  down = false;
  failures = 0;
  constructor(private readonly inner: RedisEmulator, private readonly only?: RegExp) {}
  async command<T>(args: Array<string | number>): Promise<T> { this.check([args]); return this.inner.command<T>(args); }
  async pipeline<T>(commands: Array<Array<string | number>>): Promise<T[]> { this.check(commands); return this.inner.pipeline<T>(commands); }
  private check(commands: Array<Array<string | number>>) {
    if (!this.down) return;
    if (this.only && !commands.some(args => args.some(arg => this.only!.test(String(arg))))) return;
    this.failures += 1;
    throw new Error('fetch failed: ECONNRESET');
  }
}

async function ready(options: { balance?: number; runner?: 'cloud-run-selected' | 'cloud-run-all' | 'vercel'; budgetMs?: number } = {}) {
  const dispatcher = new FakeDispatcher();
  const school = aiSchool({ worker: { dispatcher, callbackSecret: CALLBACK_SECRET }, secretsNext: NEXT_KEY, ...(options.budgetMs ? { generationBudgetMs: options.budgetMs } : {}) }); schools.push(school);
  const admin = await school.as(ADMIN_ID);
  const { ids } = await configureMock(admin, mock, KEY, ['agent']);
  expect((await admin.call('PUT', '/api/v1/admin/ai/settings', { runnerMode: options.runner ?? 'cloud-run-selected', runnerStudentIds: [STUDENT] })).statusCode).toBe(200);
  await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: options.balance ?? 600_000 });
  const student = await school.as(STUDENT);
  const relayed: string[] = [];
  // The worker's own HTTP: the notice relay reaches the app; everything else goes out as usual.
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://app.test/')) {
      const reply = await student.app.inject({ method: (init?.method ?? 'GET') as 'POST', url: url.slice('https://app.test'.length), headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(init?.body ? { payload: String(init.body) } : {}) });
      relayed.push(`${reply.statusCode} ${url}`);
      return new Response(reply.statusCode === 204 ? null : reply.rawPayload, { status: reply.statusCode, headers: { 'content-type': String(reply.headers['content-type'] ?? 'application/octet-stream') } });
    }
    return fetch(input, init);
  };
  const config = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
    jobId: randomUUID(), workerId: `test:${randomUUID().slice(0, 8)}`, environment: 'preview', redis: { url: 'https://redis.test', token: 'unused' },
    aiRedisPrefix: 'aiss:test:ai:v1', secrets: { AI_SECRETS_KEY: NEXT_KEY }, selfCheck: false,
    callback: { url: 'https://app.test', secret: CALLBACK_SECRET }, stageBudgetMs: STAGE_MS, maxRuntimeMs: 10 * 60_000, leaseMs: 1_500,
    maxAttempts: 2, requestTimeoutMs: 60_000, idleTimeoutMs: 30_000, handoff: null, ...overrides
  });
  // The worker reads attached files only through short links from the app, like in production.
  const worker = (overrides: Partial<WorkerConfig> = {}, deps: WorkerDeps = {}) => createWorkerChat(config(overrides), {
    store: school.aiStore, fetcher, dispatcher, allowLocalProviderUrls: true, log: () => undefined, ...deps
  });
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const run = (chat: AiChatService, jobId: string, extra: Partial<WorkerOptions> = {}) => chat.runWorkerJob(jobId, {
    workerId: `test:${randomUUID().slice(0, 8)}`, stageBudgetMs: STAGE_MS, leaseMs: 1_500, deadlineAt: Date.now() + 10 * 60_000, maxAttempts: 2,
    log: (event, fields) => { events.push({ event, ...(fields ? { fields } : {}) }); }, ...extra
  });
  /** The student asks in agent mode; with Cloud Run on, the app gets the job and a hand-over, not a stream. */
  const ask = async (content: string, extra: Parameters<typeof student.send>[1] = {}) => {
    const sent = await student.send(content, { mode: 'agent', ...extra });
    const start = sent.events.find(item => item.event === 'start')?.data;
    return { ...sent, jobId: start?.jobId as string, conversationId: start?.conversationId as string, attached: sent.events.some(item => item.event === 'attach') };
  };
  const balance = async () => (await student.call('GET', '/api/v1/ai/me')).json().balance as { available: number; used: number };
  const ledger = () => school.aiStore.listLedger(STUDENT, 100);
  return { school, admin, student, dispatcher, ids, worker, run, ask, balance, ledger, relayed, events, fetcher, config };
}

const waitFor = async <T>(probe: () => Promise<T | null | undefined | false>, ms = 8_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

describe('Cloud Run worker: jobs go to a worker and finish without the browser', () => {
  it('stores the job first, hands only its id to Cloud Run, and lets the app follow it after a reopen (scenario 2)', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    expect(sent.response.statusCode).toBe(200);
    expect(sent.attached).toBe(true);
    expect(sent.done).toBeUndefined();
    expect(t.dispatcher.jobs).toEqual([sent.jobId]);
    const stored = await t.school.aiStore.getJob(sent.jobId);
    expect(stored).toMatchObject({ runner: 'cloud-run', status: 'running', attempts: 0, dispatches: 1 });
    // The spec holds references and the student's text, never a key or a provider URL.
    expect(stored!.spec).toMatchObject({ version: 1, text: '[parts-fixture] Зроби сайт-візитку', resumeOf: null });
    expect(JSON.stringify(stored)).not.toContain(KEY);
    // The student closed the Mini App: nobody watches. The worker does the whole task, continuation included.
    const report = await t.run(t.worker(), sent.jobId);
    expect(report.stages.map(stage => stage.status)).toEqual(['finished', 'finished']);
    const last = await t.school.aiStore.getJob(report.stages.at(-1)!.jobId);
    expect(last).toMatchObject({ status: 'complete', round: 1 });
    // Reopened later: the chat shows both parts and the finished site.
    const view = (await t.student.call('GET', `/api/v1/ai/conversations/${sent.conversationId}`)).json();
    expect(view.messages.filter((message: any) => message.role === 'assistant')).toHaveLength(2);
    expect(view.messages.at(-1).files).toHaveLength(1);
    // The worker asked Vercel to send the «ready» notice; it does not hold the bot token itself.
    expect(t.relayed.some(line => line.startsWith('204 ') && line.includes(last!.id))).toBe(true);
  }, 30_000);

  it('builds the final ZIP with every file written across stages (scenario 12)', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    const report = await t.run(t.worker(), sent.jobId);
    const last = await t.school.aiStore.getJob(report.stages.at(-1)!.jobId);
    const file = last!.files[0]!;
    const link = await t.student.call('POST', `/api/v1/ai/files/${file.id}/link`);
    expect(link.statusCode).toBe(200);
    const download = await t.student.app.inject({ method: 'GET', url: link.json().url });
    expect(download.statusCode).toBe(200);
    const zip = download.rawPayload;
    const entries = readZipEntries(zip);
    expect(entries.map(entry => entry.path).sort()).toEqual(['about.html', 'index.html', 'styles.css']);
    const record = projectFromContent((await t.school.aiStore.getGeneratedFile(file.id))!.content);
    for (const entry of entries) {
      expect(readZipEntry(zip, entry, 1_000_000).toString('utf8')).toBe(record.files.find(item => item.path === entry.path)!.content);
    }
  }, 30_000);

  it('continues a run that ended before its first file, on the server (scenario 5)', async () => {
    const t = await ready();
    const sent = await t.ask('[retry-empty-fixture] Зроби сайт за брифом');
    const report = await t.run(t.worker(), sent.jobId);
    expect(report.stages).toHaveLength(2);
    const first = await t.school.aiStore.getJob(sent.jobId);
    expect(first).toMatchObject({ status: 'interrupted', resume: { round: 1, max: 3 } });
    expect(first!.files).toHaveLength(0);
    const second = await t.school.aiStore.getJob(report.stages[1]!.jobId);
    expect(second).toMatchObject({ status: 'complete', round: 1 });
    expect(second!.spec!.resumeOf).toBe(sent.jobId);
    expect(second!.files).toHaveLength(1);
  }, 30_000);

  it('runs a long task as bounded stages with lease and reservation renewed past the 6-minute TTL (scenario 1)', async () => {
    // A 30+ minute generation is many stages and many lease renewals. The stages run here for real,
    // shortened; the renewals are checked against real timestamps 35 minutes apart in the Lua scripts.
    const t = await ready();
    const sent = await t.ask('[endless-fixture] Пиши нотатки, поки не скажу');
    const report = await t.run(t.worker(), sent.jobId);
    // Never endless: the first run plus MAX_AUTO_RESUMES continuations, then the student decides.
    expect(report.stages).toHaveLength(4);
    const last = await t.school.aiStore.getJob(report.stages.at(-1)!.jobId);
    expect(last).toMatchObject({ status: 'interrupted', resume: null, round: 3 });
    expect(last!.errorCode).toBe('AI_TIME_LIMIT');
    // Every stage was charged exactly once and no reservation expired on its own.
    const entries = await t.ledger();
    expect(entries.filter(entry => entry.type === 'expired_reservation')).toHaveLength(0);
    const requestIds = entries.filter(entry => entry.type === 'charge').map(entry => (entry as any).requestId);
    expect(new Set(requestIds).size).toBe(requestIds.length);
    expect(t.events.filter(item => item.event === 'lease.claimed')).toHaveLength(4);

    for (const store of [new MemoryAiStore(), new RedisAiStore(new RedisEmulator(), 'aiss:long:ai:v1')]) {
      const start = Date.UTC(2026, 9, 19, 9, 0, 0);
      const reserve = (requestId: string, now: number) => store.reserve({
        studentId: STUDENT, requestId, amount: 1_000, minAmount: 100, inputEstimate: 400, expiresAt: now + 6 * 60_000, now, period: '2026-10',
        maxConcurrent: 5, rateLimit: 100, rateWindow: Math.floor(now / 60_000), renewalLedger: { id: randomUUID(), at: new Date(now).toISOString(), studentId: STUDENT, type: 'monthly_renewal', actorId: null, note: null },
        expiryLedger: { at: new Date(now).toISOString(), studentId: STUDENT, type: 'expired_reservation', actorId: null, note: null }
      });
      await store.adjust(STUDENT, { kind: 'add', amount: 10_000 }, { id: randomUUID(), at: new Date(start).toISOString(), studentId: STUDENT, type: 'grant', actorId: null, note: null });
      expect((await reserve('kept', start)).status).toBe('ok');
      expect((await reserve('dropped', start)).status).toBe('ok');
      // The worker renews every few dozen seconds; here, the renewal at minute 30 for the kept one only.
      for (let minute = 1; minute <= 35; minute += 1) expect(await store.extendReservation(STUDENT, 'kept', start + minute * 60_000 + 6 * 60_000)).toBe(true);
      const later = await reserve('probe', start + 35 * 60_000);
      const expired = later.expired.map(item => item.requestId);
      expect(expired).toContain('dropped');
      expect(expired).not.toContain('kept');
      // The lease follows the same clock: renewed at minute 35, still owned; another worker is refused.
      const job = { id: randomUUID(), studentId: STUDENT, requestId: 'kept', status: 'running' };
      await store.createJob({ ...job, conversationId: 'c', userMessageId: 'u', assistantMessageId: 'a', modelId: 'm', modelLabel: 'M', groupId: null, createdAt: start, heartbeatAt: start, viewerAt: 0, finalizingAt: null, finishedAt: null, stopRequested: false, inputTokens: 1, errorCode: null, errorMessage: null, notify: null, notifyAttempts: 0, userMessage: null, message: null, mode: 'agent', steps: [], files: [], pending: null, decision: null, queuedUntil: null } as never);
      expect((await store.claimJobLease(job.id, 'w1', start, start + 90_000, 2)).ok).toBe(true);
      expect(await store.renewJobLease(job.id, 'w1', start + 35 * 60_000, start + 35 * 60_000 + 90_000)).toBe(true);
      expect(await store.claimJobLease(job.id, 'w2', start + 35 * 60_000 + 60_000, start + 37 * 60_000, 2)).toEqual({ ok: false, reason: 'held' });
    }
  }, 60_000);
});

describe('Cloud Run worker: failures and recovery', () => {
  it('a model request that goes silent ends by the idle timeout, not after the whole stage (scenario 3)', async () => {
    const t = await ready();
    const sent = await t.ask('[stall-fixture] Зроби великий сайт');
    const started = Date.now();
    const report = await t.run(t.worker({ idleTimeoutMs: 400 }), sent.jobId, { stageBudgetMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
    const job = await t.school.aiStore.getJob(sent.jobId);
    expect(job!.status).toBe('error');
    expect(job!.errorCode).toBe('AI_PROVIDER_TIMEOUT');
    expect(report.stages).toHaveLength(1);
  }, 30_000);

  it('a worker that dies mid-file: the next one continues from the saved offset, one project, no duplicate bytes (scenario 4)', async () => {
    const t = await ready();
    const sent = await t.ask('[streamed-site-fixture] Зроби сайт');
    const kill = new AbortController();
    const first = t.run(t.worker(), sent.jobId, { stageBudgetMs: 30_000, leaseMs: 600, kill: kill.signal });
    // Wait until the half-written page is in the draft, then "kill" the process.
    await waitFor(async () => (await t.school.aiStore.getJob(sent.jobId))?.files.length);
    kill.abort();
    expect((await first).stages[0]!.status).toBe('lost');
    const crashed = await t.school.aiStore.getJob(sent.jobId);
    expect(crashed).toMatchObject({ status: 'running', attempts: 1 });
    const draftId = crashed!.files[0]!.id;
    // Cloud Run retries the task: the lease must run out first, then the second attempt takes over.
    expect((await t.run(t.worker(), sent.jobId)).stages[0]).toMatchObject({ status: 'skipped', reason: 'held' });
    await new Promise(resolve => setTimeout(resolve, 700));
    const report = await t.run(t.worker(), sent.jobId);
    expect(report.stages.map(stage => stage.status)).toEqual(['finished', 'finished']);
    const last = await t.school.aiStore.getJob(report.stages[1]!.jobId);
    expect(last!.status).toBe('complete');
    expect(last!.files.map(file => file.id)).toEqual([draftId]);
    expect(projectFromContent((await t.school.aiStore.getGeneratedFile(draftId))!.content).files[0]!.content).toBe(STREAMED_PAGE);
  }, 30_000);

  it('a repeated delivery and a browser continuation join the work that exists (scenario 6)', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    const report = await t.run(t.worker(), sent.jobId);
    const requestsAfter = t.ledger().then(entries => entries.length);
    // Cloud Run delivers the same execution again: the job is finished, the worker leaves it.
    const again = await t.run(t.worker(), sent.jobId);
    expect(again.stages).toEqual([{ jobId: sent.jobId, status: 'skipped', reason: 'finished', round: 0 }]);
    // The app (another tab) asks to continue the first part: it gets the continuation the worker made.
    const browser = await t.student.send('', { conversationId: sent.conversationId, continueJobId: sent.jobId });
    expect(browser.events.find(item => item.event === 'attach')?.data.jobId).toBe(report.stages[1]!.jobId);
    expect((await t.ledger()).length).toBe(await requestsAfter);
  }, 30_000);

  it('two workers on one job: one works, the other leaves; one charge (scenario 7)', async () => {
    const t = await ready();
    const sent = await t.ask('[retry-empty-fixture] Зроби сайт');
    const [a, b] = await Promise.all([t.run(t.worker(), sent.jobId), t.run(t.worker(), sent.jobId)]);
    const firstStages = [a.stages[0]!, b.stages[0]!];
    expect(firstStages.filter(stage => stage.status === 'finished')).toHaveLength(1);
    expect(firstStages.find(stage => stage.status !== 'finished')).toMatchObject({ status: 'skipped', reason: 'held' });
    const requestId = (await t.school.aiStore.getJob(sent.jobId))!.requestId;
    const charges = (await t.ledger()).filter(entry => entry.type === 'charge' && (entry as any).requestId === requestId);
    expect(charges).toHaveLength(1);
    // Both workers went on to the continuation; it too ran once.
    const second = [a, b].flatMap(report => report.stages.slice(1));
    expect(second.filter(stage => stage.status === 'finished')).toHaveLength(1);
  }, 30_000);

  it('«Стоп» before a worker starts ends the job at once and costs nothing; during a run it stops within seconds (scenario 8)', async () => {
    const t = await ready();
    const before = await t.balance();
    const waiting = await t.ask('[parts-fixture] Зроби сайт');
    const stopped = await t.student.call('POST', `/api/v1/ai/jobs/${waiting.jobId}/stop`);
    expect(stopped.json().status).toBe('stopped');
    expect((await t.run(t.worker(), waiting.jobId)).stages[0]).toMatchObject({ status: 'skipped', reason: 'finished' });
    expect((await t.balance()).available).toBe(before.available);

    const running = await t.ask('[stall-fixture] Зроби великий сайт');
    const work = t.run(t.worker(), running.jobId, { stageBudgetMs: 30_000 });
    await waitFor(async () => (await t.school.aiStore.getJob(running.jobId))?.attempts);
    const pressed = Date.now();
    await t.student.call('POST', `/api/v1/ai/jobs/${running.jobId}/stop`);
    const report = await work;
    expect(Date.now() - pressed).toBeLessThan(5_000);
    const job = await t.school.aiStore.getJob(running.jobId);
    expect(job).toMatchObject({ status: 'stopped', resume: null });
    expect(report.stages).toHaveLength(1);
  }, 30_000);

  it('a balance too small for the next stage stops the chain with the saved part kept (scenario 9)', async () => {
    const empty = await ready({ balance: 0 });
    const refused = await empty.student.send('[parts-fixture] Зроби сайт', { mode: 'agent' });
    expect(refused.response.statusCode).toBe(402);
    expect(empty.dispatcher.jobs).toHaveLength(0);

    // Enough for the first run (it reserves the whole remaining balance), too little for the next one.
    const probe = await ready();
    const sample = await probe.ask('[retry-empty-fixture] Зроби сайт');
    const estimate = (await probe.school.aiStore.getJob(sample.jobId))!.inputTokens;
    const t = await ready({ balance: Math.ceil(estimate * 1.6) + 400 });
    const sent = await t.ask('[retry-empty-fixture] Зроби сайт');
    expect(sent.response.statusCode).toBe(200);
    const report = await t.run(t.worker(), sent.jobId);
    expect(report.stages).toHaveLength(1);
    expect(t.events.find(item => item.event === 'stage.continue_refused')?.fields).toMatchObject({ code: 'AI_LIMIT_TOO_LOW' });
    const job = await t.school.aiStore.getJob(sent.jobId);
    expect(job).toMatchObject({ status: 'interrupted', resume: { round: 1, max: 3 } });
    expect((await t.balance()).available).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('survives a Redis outage mid-stage and finishes once Redis is back (scenario 10)', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    // The job's records (heartbeat, steps, lease, file list) are unreachable for a while; the
    // project files themselves still save, so the result can be checked byte for byte.
    const flaky = new FlakyRedis(t.school.redis, /:job:|:runner:|:res:/);
    const store = new RedisAiStore(flaky as unknown as RedisEmulator, 'aiss:test:ai:v1');
    const chat = t.worker({}, { store });
    let outage = false;
    const report = await t.run(chat, sent.jobId, {
      log: (event) => {
        // Upstash goes away while the model writes, for longer than one heartbeat, then comes back.
        if (event === 'lease.claimed' && !outage) { outage = true; setTimeout(() => { flaky.down = true; setTimeout(() => { flaky.down = false; }, 900); }, 200); }
      }
    });
    expect(flaky.failures).toBeGreaterThan(0);
    expect(report.stages.map(stage => stage.status)).toEqual(['finished', 'finished']);
    const last = await t.school.aiStore.getJob(report.stages[1]!.jobId);
    expect(last!.status).toBe('complete');
    const record = projectFromContent((await t.school.aiStore.getGeneratedFile(last!.files[0]!.id))!.content);
    expect(record.files.map(file => file.path).sort()).toEqual(['about.html', 'index.html', 'styles.css']);
  }, 30_000);

  it('a draft save that fails does not end the run; the finished file is saved whole (scenario 11)', async () => {
    const t = await ready();
    const sent = await t.ask('[streamed-site-fixture] Зроби сайт');
    const store = t.school.aiStore;
    const original = store.putGeneratedFile.bind(store);
    let failures = 0;
    // The first write of the draft is interrupted; the save is tried again and the code is kept.
    store.putGeneratedFile = async file => { if (failures < 1) { failures += 1; throw new Error('write interrupted'); } return original(file); };
    try {
      const report = await t.run(t.worker(), sent.jobId);
      expect(failures).toBe(1);
      const last = await store.getJob(report.stages.at(-1)!.jobId);
      expect(last!.status).toBe('complete');
      const files = last!.files;
      expect(files).toHaveLength(1);
      expect(projectFromContent((await store.getGeneratedFile(files[0]!.id))!.content).files[0]!.content).toBe(STREAMED_PAGE);
    } finally {
      store.putGeneratedFile = original;
    }
  }, 30_000);

  it('does not report «done» while the site links to files it never wrote', async () => {
    const t = await ready();
    const sent = await t.ask('[missing-page-fixture] Зроби сайт');
    const report = await t.run(t.worker(), sent.jobId);
    // The first run and every continuation end with the link still missing: bounded, then honest.
    expect(report.stages).toHaveLength(4);
    const last = await t.school.aiStore.getJob(report.stages.at(-1)!.jobId);
    expect(last).toMatchObject({ status: 'interrupted', resume: null, errorCode: 'AI_PROJECT_INCOMPLETE' });
    expect(last!.errorMessage).toContain('contacts.html');
  }, 60_000);

  it('a job no worker ever took is handed over once more, then ended without a charge', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт');
    const job = (await t.school.aiStore.getJob(sent.jobId))!;
    const before = await t.balance();
    // Ten minutes and more without a worker (its slot ran out with it): recovery dispatches again…
    await t.school.aiStore.updateJob(job.id, { dispatchedAt: Date.now() - 11 * 60_000 });
    await t.school.aiStore.releaseWorkerSlot(job.id);
    await t.student.call('GET', `/api/v1/ai/jobs/${job.id}?from=0`);
    expect(t.dispatcher.jobs).toEqual([job.id, job.id]);
    // …and after the second silence it ends, free of charge, with a clear message.
    await t.school.aiStore.updateJob(job.id, { dispatchedAt: Date.now() - 11 * 60_000 });
    await t.school.aiStore.releaseWorkerSlot(job.id);
    const view = (await t.student.call('GET', `/api/v1/ai/jobs/${job.id}?from=0`)).json();
    expect(view.status).toBe('error');
    expect(view.error.code).toBe('AI_WORKER_UNAVAILABLE');
    // The reservation comes back whole: nothing was asked of the provider.
    expect((await t.balance()).available).toBe(before.available + job.reserved!);
  }, 30_000);

  it('when Google refuses a job, it ends with a clear message and no charge; it never falls back to Vercel', async () => {
    const t = await ready();
    const before = await t.balance();
    t.dispatcher.dispatch = async () => { throw new CloudRunDispatchError(403, 'HTTP 403 PERMISSION_DENIED'); };
    const sent = await t.student.send('Привіт', { mode: 'agent' });
    expect(sent.done).toBeUndefined();
    const job = await t.school.aiStore.getJob(sent.events.find(item => item.event === 'start')!.data.jobId);
    expect(job).toMatchObject({ runner: 'cloud-run', status: 'error', errorCode: 'AI_WORKER_UNAVAILABLE' });
    expect((await t.balance()).available).toBe(before.available);
  }, 30_000);

  it('a missing photo in private storage ends the job with a clear message and no charge', async () => {
    const t = await ready();
    await t.admin.call('PATCH', `/api/v1/admin/ai/models/${t.ids.agent}`, { vision: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const uploaded = await t.student.attach('дошка.png', png);
    expect(uploaded.completed?.statusCode).toBe(200);
    const before = await t.balance();
    const sent = await t.ask('Що на фото?', { attachmentIds: [uploaded.completed!.json().id] });
    expect(sent.response.statusCode).toBe(200);
    const attachment = (await t.school.aiStore.getAttachment(STUDENT, uploaded.completed!.json().id))!;
    await t.school.fileStorage.delete([attachment.pathname]);
    await t.run(t.worker(), sent.jobId);
    const job = await t.school.aiStore.getJob(sent.jobId);
    expect(job).toMatchObject({ status: 'error', errorCode: 'FILE_STORAGE_FAILED' });
    expect((await t.balance()).available).toBe(before.available);
  }, 30_000);

  it('plain chat always streams from Vercel, and «Vercel» mode keeps agent work there too', async () => {
    const t = await ready({ runner: 'vercel' });
    const agent = await t.student.send('Привіт', { mode: 'agent' });
    expect(agent.done).toBeTruthy();
    const chat = await t.student.send('Привіт');
    expect(chat.done).toBeTruthy();
    expect(t.dispatcher.jobs).toHaveLength(0);
  }, 30_000);
});

describe('Cloud Run worker: an unclear answer from Google', () => {
  it('Google started the job but the answer was lost: the job stays with the worker, Vercel generates nothing; one charge', async () => {
    const t = await ready({ budgetMs: 1_500 });
    // The run request reached Google (an execution will start), then the connection broke.
    t.dispatcher.dispatch = async (jobId: string) => { t.dispatcher.jobs.push(jobId); throw new Error('socket hang up'); };
    const before = mock.chatRequests().length;
    const sent = await t.student.send('[parts-fixture] Зроби сайт-візитку', { mode: 'agent' });
    expect(sent.events.some(item => item.event === 'attach')).toBe(true);
    expect(mock.chatRequests().length).toBe(before);
    const jobId = sent.events.find(item => item.event === 'start')!.data.jobId as string;
    // The execution Google did start does the work.
    const report = await t.run(t.worker(), jobId);
    expect(report.stages[0]!.status).toBe('finished');
    const job = await t.school.aiStore.getJob(jobId);
    expect(job!.runner).toBe('cloud-run');
    expect((await t.ledger()).filter(entry => entry.type === 'charge' && (entry as any).requestId === job!.requestId)).toHaveLength(1);
  }, 30_000);

  it('the worker took the job before Vercel gave up on Google: Vercel hands over and generates nothing', async () => {
    const t = await ready({ budgetMs: 1_500 });
    let work: Promise<unknown> | null = null;
    t.dispatcher.dispatch = async (jobId: string) => {
      t.dispatcher.jobs.push(jobId);
      work = t.run(t.worker(), jobId);
      await waitFor(async () => (await t.school.aiStore.getJob(jobId))?.attempts);
      throw new Error('deadline exceeded');
    };
    const sent = await t.student.send('[parts-fixture] Зроби сайт-візитку', { mode: 'agent' });
    expect(sent.events.some(item => item.event === 'attach')).toBe(true);
    expect(sent.done).toBeUndefined();
    await work;
    const jobId = sent.events.find(item => item.event === 'start')!.data.jobId as string;
    const first = await t.school.aiStore.getJob(jobId);
    expect(first!.runner).toBe('cloud-run');
    const charges = (await t.ledger()).filter(entry => entry.type === 'charge' && (entry as any).requestId === first!.requestId);
    expect(charges).toHaveLength(1);
  }, 30_000);

  it('a second execution started by recovery while the first is still alive does not run the job twice', async () => {
    const t = await ready();
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    const before = mock.chatRequests().length;
    const [a, b] = await Promise.all([t.run(t.worker(), sent.jobId), t.run(t.worker(), sent.jobId)]);
    const statuses = [a.stages[0]!.status, b.stages[0]!.status].sort();
    expect(statuses).toEqual(['finished', 'skipped']);
    const concurrent = mock.chatRequests().length - before;
    // Provider calls of exactly one chain of stages (the other execution made none).
    const single = await (async () => {
      const again = await ready();
      const one = await again.ask('[parts-fixture] Зроби сайт-візитку');
      const start = mock.chatRequests().length;
      await again.run(again.worker(), one.jobId);
      return mock.chatRequests().length - start;
    })();
    expect(concurrent).toBe(single);
  }, 60_000);
});

describe('Cloud Run worker: files and self-check', () => {
  it('reads an attached photo through a short link from Vercel, without any storage token', async () => {
    const t = await ready();
    await t.admin.call('PATCH', `/api/v1/admin/ai/models/${t.ids.agent}`, { vision: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const uploaded = await t.student.attach('дошка.png', png);
    const sent = await t.ask('Що на фото?', { attachmentIds: [uploaded.completed!.json().id] });
    const before = mock.chatRequests().length;
    await t.run(t.worker(), sent.jobId);
    const job = await t.school.aiStore.getJob(sent.jobId);
    expect(job!.status).toBe('complete');
    expect(t.relayed.some(line => line.startsWith('200 ') && line.includes('/file-link'))).toBe(true);
    const request = mock.chatRequests().slice(before)[0]!;
    const image = request.body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((part: any) => part.type === 'image_url');
    expect(image.image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`);
  }, 30_000);

  it('gives file links only to the worker running that job, only for that job\'s files', async () => {
    const t = await ready();
    await t.admin.call('PATCH', `/api/v1/admin/ai/models/${t.ids.agent}`, { vision: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const mine = await t.student.attach('моє.png', png);
    const other = await t.student.attach('інше.png', png);
    const sent = await t.ask('Що на фото?', { attachmentIds: [mine.completed!.json().id] });
    const pathname = (await t.school.aiStore.getAttachment(STUDENT, mine.completed!.json().id))!.pathname;
    const otherPath = (await t.school.aiStore.getAttachment(STUDENT, other.completed!.json().id))!.pathname;
    const ask = (jobId: string, path: string, secret = CALLBACK_SECRET) => t.student.app.inject({ method: 'POST', url: `/api/v1/internal/ai/jobs/${jobId}/file-link`, headers: { authorization: `Bearer ${secret}` }, payload: { pathname: path } });
    // No worker holds the job yet.
    expect((await ask(sent.jobId, pathname)).statusCode).toBe(404);
    await t.school.aiStore.claimJobLease(sent.jobId, 'w-test', Date.now(), Date.now() + 60_000, 2);
    expect((await ask(sent.jobId, pathname)).statusCode).toBe(200);
    expect((await ask(sent.jobId, otherPath)).statusCode).toBe(404);
    expect((await ask(sent.jobId, pathname, 'x'.repeat(CALLBACK_SECRET.length))).statusCode).toBe(401);
    expect((await ask(randomUUID(), pathname)).statusCode).toBe(404);
  }, 30_000);

  it('self-check proves storage, keys and the way back to Vercel, printing no values', async () => {
    const t = await ready();
    const lines: string[] = [];
    const env = { AI_WORKER_SELF_CHECK: '1', AI_WORKER_ENVIRONMENT: 'preview', UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 'redis-token-not-for-logs', SESSION_REDIS_PREFIX: 'aiss:test', AI_SECRETS_KEY: NEXT_KEY, AI_WORKER_CALLBACK_URL: 'https://app.test', AI_WORKER_CALLBACK_SECRET: CALLBACK_SECRET };
    const log = (_severity: string, event: string, fields?: Record<string, unknown>) => { lines.push(JSON.stringify({ event, ...fields })); };
    const passed = await runWorker(env, { store: t.school.aiStore, fetcher: t.fetcher, log });
    expect(passed.exitCode).toBe(0);
    const done = JSON.parse(lines.find(line => line.includes('selfcheck.done'))!);
    expect(done.steps.map((step: any) => [step.step, step.ok])).toEqual([['redis', true], ['provider-secrets', true], ['vercel-callback', true]]);
    // A worker given a different key fails the key step and says what to do.
    const wrong = await runWorker({ ...env, AI_SECRETS_KEY: Buffer.alloc(32, 9).toString('base64') }, { store: t.school.aiStore, fetcher: t.fetcher, log });
    expect(wrong.exitCode).toBe(1);
    const all = lines.join('\n');
    for (const secret of ['redis-token-not-for-logs', CALLBACK_SECRET, NEXT_KEY, KEY]) expect(all).not.toContain(secret);
  }, 30_000);
});

describe('Cloud Run worker: boundaries', () => {
  it('the notice relay needs the shared secret and takes only a job id', async () => {
    const t = await ready();
    const url = `/api/v1/internal/ai/jobs/${randomUUID()}/notice`;
    expect((await t.student.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    expect((await t.student.app.inject({ method: 'POST', url, headers: { authorization: 'Bearer wrong-secret-of-the-same-length-000000000' } })).statusCode).toBe(401);
    expect((await t.student.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${CALLBACK_SECRET}` } })).statusCode).toBe(204);
    expect((await t.student.app.inject({ method: 'POST', url: '/api/v1/internal/ai/jobs/not-a-job/notice', headers: { authorization: `Bearer ${CALLBACK_SECRET}` } })).statusCode).toBe(400);
    const closed = aiSchool(); schools.push(closed);
    const app = (await closed.as(STUDENT)).app;
    expect((await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${CALLBACK_SECRET}` } })).statusCode).toBe(404);
  }, 30_000);

  it('the worker refuses incomplete or unsafe configuration and names fields, never values', async () => {
    const secret = 'super-secret-token-value-should-not-appear';
    const base = { AI_JOB_ID: randomUUID(), AI_WORKER_ENVIRONMENT: 'production', UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: secret, AI_SECRETS_KEY: NEXT_KEY };
    expect(() => loadWorkerConfig({ ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1' })).not.toThrow();
    for (const env of [
      { ...base },
      { ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', AI_JOB_ID: 'x; rm -rf /' },
      { ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', AI_WORKER_CALLBACK_URL: 'http://evil.test', AI_WORKER_CALLBACK_SECRET: 'short' },
      // The session pepper and the store-wide Blob token never go to Google.
      { ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', SESSION_TOKEN_PEPPER: secret },
      { ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_${secret}` },
      { ...base, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1', AI_SECRETS_KEY: '' }
    ]) {
      let error: unknown;
      try { loadWorkerConfig(env); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect(String((error as Error).message)).not.toContain(secret);
    }
    // A production worker pointed at a preview namespace stops before touching Redis.
    expect(() => loadWorkerConfig({ ...base, SESSION_REDIS_PREFIX: 'aiss:preview:sessions:v1' })).toThrow(/production/);
    const lines: string[] = [];
    const result = await runWorker({ ...base }, { log: (_severity, event, fields) => { lines.push(JSON.stringify({ event, ...fields })); } });
    expect(result.exitCode).toBe(2);
    expect(lines.join('\n')).not.toContain(secret);
  });

  it('Vercel trades its OIDC token for a short Google token and starts the job with only the id; errors carry no tokens', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeGoogle: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.startsWith('https://sts.googleapis.com/')) return Response.json({ access_token: 'ya29.federated-token-abcdefghijklmnop', expires_in: 3600 });
      if (url.includes(':generateAccessToken')) return Response.json({ accessToken: 'ya29.service-account-token-abcdefghijklmnop', expireTime: new Date(Date.now() + 600_000).toISOString() });
      if (url.includes(':run')) return calls.filter(call => call.url.includes(':run')).length > 1
        ? Response.json({ error: { status: 'PERMISSION_DENIED', message: 'caller ya29.service-account-token-abcdefghijklmnop lacks permission' } }, { status: 403 })
        : Response.json({ name: 'operations/x' });
      return new Response('nope', { status: 404 });
    };
    const env = {
      AI_WORKER_GCP_PROJECT: 'student-os', AI_WORKER_GCP_REGION: 'europe-west1', AI_WORKER_JOB_NAME: 'ai-worker',
      AI_WORKER_WIF_AUDIENCE: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel',
      AI_WORKER_DISPATCH_SERVICE_ACCOUNT: 'ai-dispatch@student-os.iam.gserviceaccount.com'
    };
    const { dispatcher, problem } = vercelWorkerDispatcher(env, async () => 'vercel-oidc-jwt', fakeGoogle);
    expect(problem).toBeNull();
    const jobId = randomUUID();
    await dispatcher!.dispatch(jobId);
    const run = calls.find(call => call.url.includes(':run'))!;
    expect(run.url).toBe('https://run.googleapis.com/v2/projects/student-os/locations/europe-west1/jobs/ai-worker:run');
    expect(JSON.parse(run.body)).toEqual({ overrides: { containerOverrides: [{ env: [{ name: 'AI_JOB_ID', value: jobId }] }], taskCount: 1 } });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ subjectToken: 'vercel-oidc-jwt', audience: env.AI_WORKER_WIF_AUDIENCE });
    await expect(dispatcher!.dispatch('../../etc')).rejects.toThrow('Invalid job id');
    const failure = await dispatcher!.dispatch(randomUUID()).then(() => null, error => error as Error);
    expect(failure?.message).toContain('PERMISSION_DENIED');
    expect(failure?.message).not.toContain('service-account-token');
    // The token is reused until it nearly expires: one exchange for both runs.
    expect(calls.filter(call => call.url.startsWith('https://sts.')).length).toBe(1);
    expect(vercelWorkerDispatcher({ ...env, AI_WORKER_JOB_NAME: '' }, async () => null).problem).toContain('AI_WORKER_JOB_NAME');
    expect(vercelWorkerDispatcher({}, async () => null)).toEqual({ dispatcher: null, problem: null });
    await expect(new WorkloadIdentityTokenSource({ audience: env.AI_WORKER_WIF_AUDIENCE, serviceAccount: 'x@y', subjectToken: async () => null }).token()).rejects.toThrow('OIDC');
    expect(new CloudRunJobDispatcher({ project: 'p', region: 'r', job: 'j', maxConcurrent: 2, tokens: { token: async () => 't' } }).maxConcurrent).toBe(2);
  });

  it('caps jobs with workers; past the cap a request ends with a clear message and no charge, never on Vercel', async () => {
    const t = await ready();
    t.dispatcher.maxConcurrent = 1;
    await t.admin.call('PUT', '/api/v1/admin/ai/settings', { maxConcurrentPerStudent: 3 });
    const first = await t.ask('[parts-fixture] Зроби сайт');
    expect(first.attached).toBe(true);
    const other = await t.student.send('Привіт', { mode: 'agent' });
    expect(other.done).toBeUndefined();
    const otherJob = await t.school.aiStore.getJob(other.events.find(item => item.event === 'start')!.data.jobId);
    expect(otherJob).toMatchObject({ runner: 'cloud-run', status: 'error', errorCode: 'AI_WORKER_UNAVAILABLE' });
    expect(t.dispatcher.jobs).toEqual([first.jobId]);
  }, 30_000);
});

describe('Cloud Run worker: how sites are written', () => {
  const systemOf = (request: { body: any }) => String(request.body.messages?.[0]?.content ?? '');
  const toolDescription = (request: { body: any }, name: string) => String(request.body.tools?.find((tool: any) => tool.function?.name === name)?.function?.description ?? '');

  it('a worker job asks for whole files; a Vercel job keeps the short saved pieces', async () => {
    const t = await ready();
    const before = mock.chatRequests().length;
    const sent = await t.ask('[parts-fixture] Зроби сайт-візитку');
    await t.run(t.worker(), sent.jobId);
    const onWorker = mock.chatRequests()[before]!;
    expect(systemOf(onWorker)).toContain('Пиши кожен файл повністю одним викликом');
    expect(systemOf(onWorker)).not.toContain('збережи перші 4000 символів');
    expect(toolDescription(onWorker, 'create_project')).toContain('Кожен файл пиши повністю');
    expect(toolDescription(onWorker, 'create_project')).not.toContain('Сайт будуй частинами');

    const v = await ready({ runner: 'vercel', budgetMs: 1_500 });
    const start = mock.chatRequests().length;
    await v.student.send('[parts-fixture] Зроби сайт-візитку', { mode: 'agent' });
    const onVercel = mock.chatRequests()[start]!;
    expect(systemOf(onVercel)).toContain('збережи перші 4000 символів');
    expect(toolDescription(onVercel, 'create_project')).toContain('Сайт будуй частинами');
  }, 30_000);

  it('waits ten minutes of silence by default: Claude sends a whole file parameter only once it is written', () => {
    const env = {
      AI_JOB_ID: randomUUID(), AI_WORKER_ENVIRONMENT: 'production', UPSTASH_REDIS_REST_URL: 'https://r.test', UPSTASH_REDIS_REST_TOKEN: 'token',
      AI_SECRETS_KEY: NEXT_KEY, SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1'
    };
    expect(loadWorkerConfig(env).idleTimeoutMs).toBe(10 * 60_000);
    expect(loadWorkerConfig({ ...env, AI_WORKER_IDLE_TIMEOUT_MS: '120000' }).idleTimeoutMs).toBe(120_000);
  });

  it('a 400 that only mentions a tool call is the provider\'s own error, not «this model cannot do agent mode»', async () => {
    const failing = (message: string) => runAgent({
      turns: [{ role: 'user', content: 'Зроби сайт' }], tools: [], maxSteps: 4, budget: 100_000, maxOutputTokens: 1000, maxInputTokens: 100_000,
      signal: new AbortController().signal, emit: () => undefined, steps: [], saveSteps: async () => undefined, addFile: async () => undefined,
      confirm: async () => false, abortReason: () => null, recordError: async () => undefined,
      call: async function* () { throw new AiProviderError('bad_request', message, 400); }
    });
    const broken = await failing('Validation: `messages[16].tool_calls[0].function.arguments` must be a valid JSON object string: EOF while parsing a value at line 1 column 63');
    expect(broken.status).toBe('error');
    expect(broken.notice).toBeNull();
    for (const refusal of ['This model does not support tools', 'Tool use is not supported for this model', 'No endpoints found that support tool use']) {
      expect((await failing(refusal)).notice?.code).toBe('AI_AGENT_UNSUPPORTED');
    }
  });
});
