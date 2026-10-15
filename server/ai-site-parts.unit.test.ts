import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StudentProjects, inspectProject, parseProject } from './ai/projects.js';
import { MemoryAiStore } from './ai/store.js';
import type { AiJob } from './ai/types.js';
import { ADMIN_ID, aiSchool, configureMock } from './ai/testing/app-harness.js';
import { MockProviderServer } from './ai/testing/mock-provider.js';
import { DEV_IDS } from './data/seed.js';

const STUDENT = DEV_IDS.user;
const KEY = 'test-key-1234567890';
// One run's time limit for these tests; production keeps 250 s inside the 300 s function.
const BUDGET_MS = 1_500;
let mock: MockProviderServer;
const schools: Array<ReturnType<typeof aiSchool>> = [];
beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

async function ready() {
  const school = aiSchool({ generationBudgetMs: BUDGET_MS }); schools.push(school);
  const admin = await school.as(ADMIN_ID);
  await configureMock(admin, mock, KEY, ['agent']);
  await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 600_000 });
  return { school, student: await school.as(STUDENT) };
}
const html = (title: string, body: string) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;

describe('building a site in parts', () => {
  it('saves a draft that still links to pages it will write, adds files without dropping others, and refuses to publish until complete', async () => {
    const store = new MemoryAiStore();
    const projects = new StudentProjects(store, () => new Date('2026-10-15T12:00:00Z'));
    const job = { studentId: STUDENT, conversationId: 'c1', files: [] } as unknown as AiJob;
    const made = await projects.create(job, { title: 'Візитка', kind: 'website', files: [{ path: 'index.html', content: html('Візитка', '<a href="about.html">Про мене</a><link rel="stylesheet" href="styles.css">') }] });
    expect(made.status).not.toBe('error');
    expect(made.content).toContain('Ще бракує файлів');
    const id = made.file!.id;
    await expect(projects.publish(STUDENT, id)).rejects.toThrow('не знайдено');
    const added = await projects.write(job, { projectId: id, files: [{ path: 'styles.css', content: 'body{margin:0}' }, { path: 'about.html', content: html('Про мене', '<a href="index.html">Головна</a>') }] });
    expect(added.content).toContain('Файли: index.html, styles.css, about.html');
    expect(added.content).not.toContain('Ще бракує');
    expect(added.file!.id).toBe(id);
    expect((await projects.publish(STUDENT, id)).url).toContain(id);
    const removed = await projects.write(job, { projectId: id, remove: ['styles.css'] });
    expect(removed.content).toContain('Ще бракує');
  });

  it('still blocks real errors, keeps other students out, and validates every written file', async () => {
    const store = new MemoryAiStore();
    const projects = new StudentProjects(store, () => new Date());
    const job = { studentId: STUDENT, conversationId: 'c1', files: [] } as unknown as AiJob;
    const broken = await projects.create(job, { title: 'X', kind: 'website', files: [{ path: 'index.html', content: html('X', '<script>const = ;</script>') }] });
    expect(broken.status).toBe('error');
    expect(broken.content).toContain('синтаксична');
    const made = await projects.create(job, { title: 'X', kind: 'website', files: [{ path: 'index.html', content: html('X', '<p>ok</p>') }] });
    const stranger = { studentId: DEV_IDS.project, conversationId: 'c2', files: [] } as unknown as AiJob;
    expect((await projects.write(stranger, { projectId: made.file!.id, files: [{ path: 'a.html', content: 'x' }] })).status).toBe('error');
    expect((await projects.write(job, { projectId: made.file!.id, files: [{ path: '../evil.html', content: 'x' }] })).status).toBe('error');
    expect((await projects.write(job, { projectId: made.file!.id, files: [] })).status).toBe('error');
    expect(inspectProject(parseProject({ kind: 'website', files: [{ path: 'index.html', content: html('X', '<a href="b.html">b</a>') }] })).missing).toHaveLength(1);
  });
});

describe('the time limit and automatic continuation', () => {
  it('a run cut off after saving work is continued automatically and finishes the site', async () => {
    const { student } = await ready();
    const first = await student.send('[parts-fixture] Зроби сайт-візитку', { mode: 'agent' });
    expect(first.done.status).toBe('interrupted');
    expect(first.done.resume).toEqual({ round: 1, max: 3 });
    expect(first.done.error).toMatchObject({ code: 'AI_TIME_CONTINUE' });
    expect(first.done.error.message).toContain('продовжую автоматично (1 з 3)');
    expect(first.done.message).toMatchObject({ continued: true, content: 'Частину зроблено — файли нижче.' });
    const project = first.done.message.files[0];
    expect(project.preview.items).toEqual(['index.html', 'styles.css']);

    // The request and the partial answer are in the chat, so the continuation has context.
    const conversationId = first.done.conversationId;
    const before = await student.call('GET', `/api/v1/ai/conversations/${conversationId}`);
    expect(before.json().messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
    expect(before.json().job.resume).toEqual({ round: 1, max: 3 });

    const next = await student.send('', { conversationId, continueJobId: first.done.jobId });
    expect(next.done.status).toBe('complete');
    expect(next.done.userMessage).toMatchObject({ auto: true });
    expect(next.done.message.content).toContain('Сайт-візитку дописано');
    expect(next.done.message.files[0]).toMatchObject({ id: project.id, preview: { items: ['index.html', 'styles.css', 'about.html'] } });
    expect(next.done.message.steps.map((step: { label: string }) => step.label)).toEqual(expect.arrayContaining(['Читаю проєкт', 'Дописано about.html']));

    // The same continuation asked again (another tab, a reopened app) joins it instead of running twice.
    const again = await student.send('', { conversationId, continueJobId: first.done.jobId });
    expect(again.response.statusCode).toBe(200);
    const after = await student.call('GET', `/api/v1/ai/conversations/${conversationId}`);
    expect(after.json().messages).toHaveLength(4);
    expect(after.json().job.resume).toBeNull();
  }, 30_000);

  it('a continuation is refused for a job that did not stop at the time limit or is no longer the latest', async () => {
    const { student } = await ready();
    const done = await student.send('[website-fixture]', { mode: 'agent' });
    expect(done.done.status).toBe('complete');
    const refused = await student.send('', { conversationId: done.done.conversationId, continueJobId: done.done.jobId });
    expect(refused.response.statusCode).toBe(409);
    expect(refused.response.json().error.code).toBe('AI_RESUME_STALE');
  }, 30_000);

  it('says honestly that nothing was saved and offers a retry, without promising a continuation', async () => {
    const { student } = await ready();
    const run = await student.send('[stall-fixture] Зроби великий сайт', { mode: 'agent' });
    expect(run.error).toMatchObject({ code: 'AI_TIME_LIMIT', resume: null });
    expect(run.error.message).toContain('нічого не встигло зберегтися');
    expect(run.error.message).toContain('Спробувати ще раз');
    expect(run.error.message).not.toContain('Зроблене збережено');
  }, 30_000);

  it('stops continuing automatically after three continuations and asks the student instead', async () => {
    const { student } = await ready();
    let run = await student.send('[endless-fixture] Пиши без кінця', { mode: 'agent' });
    const conversationId = run.done.conversationId;
    for (let round = 1; round <= 3; round += 1) {
      expect(run.done.resume).toEqual({ round, max: 3 });
      run = await student.send('', { conversationId, continueJobId: run.done.jobId });
    }
    expect(run.done.resume).toBeNull();
    expect(run.done.error).toMatchObject({ code: 'AI_TIME_LIMIT' });
    expect(run.done.error.message).toContain('за 4 запуски');
    expect(run.done.error.message).toContain('продовжуй');
  }, 60_000);
});
