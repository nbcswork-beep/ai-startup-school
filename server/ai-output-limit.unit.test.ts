import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatTurn, StreamEvent } from './ai/adapters.js';
import { runAgent } from './ai/agent/run.js';
import { ADMIN_ID, aiSchool, configureMock } from './ai/testing/app-harness.js';
import { MockProviderServer } from './ai/testing/mock-provider.js';
import { DEV_IDS } from './data/seed.js';

const STUDENT = DEV_IDS.user;
const KEY = 'test-key-1234567890';
let mock: MockProviderServer;
const schools: Array<ReturnType<typeof aiSchool>> = [];
beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

async function ready() {
  const school = aiSchool(); schools.push(school);
  const admin = await school.as(ADMIN_ID);
  const { ids } = await configureMock(admin, mock, KEY, ['cutoff-empty', 'cutoff-text', 'cutoff-tool']);
  await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 300_000 });
  return { student: await school.as(STUDENT), ids };
}
const capped = () => mock.chatRequests().filter(request => Number(request.body?.max_tokens ?? request.body?.max_completion_tokens) > 600).length;

describe('answers cut off by the output-token cap', () => {
  it('chat: an answer that spent the whole cap on reasoning names the limit instead of «порожня відповідь»', async () => {
    const { student, ids } = await ready();
    const run = await student.send('Зроби сайт-візитку', { modelId: ids['cutoff-empty'] });
    expect(run.error).toMatchObject({ code: 'AI_OUTPUT_LIMIT', status: 'error' });
    expect(run.error.message).toContain('1024 токенів');
    expect(run.error.message).toContain('Макс. вихідних токенів');
    expect(run.error.message).not.toContain('порожню');
  }, 30000);

  it('chat: a partial answer is kept and marked as cut off', async () => {
    const { student, ids } = await ready();
    const run = await student.send('Поясни докладно', { modelId: ids['cutoff-text'] });
    expect(run.done.status).toBe('interrupted');
    expect(run.done.message.content).toContain('Ось початок довгої відповіді');
    expect(run.done.error).toMatchObject({ code: 'AI_OUTPUT_LIMIT' });
    expect(run.done.error.message).toContain('Відповідь обрізано');
  }, 30000);

  it('agent: a website cut off inside create_project is checkpointed and offered for continuation', async () => {
    const { student, ids } = await ready();
    const before = capped();
    const run = await student.send('Зроби сайт-візитку з анімаціями', { mode: 'agent', modelId: ids['cutoff-tool'] });
    expect(run.done.status).toBe('interrupted');
    expect(run.done.resume).toEqual({ round: 1, max: 3 });
    expect(run.done.message.files[0].preview.incomplete).toBe(true);
    expect(capped() - before).toBe(1); // one call: the truncated tool call is not sent back for a retry
    const files = await student.call('GET', `/api/v1/ai/conversations/${run.done.conversationId}`);
    expect(JSON.stringify(files.json())).toContain('"format":"project"');
  }, 30000);
});

describe('agent loop and the output cap', () => {
  const turns = (): ChatTurn[] => [{ role: 'system', content: 'Ти помічник.' }, { role: 'user', content: 'Зроби сайт-візитку' }];
  const usage = { inputTokens: 40, outputTokens: 900, reasoningTokens: 900, cachedTokens: 0, cacheWriteTokens: 0 };
  const run = (budget: number, events: StreamEvent[], seen: { cap?: number } = {}) => runAgent({
    turns: turns(), tools: [], maxSteps: 4, budget, maxOutputTokens: 8192, maxInputTokens: 16000, signal: new AbortController().signal,
    async *call(_turns, _tools, cap) { seen.cap = cap; for (const event of events) yield event; },
    emit: () => {}, steps: [], saveSteps: async () => {}, addFile: async () => {}, confirm: async () => true,
    abortReason: () => null, recordError: async () => {}
  });

  it('names the model limit when the cap was the model', async () => {
    const result = await run(100_000, [{ type: 'usage', usage }, { type: 'finish', reason: 'length' }]);
    expect(result.status).toBe('error');
    expect(result.notice).toMatchObject({ code: 'AI_OUTPUT_LIMIT' });
    expect(result.notice?.message).toContain('8192 токенів');
  });

  it('blames the student budget, not the model, when the budget was the smaller cap', async () => {
    const seen: { cap?: number } = {};
    const result = await run(3_000, [{ type: 'usage', usage }, { type: 'finish', reason: 'max_tokens' }], seen);
    expect(seen.cap).toBeLessThan(8192);
    expect(result.notice).toMatchObject({ code: 'AI_ANSWER_BUDGET' });
  });

  it('keeps a partial answer as interrupted', async () => {
    const result = await run(100_000, [{ type: 'text', text: 'Початок' }, { type: 'usage', usage }, { type: 'finish', reason: 'length' }]);
    expect(result).toMatchObject({ status: 'interrupted', text: 'Початок', notice: { code: 'AI_OUTPUT_LIMIT' } });
  });

  it('leaves a normal finish untouched', async () => {
    const result = await run(100_000, [{ type: 'text', text: 'Готово' }, { type: 'usage', usage }, { type: 'finish', reason: 'stop' }]);
    expect(result).toMatchObject({ status: 'complete', text: 'Готово', notice: null });
  });
});
