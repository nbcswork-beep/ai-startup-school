import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAdapter } from './ai/adapters.js';
import { projectFragment } from './ai/project-stream.js';
import { StudentProjects, projectFromContent, type ProjectStreamState } from './ai/projects.js';
import { MemoryAiStore } from './ai/store.js';
import type { AiJob } from './ai/types.js';
import { ADMIN_ID, aiSchool, configureMock } from './ai/testing/app-harness.js';
import { MockProviderServer, STREAMED_PAGE, STREAMED_PREFIX } from './ai/testing/mock-provider.js';
import { DEV_IDS } from './data/seed.js';

const STUDENT = DEV_IDS.user, KEY = 'test-key-1234567890';
const job = () => ({ studentId: STUDENT, conversationId: 'c1', files: [] }) as unknown as AiJob;
const setup = () => { const store = new MemoryAiStore(); return { store, projects: new StudentProjects(store, () => new Date()) }; };
const raw = (content: string, path = 'index.html') => JSON.stringify({ title: 'Stream', kind: 'website', files: [{ path, content }] });

describe('partial JSON project arguments', () => {
  it('preserves only received text across quotes, escapes, braces, Unicode and line breaks', () => {
    const code = 'const text="quotes\\\\ and {braces}";\n<p>Привіт 🚀</p>\t';
    const encoded = raw(code);
    for (let end = encoded.indexOf('content') + 11; end < encoded.length; end++) {
      const fragment = projectFragment(encoded.slice(0, end), 'create_project');
      if (fragment) expect(code.startsWith(fragment.files[0]!.content)).toBe(true);
    }
    expect(projectFragment(encoded, 'create_project')?.files).toEqual([{ path: 'index.html', content: code }]);
    expect(projectFragment('{"kind":"website","files":[{"path":"index.ht', 'create_project')).toBeNull();
    expect(projectFragment('x'.repeat(1_000_001), 'create_project')).toBeNull();
    expect(projectFragment('{"files":[{"path":"x","content":"ok\\uD83D', 'create_project')?.files[0]!.content).toBe('ok');
    expect(projectFragment('{"__proto__":{"polluted":true},"files":[{"path":"x","content":"ok"}]}', 'create_project')?.files[0]!.content).toBe('ok');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('draft checkpoints and exact append offsets', () => {
  it('saves CSS before index.html or kind arrive, then resumes the same website', async () => {
    const { store, projects } = setup(), state: ProjectStreamState = {}, task = job();
    const prefix = '{"files":[{"path":"styles.css","content":"body{color:';
    const file = await projects.checkpoint(task, 'create_project', prefix, state);
    expect(file).not.toBeNull();
    task.files.push(file!);
    const record = await store.getGeneratedFile(file!.id);
    expect(projectFromContent(record!.content).files).toEqual([{ path: 'styles.css', content: 'body{color:' }]);
    expect(record).toMatchObject({ projectKindPending: true });
    expect(JSON.parse((await projects.read(STUDENT, { projectId: file!.id })).content)).toMatchObject({ kind: null });
    await expect(projects.publish(STUDENT, file!.id)).rejects.toThrow();
    expect((await projects.write(task, { projectId: file!.id, files: [{ path: 'styles.css', content: 'body{color:red}' }] })).status).toBe('error');
    const result = await projects.write(task, { projectId: file!.id, kind: 'website', files: [{ path: 'styles.css', content: 'body{color:red}' }] });
    expect(result.status).not.toBe('error');
    expect(result.file!.id).toBe(file!.id);
    expect((await store.getGeneratedFile(file!.id))!.incompleteFiles).toContain('index.html');
    await expect(projects.publish(STUDENT, file!.id)).rejects.toThrow();
    const complete = await projects.write(task, { projectId: file!.id, files: [{ path: 'index.html', content: STREAMED_PAGE }] });
    expect(complete.status).not.toBe('error');
    expect((await store.getGeneratedFile(file!.id))!.projectKindPending).toBeUndefined();
    expect((await store.getGeneratedFile(file!.id))!.incompleteFiles).toBeUndefined();
    expect(projectFromContent((await store.getGeneratedFile(file!.id))!.content).kind).toBe('website');
    await projects.publish(STUDENT, file!.id);
    await projects.checkpoint(task, 'write_project_files', JSON.stringify({ projectId: file!.id, kind: 'code', files: [{ path: 'styles.css', content: 'body{color:blue}' }] }), {});
    expect(projectFromContent((await store.getGeneratedFile(file!.id))!.content).kind).toBe('website');
  });

  it('saves a website whose first streamed file is CSS, and accepts late metadata on the same draft', async () => {
    const { store, projects } = setup(), state: ProjectStreamState = {}, task = job();
    const file = await projects.checkpoint(task, 'create_project', '{"kind":"website","files":[{"path":"styles.css","content":"body{', state);
    expect(file).not.toBeNull();
    expect((await store.getGeneratedFile(file!.id))!.incompleteFiles).toContain('index.html');
    const lateState: ProjectStreamState = {};
    const raw = '{"files":[{"path":"index.html","content":' + JSON.stringify(STREAMED_PAGE) + '}],"kind":"website","title":"Late"}';
    const early = await projects.checkpoint(task, 'create_project', raw.slice(0, raw.indexOf(',"kind"')), lateState);
    const late = await projects.checkpoint(task, 'create_project', raw, lateState);
    expect(late!.id).toBe(early!.id);
    expect(projectFromContent((await store.getGeneratedFile(late!.id))!.content).kind).toBe('website');
    expect((await store.getGeneratedFile(late!.id))!.projectKindPending).toBeUndefined();
  });

  it('updates one project, blocks incomplete publication, then appends once and validates it', async () => {
    const { store, projects } = setup(), state: ProjectStreamState = {}, task = job();
    const first = await projects.checkpoint(task, 'create_project', raw(STREAMED_PREFIX).slice(0, -4), state);
    expect(first!.preview).toMatchObject({ incomplete: true });
    task.files.push(first!);
    const later = await projects.checkpoint(task, 'create_project', raw(STREAMED_PREFIX + 'x').slice(0, -4), state);
    expect(later!.id).toBe(first!.id);
    await expect(projects.publish(STUDENT, first!.id)).rejects.toThrow('ще дописується');
    // A new request resumes from the actual saved length, never from an old offset.
    const current = await store.getGeneratedFile(first!.id);
    const prefix = projectFromContent(current!.content).files[0]!.content;
    const stale = await projects.append(task, { projectId: first!.id, path: 'index.html', offset: 0, content: 'x', complete: false });
    expect(stale.status).toBe('error');
    const replaced = await projects.write(task, { projectId: first!.id, files: [{ path: 'index.html', content: STREAMED_PREFIX + '</script></body></html>' }] });
    // A replacement containing broken script is rejected and the checkpoint stays recoverable.
    expect(replaced.status).toBe('error');
    expect(prefix).toBe(STREAMED_PREFIX + 'x');
    const complete = await projects.write(task, { projectId: first!.id, files: [{ path: 'index.html', content: STREAMED_PAGE }] });
    expect(complete.file!.id).toBe(first!.id);
    expect((await store.getGeneratedFile(first!.id))!.incompleteFiles).toBeUndefined();
    await projects.publish(STUDENT, first!.id);
    const appendState: ProjectStreamState = {};
    const args = { projectId: first!.id, path: 'index.html', offset: STREAMED_PAGE.length, content: '\n<!-- done -->', complete: true };
    await projects.checkpoint(task, 'append_project_file', JSON.stringify(args), appendState);
    // Checkpoint never changes the previously published snapshot.
    expect((await projects.asset(first!.id, 'index.html')).content).toBe(STREAMED_PAGE);
    const appended = await projects.append(task, args, appendState);
    expect(appended.status).not.toBe('error');
    expect(projectFromContent((await store.getGeneratedFile(first!.id))!.content).files[0]!.content).toBe(STREAMED_PAGE + args.content);
    expect((await store.getGeneratedFile(first!.id))!.incompleteFiles).toBeUndefined();
    expect((await projects.append(task, args)).status).toBe('error');
  });

  it('retains publication and ownership, rejects unsafe paths and stale concurrent checkpoints', async () => {
    const { store, projects } = setup(), task = job();
    const made = await projects.create(task, { title: 'X', kind: 'website', files: [{ path: 'index.html', content: STREAMED_PAGE }] });
    const id = made.file!.id;
    await projects.publish(STUDENT, id);
    const state: ProjectStreamState = {};
    const update = (code: string) => JSON.stringify({ projectId: id, files: [{ path: 'index.html', content: code }] }).slice(0, -4);
    await projects.checkpoint(task, 'write_project_files', update(STREAMED_PREFIX), state);
    expect((await projects.asset(id, 'index.html')).content).toBe(STREAMED_PAGE);
    await projects.write(task, { projectId: id, files: [{ path: 'index.html', content: STREAMED_PAGE + '<!-- edit -->' }] });
    expect(await projects.checkpoint(task, 'write_project_files', update(STREAMED_PREFIX + 'x'), state)).toBeNull();
    expect(await projects.checkpoint({ ...task, studentId: 'another-student' }, 'write_project_files', update('bad'), {})).toBeNull();
    expect(await projects.checkpoint(task, 'create_project', raw('bad', '../x.html'), {})).toBeNull();
    expect(await projects.checkpoint(task, 'create_project', raw('bad', '.env'), {})).toBeNull();
    expect(await projects.checkpoint(task, 'publish_project', update('bad'), {})).toBeNull();
    expect((await store.getGeneratedFile(id))!.content).toContain('<!-- edit -->');
  });
});

let mock: MockProviderServer;
const schools: Array<ReturnType<typeof aiSchool>> = [];
beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

describe('a provider stream cut off inside a file', () => {
  it.each(['agent', 'claude-agent'])('%s resumes CSS received before metadata through the full API', async model => {
    const school = aiSchool({ generationBudgetMs: 1500 }); schools.push(school);
    const admin = await school.as(ADMIN_ID);
    await configureMock(admin, mock, KEY, [model], model === 'claude-agent' ? 'anthropic' : 'openai');
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 600_000 });
    const student = await school.as(STUDENT);
    const first = await student.send('[late-metadata-fixture] Зроби сайт', { mode: 'agent' });
    expect(first.done.status).toBe('interrupted');
    expect(first.done.resume).toEqual({ round: 1, max: 3 });
    const file = first.done.message.files[0];
    expect(file.preview.incomplete).toBe(true);
    expect(projectFromContent((await school.aiStore.getGeneratedFile(file.id))!.content).files).toEqual([{ path: 'styles.css', content: 'body{color:' }]);
    const next = await student.send('', { conversationId: first.done.conversationId, continueJobId: first.done.jobId });
    expect(next.done.status).toBe('complete');
    expect(next.done.message.files).toHaveLength(1);
    expect(next.done.message.files[0].id).toBe(file.id);
    const record = await school.aiStore.getGeneratedFile(file.id);
    expect(record!.projectKindPending).toBeUndefined();
    expect(record!.incompleteFiles).toBeUndefined();
    const projects = new StudentProjects(school.aiStore, () => new Date());
    const published = await projects.publish(STUDENT, file.id);
    const site = await student.app.inject({ method: 'GET', url: published.url });
    expect(site.statusCode).toBe(200);
    expect(site.body).toBe(STREAMED_PAGE);
  }, 30000);

  it.each(['openai', 'anthropic'] as const)('%s exposes code before the tool call ends, even when the stream is aborted', async protocol => {
    const controller = new AbortController();
    let latest = '', completed = false;
    const adapter = createAdapter({ protocol, baseUrl: protocol === 'openai' ? mock.baseUrl : mock.anthropicBaseUrl, apiKey: KEY, headers: {} });
    const error = await (async () => {
      for await (const event of adapter.stream({ model: protocol === 'openai' ? 'agent' : 'claude-agent', messages: [{ role: 'user', content: '[streamed-site-fixture]' }], maxOutputTokens: 1024, signal: controller.signal, tools: [{ name: 'create_project', description: 'create', parameters: { type: 'object' } }] })) {
        if (event.type === 'tool_call') completed = true;
        if (event.type === 'tool_call_delta') { latest = event.call.arguments; if (latest.includes('content')) controller.abort(); }
      }
    })().catch(error => error);
    expect(error.code).toBe('aborted');
    expect(latest).toContain('content');
    expect(completed).toBe(false);
  });

  it('saves code before deadline, resumes through the API and publishes the finished site without duplicate bytes', async () => {
    const school = aiSchool({ generationBudgetMs: 1500 }); schools.push(school);
    const admin = await school.as(ADMIN_ID);
    await configureMock(admin, mock, KEY, ['agent']);
    await admin.call('POST', `/api/v1/admin/ai/tokens/students/${STUDENT}`, { op: 'add', amount: 600_000 });
    const student = await school.as(STUDENT);
    const first = await student.send('[streamed-site-fixture] Зроби сайт', { mode: 'agent' });
    expect(first.done.status).toBe('interrupted');
    expect(first.done.resume).toEqual({ round: 1, max: 3 });
    expect(first.done.message.usage.output).toBeGreaterThan(0);
    const file = first.done.message.files[0];
    expect(file.preview.incomplete).toBe(true);
    expect(projectFromContent((await school.aiStore.getGeneratedFile(file.id))!.content).files[0]!.content).toBe(STREAMED_PREFIX);
    const projects = new StudentProjects(school.aiStore, () => new Date());
    await expect(projects.publish(STUDENT, file.id)).rejects.toThrow('ще дописується');
    const link = await student.call('POST', `/api/v1/ai/files/${file.id}/link`);
    const preview = await student.app.inject({ method: 'GET', url: link.json().previewUrl });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('Код уже збережено');
    expect(preview.body).not.toContain('document.querySelector');
    expect(preview.headers['content-security-policy']).toContain('sandbox');
    const next = await student.send('', { conversationId: first.done.conversationId, continueJobId: first.done.jobId });
    expect(next.done.status).toBe('complete');
    expect(next.done.resume).toBeNull();
    expect(next.done.message.files).toHaveLength(1);
    expect(next.done.message.files[0].id).toBe(file.id);
    expect(next.done.message.files[0].preview.incomplete).not.toBe(true);
    const record = await school.aiStore.getGeneratedFile(file.id);
    expect(projectFromContent(record!.content).files[0]!.content).toBe(STREAMED_PAGE);
    expect(record!.incompleteFiles).toBeUndefined();
    const completePreview = await student.app.inject({ method: 'GET', url: link.json().previewUrl });
    expect(completePreview.body).toBe(STREAMED_PAGE);
    const published = await projects.publish(STUDENT, file.id);
    const site = await student.app.inject({ method: 'GET', url: published.url });
    expect(site.statusCode).toBe(200);
    expect(site.body).toBe(STREAMED_PAGE);
  }, 30000);
});
