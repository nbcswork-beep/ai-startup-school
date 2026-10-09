import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { createAssignedPilotState } from './data/assigned-pilot.test-fixture.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MemoryPilotRuntimeStore } from './data/pilot-runtime-store.js';
import { PostgresRepository } from './data/postgres-repository.js';
import { DEV_IDS, PILOT } from './data/seed.js';
import { MockAiProvider } from './services/ai-provider.js';
import type { HomeworkSummaryDto } from './types/domain.js';

const TEACHER = '12000000-0000-4000-8000-000000000001';
const ADMIN = '14000000-0000-4000-8000-000000000001';
const apps: FastifyInstance[] = [];
const video = { kind: 'link' as const, title: 'Відео до домашнього завдання', url: 'https://example.test/lesson-video?part=1&lesson=2' };
const document = { kind: 'document' as const, title: 'Інструкція', url: 'https://example.test/instructions.pdf' };

async function client(repository: MemoryRepository, userId: string) {
  const env = loadEnv({ NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'homework-resources-test-only', DEV_USER_ID: userId });
  const jwt = await createJwtService(env);
  const app = await buildApp({ env, repository, jwt, aiProvider: new MockAiProvider() });
  apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
  expect(login.statusCode).toBe(200);
  return { app, headers: { authorization: `Bearer ${login.json().accessToken}` } };
}

function renderHomework(homework: HomeworkSummaryDto) {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('const icons ='), source.indexOf('const app ='));
  const icons = source.slice(source.indexOf('function arrowIcon()'), source.indexOf('function artifactIcon('));
  const escape = source.slice(source.indexOf('function escapeHtml('), source.indexOf('function loadingView('));
  const page = source.slice(source.indexOf('function homeworkPage()'), source.indexOf('function ai()'));
  return vm.runInNewContext(`${helpers}\n${icons}\n${escape}\n${page}\nhomeworkPage()`, {
    currentHomework: homework, data: { schedule: { timezone: 'Europe/Kyiv' } }, backLabel: () => 'Навчання', URL, Intl, Date
  }) as string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close()));
});

describe('homework resources reach students', () => {
  it('carries a teacher video through persistence, Student APIs and the existing homework template', async () => {
    const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const teacher = await client(repository, TEACHER);
    const created = await teacher.app.inject({ method: 'POST', url: '/api/v1/teacher/homework', headers: teacher.headers, payload: {
      groupId: PILOT.groupId, courseId: DEV_IDS.course, title: 'Завдання з відео', instructions: 'Переглянь матеріал і дай відповідь.',
      publishAt: new Date(Date.now() - 1000).toISOString(), status: 'published', xpReward: 10, resources: [video, document]
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const persisted = (await repository.getTeacherWorkspace(TEACHER)).homework.find(item => item.id === id)!;
    expect(persisted.resources).toEqual([expect.objectContaining(video), expect.objectContaining(document)]);

    const restarted = new MemoryRepository(undefined, { runtimeStore: runtime });
    const student = await client(restarted, DEV_IDS.user);
    const detail = await student.app.inject({ method: 'GET', url: `/api/v1/homework/${id}`, headers: student.headers });
    expect(detail.statusCode).toBe(200);
    const dto = detail.json() as HomeworkSummaryDto;
    expect(dto.resources).toEqual(persisted.resources);
    const list = await student.app.inject({ method: 'GET', url: '/api/v1/homework', headers: student.headers });
    expect(list.json().find((item: HomeworkSummaryDto) => item.id === id).resources).toEqual(persisted.resources);
    const bootstrap = await student.app.inject({ method: 'GET', url: '/api/v1/bootstrap', headers: student.headers });
    expect(bootstrap.json().homework.find((item: HomeworkSummaryDto) => item.id === id).resources).toEqual(persisted.resources);
    expect(bootstrap.json().home.homeworkDue.resources).toEqual(persisted.resources);
    const html = renderHomework(dto);
    expect(html).toContain('МАТЕРІАЛИ ДО ЗАВДАННЯ');
    expect(html).toContain(video.title);
    expect(html).toContain('data-external="https://example.test/lesson-video?part=1&amp;lesson=2"');
    expect(html).toContain(document.title);
  });

  it('retains draft publishing and group boundaries for attached material', async () => {
    const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const homework = await repository.createHomework(TEACHER, { groupId: PILOT.groupId, courseId: DEV_IDS.course, title: 'Чернетка з відео', instructions: 'Завдання', status: 'draft', xpReward: 0, resources: [video] });
    const student = await client(repository, DEV_IDS.user);
    const get = () => student.app.inject({ method: 'GET', url: `/api/v1/homework/${homework.id}`, headers: student.headers });
    expect((await get()).statusCode).toBe(404);
    await repository.publishHomework(TEACHER, homework.id, new Date().toISOString());
    expect((await get()).json().resources).toEqual([expect.objectContaining(video)]);
    const group = (await runtime.read()).groups.find(item => item.id === PILOT.groupId)!;
    await repository.setGroupStudent(ADMIN, group.id, DEV_IDS.user, false, group.version, 'resource-boundary-test');
    expect((await get()).statusCode).toBe(404);
    expect(JSON.stringify(await repository.listHomework(DEV_IDS.user))).not.toContain(video.url);
  });

  it('returns detached resource data and supports legacy homework without resources', async () => {
    const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const homework = await repository.createHomework(TEACHER, { groupId: PILOT.groupId, courseId: DEV_IDS.course, title: 'Відео', instructions: 'Завдання', status: 'published', publishAt: new Date().toISOString(), xpReward: 0, resources: [video] });
    const dto = (await repository.listHomework(DEV_IDS.user)).find(item => item.id === homework.id)!;
    dto.resources![0]!.title = 'Client edit';
    expect((await repository.listHomework(DEV_IDS.user)).find(item => item.id === homework.id)!.resources![0]!.title).toBe(video.title);
    await runtime.mutate(state => { delete state.homework.find(item => item.id === homework.id)!.resources; });
    expect((await repository.listHomework(DEV_IDS.user)).find(item => item.id === homework.id)!.resources).toEqual([]);
    expect(renderHomework({ ...dto, resources: undefined } as unknown as HomeworkSummaryDto)).not.toContain('homework-materials');
  });

  it('renders only safe existing links and escapes resource names', () => {
    const dto: HomeworkSummaryDto = { id: 'homework', title: 'Завдання', instructions: 'Інструкції', publishedAt: '', dueAt: null, xpReward: 0, classTitle: null, state: 'not_started', latestSubmission: null, resources: [
      { id: 'safe', ...video, title: '<script>alert(1)</script>' },
      { id: 'unsafe', ...video, title: 'Unsafe resource', url: 'javascript:alert(1)' },
      { id: 'missing', ...video, title: 'Missing URL', url: null }
    ] };
    const html = renderHomework(dto);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Unsafe resource');
    expect(html).not.toContain('Missing URL');
    expect(html).toContain('type="button" class="secondary-btn" data-external=');
  });

  it('loads PostgreSQL resources only for visible homework and keeps their order', async () => {
    const rows = ['first', 'second'].map(id => ({ id, title: id, instructions: 'Task', publish_at: new Date(), due_at: null, xp_reward: 0, class_title: null, submission_id: null }));
    const materials = [
      { id: 'video', homework_id: 'first', ...video, external_url: video.url },
      { id: 'document', homework_id: 'first', ...document, external_url: document.url },
      { id: 'other', homework_id: 'second', ...video, external_url: 'https://example.test/second' }
    ];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('from public.homework h join')) return { rows };
      if (sql.includes('from public.homework_resources')) {
        expect(values).toEqual([['first', 'second']]);
        expect(sql).toContain('order by homework_id,position');
        return { rows: materials };
      }
      return { rows: [] };
    });
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as never);
    const repository = new PostgresRepository('postgres://unused.test/isolated', false);
    const homework = await repository.listHomework(DEV_IDS.user);
    expect(homework[0]!.resources).toEqual([expect.objectContaining(video), expect.objectContaining(document)]);
    expect(homework[1]!.resources).toEqual([expect.objectContaining({ url: 'https://example.test/second' })]);
    expect(query.mock.calls.some(([sql]) => sql === 'set local role authenticated')).toBe(true);
  });

  it('does not read unrelated PostgreSQL resources when no homework is visible', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as never);
    const repository = new PostgresRepository('postgres://unused.test/isolated', false);
    expect(await repository.listHomework(DEV_IDS.user)).toEqual([]);
    expect(query.mock.calls.flat().join(' ')).not.toContain('homework_resources');
  });
});
