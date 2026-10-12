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
import { HOMEWORK_FILE_ACCEPT, formatFileSize } from '../src/homework-uploads.js';

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

function renderHomework(homework: HomeworkSummaryDto, extraData: Record<string, unknown> = {}) {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('const icons ='), source.indexOf('const app ='));
  const icons = source.slice(source.indexOf('function arrowIcon()'), source.indexOf('function artifactIcon('));
  const escape = source.slice(source.indexOf('function escapeHtml('), source.indexOf('function loadingView('));
  const page = source.slice(source.indexOf('function homeworkPage()'), source.indexOf('function ai()'));
  return vm.runInNewContext(`${helpers}\n${icons}\n${escape}\n${page}\nhomeworkPage()`, {
    currentHomework: homework, data: { schedule: { timezone: 'Europe/Kyiv' }, ...extraData }, backLabel: () => 'Навчання', URL, Intl, Date, Map, Set,
    // main.js imports these from homework-uploads.js; the sliced template needs them in scope.
    formatFileSize, HOMEWORK_FILE_ACCEPT
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
    expect(html).toContain('ВІДЕО ДО ЗАВДАННЯ');
    const videos = html.match(/<section class="lesson-section homework-videos">([\s\S]*?)<\/section>/)![1]!;
    const materials = html.match(/<section class="lesson-section homework-materials">([\s\S]*?)<\/section>/)![1]!;
    expect(videos).toContain(`Відео — ${video.title}`);
    expect(videos).not.toContain(document.title);
    expect(materials).toContain(document.title);
    expect(materials).not.toContain(video.title);
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
    expect(html).toContain('type="button" class="btn btn--secondary btn--row btn--block homework-material-btn" data-external=');
  });

  it.each([
    ['https://youtu.be/lesson123', 'Основи бізнесу', 'link', true],
    ['https://www.youtube.com/watch?v=lesson123&list=course', 'Основи бізнесу', 'link', true],
    ['https://www.youtube.com/shorts/lesson123', 'Основи бізнесу', 'link', true],
    ['https://player.vimeo.com/video/123456', 'Основи бізнесу', 'link', true],
    ['https://www.loom.com/share/lesson123', 'Основи бізнесу', 'link', true],
    ['https://example.test/lesson.mp4?download=1', 'Основи бізнесу', 'file', true],
    ['https://drive.google.com/file/d/lesson/view', 'Відео уроку', 'link', true],
    ['https://example.test/lesson', 'Видео урока', 'link', true],
    ['https://example.test/lesson', 'Lesson video', 'other', true],
    ['https://example.test/guide.pdf', 'Відео: інструкція', 'link', false],
    ['https://example.test/guide', 'Video editing guide', 'document', false],
    ['https://youtube.com.example.test/watch?v=lesson123', 'Матеріал', 'link', false],
    ['https://www.youtube.com/@school', 'Канал школи', 'link', false],
    ['https://www.youtube.com/watch?v=', 'Матеріал', 'link', false],
    ['https://example.test/guide', 'Інструкція', 'link', false]
  ])('separates existing attachment %s (%s) without changing its link', (url, title, kind, isVideo) => {
    const dto: HomeworkSummaryDto = { id: 'homework', title: 'Завдання', instructions: 'Інструкції', publishedAt: '', dueAt: null, xpReward: 0, classTitle: null, state: 'not_started', latestSubmission: null, resources: [
      { id: 'attachment', kind: kind as NonNullable<HomeworkSummaryDto['resources']>[number]['kind'], title, url }
    ] };
    const html = renderHomework(dto);
    expect(html.includes('homework-videos')).toBe(isVideo);
    expect(html.includes('homework-materials')).toBe(!isVideo);
    expect(html.match(/data-external=/g)).toHaveLength(1);
    expect(html).toContain(`data-external="${url.replaceAll('&', '&amp;')}"`);
    expect(html).toContain(title);
  });

  it('keeps multiple video buttons separate, safely labelled and available after submission', () => {
    const dto: HomeworkSummaryDto = { id: 'homework', title: 'Завдання', instructions: 'Інструкції', publishedAt: '', dueAt: null, xpReward: 0, classTitle: null, state: 'submitted', latestSubmission: {
      id: 'submission', status: 'submitted', attemptNumber: 1, contentText: 'Готово', contentUrl: null, studentComment: null, submittedAt: new Date().toISOString(), review: null
    }, resources: [
      { id: 'first', ...video, title: 'Відео <перше>' },
      { id: 'second', ...video, url: 'https://example.test/second.mp4', title: 'Друга частина' },
      { id: 'unsafe', ...video, url: 'javascript:alert(1)', title: 'Відео unsafe' }
    ] };
    const html = renderHomework(dto);
    expect(html.match(/class="btn btn--secondary btn--row btn--block homework-video-btn"/g)).toHaveLength(2);
    expect(html).toContain('Відео — Відео &lt;перше&gt;');
    expect(html).toContain('Відео — Друга частина');
    expect(html).not.toContain('Відео unsafe');
    expect(html).not.toContain('homework-materials');
    expect(html).not.toContain('id="homeworkSubmit"');
  });

  describe('homework files in the Student template', () => {
    const policy = { enabled: true, reason: null, maxFileBytes: 20 * 1024 * 1024, maxFiles: 10, maxTotalBytes: 50 * 1024 * 1024, extensions: ['pdf', 'png'] };
    const file = { id: 'file-1', name: '<b>Звіт</b>.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 1258291, uploadedAt: new Date().toISOString(), url: 'https://store.example/homework/report.pdf?sig=1', urlExpiresAt: new Date(Date.now() + 600000).toISOString() };
    const base: HomeworkSummaryDto = { id: 'homework', title: 'Завдання', instructions: 'Інструкції', publishedAt: '', dueAt: null, xpReward: 10, classTitle: null, state: 'not_started', latestSubmission: null, resources: [] };

    it('lists saved drafts with escaped names, size and a real attach control', () => {
      const html = renderHomework({ ...base, canSubmit: true, draftFiles: [file] }, { fileUploads: policy });
      expect(html).toContain('data-tone="draft">Чернетка<');
      expect(html).toContain('&lt;b&gt;Звіт&lt;/b&gt;.pdf');
      expect(html).not.toContain('<b>Звіт</b>');
      expect(html).toContain('1,2 МБ');
      expect(html).toContain('id="homeworkAttach"');
      expect(html).not.toMatch(/id="homeworkAttach"[^>]*disabled/);
      expect(html).toContain(`data-file-url="${file.url.replaceAll('&', '&amp;')}"`);
      expect(html).toContain('data-file-remove="file-1"');
      expect(html).toContain('Надіслати домашнє завдання');
    });

    it('explains unavailable uploads instead of rendering a dead button', () => {
      const html = renderHomework({ ...base, canSubmit: true }, { fileUploads: { ...policy, enabled: false, reason: 'Сховище не підключено.' } });
      expect(html).not.toContain('homeworkAttach');
      expect(html).toContain('Сховище не підключено.');
      expect(html).toContain('id="homeworkSubmit"');
    });

    it('shows a sent attempt with its files and no form', () => {
      const html = renderHomework({ ...base, state: 'submitted', canSubmit: false, latestSubmission: { id: 's', attemptNumber: 1, submittedAt: new Date().toISOString(), studentComment: '', contentText: 'Готово', contentUrl: null, status: 'submitted', review: null, attachments: [file] } }, { fileUploads: policy });
      expect(html).toContain('data-tone="review">На перевірці<');
      expect(html).toContain('&lt;b&gt;Звіт&lt;/b&gt;.pdf');
      expect(html).not.toContain('id="homeworkSubmit"');
      expect(html).not.toContain('data-file-remove');
      expect(html).toContain('Роботу надіслано');
    });

    it('carries files of a returned attempt into the next one', () => {
      const html = renderHomework({ ...base, state: 'needs_revision', canSubmit: true, latestSubmission: { id: 's', attemptNumber: 1, submittedAt: new Date().toISOString(), studentComment: '', contentText: 'Готово', contentUrl: null, status: 'needs_revision', review: { score: 6, effort: 'good_effort', status: 'needs_revision', feedback: 'Додай скриншот', reviewedAt: new Date().toISOString() }, attachments: [file] } }, { fileUploads: policy });
      expect(html).toContain('data-tone="revision">На доопрацюванні<');
      expect(html).toContain('Допрацюй і надішли ще раз');
      expect(html).toContain('З попередньої спроби');
      expect(html).toContain('Не надсилати повторно');
    });
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
