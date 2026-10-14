import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAiStore, RedisAiStore, type AiStore, type LedgerDraft, type ReserveInput } from './store.js';
import type { AiJob } from './types.js';
import { RedisEmulator } from './testing/redis-emulator.js';

const STUDENT = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-10-13T10:00:00Z');

function draft(type: LedgerDraft['type'], studentId = STUDENT): LedgerDraft {
  return { id: randomUUID(), at: new Date(NOW).toISOString(), studentId, type, actorId: 'admin', note: null };
}

function reserveInput(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    studentId: STUDENT, requestId: randomUUID().replace(/-/g, ''), amount: 300, minAmount: 100, inputEstimate: 80,
    expiresAt: NOW + 360_000, now: NOW, period: '2026-10', maxConcurrent: 50, rateLimit: 1000, rateWindow: Math.floor(NOW / 60_000),
    renewalLedger: draft('monthly_renewal'), expiryLedger: { at: new Date(NOW).toISOString(), studentId: STUDENT, type: 'expired_reservation', actorId: null, note: null },
    ...overrides
  };
}

const stores: Array<[string, () => AiStore]> = [
  ['memory', () => new MemoryAiStore()],
  ['redis (real Lua scripts)', () => new RedisAiStore(new RedisEmulator(() => NOW), 'aiss:test:ai:v1')]
];

describe.each(stores)('AI token store — %s', (_name, create) => {
  it('reserves, settles the real usage and returns the unused reserve', async () => {
    const store = create();
    expect(await store.adjust(STUDENT, { kind: 'add', amount: 1000 }, draft('grant'))).toEqual({ before: 0, after: 1000 });
    const reserved = await store.reserve(reserveInput({ requestId: 'req1' }));
    expect(reserved).toMatchObject({ status: 'ok', reserved: 300, balance: 1000, available: 700 });
    const settled = await store.settle({ studentId: STUDENT, requestId: 'req1', actual: 150, inputTokens: 120, outputTokens: 30, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') });
    expect(settled).toEqual({ status: 'ok', charged: 150, balance: 850 });
    const balance = (await store.getBalances([STUDENT])).get(STUDENT)!;
    expect(balance).toMatchObject({ balance: 850, reserved: 0, used: 150, inputUsed: 120, outputUsed: 30, requests: 1, lastModelId: 'm1' });
    const ledger = await store.listLedger(STUDENT, 10);
    expect(ledger.map(entry => [entry.type, entry.amount, entry.balanceAfter])).toEqual([['charge', -150, 850], ['grant', 1000, 1000]]);
    expect((await store.listLedger(null, 10)).map(entry => entry.type)).toEqual(['grant']);
  });

  it('never lets a balance go below zero, even when the provider used more than was reserved', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'add', amount: 100 }, draft('grant'));
    const reserved = await store.reserve(reserveInput({ requestId: 'small', amount: 500, minAmount: 50 }));
    expect(reserved).toMatchObject({ status: 'ok', reserved: 100 });
    const settled = await store.settle({ studentId: STUDENT, requestId: 'small', actual: 400, inputTokens: 300, outputTokens: 100, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') });
    expect(settled).toEqual({ status: 'ok', charged: 100, balance: 0 });
    expect((await store.reserve(reserveInput({ requestId: 'next' }))).status).toBe('insufficient');
    expect((await store.getBalances([STUDENT])).get(STUDENT)!.balance).toBe(0);
  });

  it('lets parallel requests reserve only what the balance covers', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'set', amount: 1000 }, draft('set'));
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => store.reserve(reserveInput({ requestId: `p${index}`, amount: 300, minAmount: 300 }))));
    const granted = results.filter(result => result.status === 'ok');
    expect(granted).toHaveLength(3);
    expect(results.filter(result => result.status === 'insufficient')).toHaveLength(17);
    const balance = (await store.getBalances([STUDENT])).get(STUDENT)!;
    expect(balance.reserved).toBe(900);
    expect(balance.balance - balance.reserved).toBe(100);
    await Promise.all(results.map((result, index) => result.status === 'ok'
      ? store.settle({ studentId: STUDENT, requestId: `p${index}`, actual: 400, inputTokens: 300, outputTokens: 100, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') })
      : null));
    const after = (await store.getBalances([STUDENT])).get(STUDENT)!;
    expect(after.balance).toBe(0);
    expect(after.used).toBe(1000);
    expect(after.reserved).toBe(0);
  });

  it('refuses a repeated request id and never charges one request twice', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'add', amount: 1000 }, draft('grant'));
    expect((await store.reserve(reserveInput({ requestId: 'once' }))).status).toBe('ok');
    expect((await store.reserve(reserveInput({ requestId: 'once' }))).status).toBe('duplicate');
    const settle = () => store.settle({ studentId: STUDENT, requestId: 'once', actual: 200, inputTokens: 150, outputTokens: 50, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') });
    expect(await settle()).toMatchObject({ status: 'ok', charged: 200 });
    expect(await settle()).toMatchObject({ status: 'unknown', charged: 0 });
    expect((await store.reserve(reserveInput({ requestId: 'once' }))).status).toBe('duplicate');
    expect((await store.getBalances([STUDENT])).get(STUDENT)!.balance).toBe(800);
  });

  it('enforces blocking, the concurrency cap and the per-minute rate limit', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'add', amount: 10_000 }, draft('grant'));
    expect((await store.reserve(reserveInput({ requestId: 'c1', maxConcurrent: 2 }))).status).toBe('ok');
    expect((await store.reserve(reserveInput({ requestId: 'c2', maxConcurrent: 2 }))).status).toBe('ok');
    expect((await store.reserve(reserveInput({ requestId: 'c3', maxConcurrent: 2 }))).status).toBe('busy');
    expect((await store.reserve(reserveInput({ studentId: OTHER, requestId: 'r1', rateLimit: 1, renewalLedger: draft('monthly_renewal', OTHER) }))).status).toBe('insufficient');
    expect((await store.reserve(reserveInput({ studentId: OTHER, requestId: 'r2', rateLimit: 1, renewalLedger: draft('monthly_renewal', OTHER) }))).status).toBe('rate_limited');
    await store.setBlocked(STUDENT, true, draft('block'));
    expect((await store.reserve(reserveInput({ requestId: 'c4' }))).status).toBe('blocked');
    await store.setBlocked(STUDENT, false, draft('unblock'));
    expect((await store.listLedger(STUDENT, 5)).map(entry => entry.type).slice(0, 2)).toEqual(['unblock', 'block']);
  });

  it('charges the input estimate of a reservation that was never settled and frees the rest', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'add', amount: 1000 }, draft('grant'));
    expect((await store.reserve(reserveInput({ requestId: 'lost', amount: 500, inputEstimate: 80, expiresAt: NOW + 60_000 }))).status).toBe('ok');
    const later = await store.reserve(reserveInput({ requestId: 'later', now: NOW + 120_000, expiresAt: NOW + 480_000 }));
    expect(later.status).toBe('ok');
    expect(later.expired).toEqual([{ requestId: 'lost', charged: 80 }]);
    const balance = (await store.getBalances([STUDENT])).get(STUDENT)!;
    expect(balance).toMatchObject({ balance: 920, reserved: 300, approxUsed: 80 });
    expect((await store.listLedger(STUDENT, 5)).find(entry => entry.type === 'expired_reservation')).toMatchObject({ amount: -80, balanceAfter: 920, requestId: 'lost' });
    expect(await store.settle({ studentId: STUDENT, requestId: 'lost', actual: 500, inputTokens: 400, outputTokens: 100, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') })).toMatchObject({ status: 'unknown' });
  });

  it('renews a monthly allowance once per school month', async () => {
    const store = create();
    expect(await store.setMonthly(STUDENT, 5000, '2026-10', draft('monthly_on'))).toEqual({ before: 0, after: 5000 });
    expect((await store.reserve(reserveInput({ requestId: 'm1', period: '2026-10' }))).renewed).toBe(false);
    await store.settle({ studentId: STUDENT, requestId: 'm1', actual: 1000, inputTokens: 800, outputTokens: 200, approximate: false, now: NOW, modelId: 'm1', ledger: draft('charge') });
    expect((await store.getBalances([STUDENT])).get(STUDENT)!.balance).toBe(4000);
    const november = await store.reserve(reserveInput({ requestId: 'm2', period: '2026-11', renewalLedger: draft('monthly_renewal') }));
    expect(november).toMatchObject({ status: 'ok', renewed: true, balance: 5000 });
    expect(await store.renewMonthly(STUDENT, '2026-11', draft('monthly_renewal'))).toBe(false);
    expect((await store.listLedger(null, 5))[0]).toMatchObject({ type: 'monthly_renewal', amount: 1000, balanceAfter: 5000 });
    await store.setMonthly(STUDENT, 0, '2026-11', draft('monthly_off'));
    expect(await store.renewMonthly(STUDENT, '2026-12', draft('monthly_renewal'))).toBe(false);
  });

  it('applies add, set and reset with an exact journal', async () => {
    const store = create();
    await store.adjust(STUDENT, { kind: 'add', amount: 500_000 }, draft('grant'));
    await store.adjust(STUDENT, { kind: 'add', amount: 100_000 }, draft('grant'));
    await store.adjust(STUDENT, { kind: 'set', amount: 250_000 }, draft('set'));
    expect(await store.adjust(STUDENT, { kind: 'reset' }, draft('reset'))).toEqual({ before: 250_000, after: 0 });
    expect((await store.listLedger(null, 10)).map(entry => [entry.type, entry.amount, entry.balanceAfter])).toEqual([
      ['reset', -250_000, 0], ['set', -350_000, 250_000], ['grant', 100_000, 600_000], ['grant', 500_000, 500_000]
    ]);
    expect((await store.listLedger(OTHER, 10))).toEqual([]);
  });

  it('aggregates usage counters by day and hour', async () => {
    const store = create();
    const increments = [{ field: 't', by: 150 }, { field: `s:${STUDENT}:t`, by: 150 }, { field: 'req', by: 1 }];
    await store.recordUsage({ usage: null, error: null, day: '2026-10-13', hour: '2026-10-13T13', increments });
    await store.recordUsage({ usage: null, error: { id: 'e1', at: new Date(NOW).toISOString(), providerId: 'p', modelId: null, status: 500, code: 'server', message: 'x', studentId: null }, day: '2026-10-13', hour: '2026-10-13T13', increments });
    const stats = await store.getStats(['2026-10-12', '2026-10-13'], ['2026-10-13T13']);
    expect(stats.days['2026-10-13']).toMatchObject({ t: 300, req: 2, [`s:${STUDENT}:t`]: 300 });
    expect(stats.days['2026-10-12']).toEqual({});
    expect(stats.hours['2026-10-13T13']).toMatchObject({ t: 300 });
    expect(await store.sumDayFields(['2026-10-12', '2026-10-13'], ['t', 'missing'])).toEqual({ t: 300, missing: 0 });
    expect((await store.listErrors(5)).map(item => item.id)).toEqual(['e1']);
  });

  it('keeps each student\'s conversations apart', async () => {
    const store = create();
    const conversation = { id: randomUUID(), studentId: STUDENT, title: 'Перший', modelId: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), messageCount: 0, preview: '' };
    await store.putConversation(conversation);
    await store.appendMessages(conversation.id, [1, 2, 3].map(index => ({ id: `m${index}`, role: index % 2 ? 'user' as const : 'assistant' as const, content: `текст ${index}`, createdAt: new Date(NOW).toISOString() })), 2);
    expect((await store.getMessages(conversation.id, 10)).map(message => message.id)).toEqual(['m2', 'm3']);
    expect(await store.getConversation(OTHER, conversation.id)).toBeNull();
    expect(await store.listConversations(OTHER)).toEqual([]);
    await store.deleteConversation(STUDENT, conversation.id);
    expect(await store.getConversation(STUDENT, conversation.id)).toBeNull();
    expect(await store.getMessages(conversation.id, 10)).toEqual([]);
  });
});

function job(overrides: Partial<AiJob> = {}): AiJob {
  return {
    id: randomUUID(), studentId: STUDENT, conversationId: randomUUID(), requestId: randomUUID().replace(/-/g, ''),
    userMessageId: randomUUID(), assistantMessageId: randomUUID(), modelId: 'm1', modelLabel: 'Модель', groupId: null,
    status: 'running', createdAt: NOW, heartbeatAt: NOW, viewerAt: NOW, finalizingAt: null, finishedAt: null, stopRequested: false,
    inputTokens: 120, errorCode: null, errorMessage: null, notify: null, notifyAttempts: 0,
    userMessage: { id: 'u1', role: 'user', content: 'Питання', createdAt: new Date(NOW).toISOString() }, message: null,
    ...overrides
  };
}

describe.each(stores)('AI answer jobs — %s', (_name, create) => {
  it('creates a job once per request and keeps its text in UTF-8 byte order', async () => {
    const store = create();
    const first = job();
    expect(await store.createJob(first)).toEqual({ created: true });
    expect(await store.createJob(job({ requestId: first.requestId }))).toEqual({ created: false, existingJobId: first.id });
    expect(await store.jobIdForRequest(first.requestId)).toBe(first.id);
    expect(await store.listActiveJobs()).toEqual([{ jobId: first.id, studentId: STUDENT }]);

    expect(await store.flushJob(first.id, 'Привіт, ', NOW + 1_000)).toEqual({ stopRequested: false });
    await store.flushJob(first.id, 'світ ✅', NOW + 2_000);
    const whole = await store.viewJob(first.id, 0, NOW + 2_500);
    expect(whole).toMatchObject({ text: 'Привіт, світ ✅', length: Buffer.byteLength('Привіт, світ ✅') });
    expect(whole!.job).toMatchObject({ heartbeatAt: NOW + 2_000, viewerAt: NOW + 2_500, userMessage: { content: 'Питання' } });
    // The app asks for what comes after the bytes it already has.
    const rest = await store.viewJob(first.id, Buffer.byteLength('Привіт, '), NOW + 3_000);
    expect(rest!.text).toBe('світ ✅');
    expect((await store.viewJob(first.id, whole!.length, NOW + 3_000))!.text).toBe('');
    expect(await store.getJobText(first.id)).toBe('Привіт, світ ✅');
    expect(await store.viewJob(randomUUID(), 0, NOW)).toBeNull();
  });

  it('passes a stop to the generating function on its next write', async () => {
    const store = create();
    const item = job();
    await store.createJob(item);
    await store.requestJobStop(item.id);
    expect(await store.flushJob(item.id, '', NOW + 1_000)).toEqual({ stopRequested: true });
  });

  it('lets exactly one finisher claim a job, and recovery only once it went quiet', async () => {
    const store = create();
    const item = job();
    await store.createJob(item);
    await store.flushJob(item.id, 'частина', NOW + 10_000);
    // Recovery may not take a job that is still alive.
    expect(await store.claimJobFinalization(item.id, NOW + 20_000, NOW + 5_000)).toBe(false);
    const claims = await Promise.all([store.claimJobFinalization(item.id, NOW + 20_000, null), store.claimJobFinalization(item.id, NOW + 20_000, null), store.claimJobFinalization(item.id, NOW + 80_000, NOW + 20_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.getJob(item.id))!.status).toBe('finalizing');
    // A finisher that died while finalizing is replaced once it is stale.
    expect(await store.claimJobFinalization(item.id, NOW + 30_000, NOW + 10_000)).toBe(false);
    expect(await store.claimJobFinalization(item.id, NOW + 90_000, NOW + 30_000)).toBe(true);
    await store.finishJob(item.id, { status: 'complete', finishedAt: NOW + 91_000, message: { id: item.assistantMessageId, role: 'assistant', content: 'частина', createdAt: new Date(NOW).toISOString() } });
    expect(await store.claimJobFinalization(item.id, NOW + 200_000, NOW + 150_000)).toBe(false);
    expect(await store.getJob(item.id)).toMatchObject({ status: 'complete', message: { content: 'частина' } });
    // Finished but still owed a notice: it stays on the index until released.
    expect(await store.listActiveJobs()).toHaveLength(1);
    await store.releaseJob(item.id);
    expect(await store.listActiveJobs()).toEqual([]);
    expect((await store.getJobs([item.id, randomUUID()])).size).toBe(1);
  });

  it('leases the notice to one sender and allows a retry only after a failure', async () => {
    const store = create();
    const item = job({ status: 'complete', finishedAt: NOW });
    await store.createJob(item);
    const leases = await Promise.all([store.claimJobNotification(item.id, NOW, NOW - 60_000), store.claimJobNotification(item.id, NOW, NOW - 60_000)]);
    expect(leases.sort()).toEqual([0, 1]);
    await store.updateJob(item.id, { notify: 'failed', notifyClaimAt: '' });
    expect(await store.claimJobNotification(item.id, NOW + 1_000, NOW - 59_000)).toBe(2);
    await store.updateJob(item.id, { notify: 'sent' });
    expect(await store.claimJobNotification(item.id, NOW + 500_000, NOW + 400_000)).toBe(0);
    expect(await store.getJob(item.id)).toMatchObject({ notify: 'sent', notifyAttempts: 2 });
  });
});
