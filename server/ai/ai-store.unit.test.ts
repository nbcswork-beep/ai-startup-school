import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAiStore, RedisAiStore, type AiStore, type LedgerDraft, type ReserveInput } from './store.js';
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
