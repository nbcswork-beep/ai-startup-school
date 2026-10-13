import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { createAssignedPilotState } from './data/assigned-pilot.test-fixture.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MemoryPilotRuntimeStore } from './data/pilot-runtime-store.js';
import { DEV_IDS, PILOT_STUDENTS } from './data/seed.js';
import { MockAiProvider } from './services/ai-provider.js';
import { LocalDevFileStorage, type FileStorage } from './storage/file-storage.js';
import { cleanDisplayName, matchesSignature, storageSafeName } from './storage/file-types.js';
import type { HomeworkFileDto, HomeworkSummaryDto, TeacherWorkspaceDto } from './types/domain.js';

const TEACHER = '12000000-0000-4000-8000-000000000001';
const HOMEWORK = '73000000-0000-4000-8000-000000000002';
const OTHER_STUDENT = PILOT_STUDENTS.find(student => student.id !== DEV_IDS.user)!.id;
const apps: FastifyInstance[] = [];

const bytes = {
  pdf: Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n'),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]),
  docx: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')]),
  txt: Buffer.from('Мій звіт про домашнє завдання ✓\n', 'utf8')
};

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function school(options: { storage?: FileStorage | null; env?: Record<string, string> } = {}) {
  const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
  const storage = options.storage === undefined ? new LocalDevFileStorage() : options.storage;
  return async (userId: string) => {
    const env = loadEnv({ NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'homework-files-test-only', DEV_USER_ID: userId, HOMEWORK_UPLOAD_MAX_FILE_MB: '1', HOMEWORK_UPLOAD_MAX_FILES: '4', ...options.env });
    const repository = new MemoryRepository(undefined, { runtimeStore: runtime });
    const app = await buildApp({ env, repository, jwt: await createJwtService(env), aiProvider: new MockAiProvider(), fileStorage: storage });
    apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json().accessToken}` };
    return {
      app, headers, repository,
      inject: (method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) }),
      async upload(name: string, content: Buffer, homeworkId = HOMEWORK) {
        const reserved = await app.inject({ method: 'POST', url: `/api/v1/homework/${homeworkId}/uploads`, headers, payload: { name, size: content.length } });
        if (reserved.statusCode !== 201) return { reserved };
        const { file, upload } = reserved.json() as { file: HomeworkFileDto; upload: { url: string; method: 'PUT'; headers: Record<string, string> } };
        const sent = await app.inject({ method: upload.method, url: upload.url, headers: upload.headers, payload: content });
        const complete = await app.inject({ method: 'POST', url: `/api/v1/homework/${homeworkId}/uploads/${file.id}/complete`, headers });
        return { reserved, sent, complete, file, upload };
      },
      async homework() { return ((await app.inject({ method: 'GET', url: `/api/v1/homework/${HOMEWORK}`, headers })).json()) as HomeworkSummaryDto; }
    };
  };
}

describe('homework file uploads', () => {
  it('stores several files privately, keeps them after a reload and sends them once', async () => {
    const join = school();
    const student = await join(DEV_IDS.user);
    const pdf = await student.upload('Звіт.pdf', bytes.pdf);
    const png = await student.upload('screen.PNG', bytes.png);
    const docx = await student.upload('План проєкту.docx', bytes.docx);
    for (const result of [pdf, png, docx]) {
      expect(result.reserved.statusCode).toBe(201);
      expect(result.sent!.statusCode).toBe(200);
      expect(result.complete!.statusCode).toBe(200);
    }
    expect(pdf.complete!.json()).toMatchObject({ name: 'Звіт.pdf', extension: 'pdf', mimeType: 'application/pdf', size: bytes.pdf.length });

    // A fresh app over the same runtime state is a page reload / another server instance.
    const reloaded = await join(DEV_IDS.user);
    const draft = (await reloaded.homework()).draftFiles!;
    expect(draft.map(file => file.name)).toEqual(['Звіт.pdf', 'screen.PNG', 'План проєкту.docx']);
    expect(draft.every(file => file.url && file.urlExpiresAt)).toBe(true);
    const downloaded = await reloaded.app.inject({ method: 'GET', url: draft[0]!.url! });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.equals(bytes.pdf)).toBe(true);
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');

    const payload = { contentText: 'Готово', attachmentIds: draft.map(file => file.id), clientRequestId: '5b1f0d4e-9d3c-4b47-8d38-9a3cf1a5c001' };
    const [first, second] = await Promise.all([reloaded.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, payload), reloaded.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, payload)]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    expect(first.json().attachments.map((file: HomeworkFileDto) => file.name)).toEqual(['Звіт.pdf', 'screen.PNG', 'План проєкту.docx']);

    const after = await reloaded.homework();
    expect(after.state).toBe('submitted');
    expect(after.canSubmit).toBe(false);
    expect(after.draftFiles).toEqual([]);
    expect(after.latestSubmission!.attemptNumber).toBe(1);
    expect(after.latestSubmission!.attachments).toHaveLength(3);
    const teacher = await join(TEACHER);
    const workspace = (await teacher.inject('GET', '/api/v1/teacher/bootstrap')).json() as TeacherWorkspaceDto;
    const submissions = workspace.submissions.filter(item => item.homeworkId === HOMEWORK && item.studentId === DEV_IDS.user);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.files!.map(file => file.name)).toEqual(['Звіт.pdf', 'screen.PNG', 'План проєкту.docx']);
    const teacherDownload = await teacher.app.inject({ method: 'GET', url: submissions[0]!.files![2]!.url! });
    expect(teacherDownload.rawPayload.equals(bytes.docx)).toBe(true);
  });

  it('rejects disallowed, empty, oversized and disguised files on the server', async () => {
    const student = await school()(DEV_IDS.user);
    expect((await student.upload('virus.exe', Buffer.from('MZ'))).reserved.statusCode).toBe(415);
    expect((await student.upload('page.html', Buffer.from('<script>'))).reserved.statusCode).toBe(415);
    expect((await student.upload('empty.pdf', Buffer.alloc(0))).reserved.statusCode).toBe(400);
    expect((await student.upload('big.pdf', Buffer.alloc(1024 * 1024 + 1, 0x25))).reserved.statusCode).toBe(413);
    const disguised = await student.upload('photo.png', Buffer.from('not really a png'));
    expect(disguised.complete!.statusCode).toBe(415);
    expect(disguised.complete!.json().error.message).toContain('.png');
    expect((await student.homework()).draftFiles).toEqual([]);
    const retry = await student.app.inject({ method: 'GET', url: `/api/v1/homework/${HOMEWORK}`, headers: student.headers });
    expect(retry.json().draftFiles).toEqual([]);
  });

  it('never lets one student reach another student’s files', async () => {
    const join = school();
    const owner = await join(DEV_IDS.user);
    const other = await join(OTHER_STUDENT);
    const uploaded = await owner.upload('private.txt', bytes.txt);
    expect(uploaded.complete!.statusCode).toBe(200);
    const id = uploaded.file!.id;
    expect((await other.inject('POST', `/api/v1/homework/${HOMEWORK}/uploads/${id}/complete`)).statusCode).toBe(404);
    expect((await other.inject('DELETE', `/api/v1/homework/${HOMEWORK}/uploads/${id}`)).statusCode).toBe(204);
    expect((await owner.homework()).draftFiles!.map(file => file.id)).toEqual([id]);
    const stolen = await other.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, { contentText: 'чужий файл', attachmentIds: [id] });
    expect(stolen.statusCode).toBe(400);
    expect((await other.homework()).draftFiles).toEqual([]);
    const list = (await other.inject('GET', '/api/v1/homework')).json() as HomeworkSummaryDto[];
    expect(JSON.stringify(list)).not.toContain(id);
  });

  it('removes a draft before sending, keeps sent files and lets a returned attempt reuse them', async () => {
    const join = school();
    const student = await join(DEV_IDS.user);
    const kept = await student.upload('report.pdf', bytes.pdf);
    const removed = await student.upload('extra.txt', bytes.txt);
    const removedUrl = (await student.homework()).draftFiles!.find(file => file.id === removed.file!.id)!.url!;
    expect((await student.inject('DELETE', `/api/v1/homework/${HOMEWORK}/uploads/${removed.file!.id}`)).statusCode).toBe(204);
    expect((await student.app.inject({ method: 'GET', url: removedUrl })).statusCode).toBe(404);
    const sent = await student.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, { contentText: '', attachmentIds: [kept.file!.id] });
    expect(sent.statusCode).toBe(201);
    expect((await student.inject('DELETE', `/api/v1/homework/${HOMEWORK}/uploads/${kept.file!.id}`)).statusCode).toBe(409);

    const teacher = await join(TEACHER);
    expect((await teacher.inject('PUT', `/api/v1/teacher/submissions/${sent.json().id}/review`, { score: 6, effort: 'good_effort', status: 'needs_revision', feedback: 'Додай скриншот' })).statusCode).toBeLessThan(300);
    const returned = await student.homework();
    expect(returned.canSubmit).toBe(true);
    const screenshot = await student.upload('screen.png', bytes.png);
    const resent = await student.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, { contentText: 'Додав скриншот', attachmentIds: [kept.file!.id, screenshot.file!.id] });
    expect(resent.statusCode).toBe(201);
    expect(resent.json().attemptNumber).toBe(2);
    expect(resent.json().attachments.map((file: HomeworkFileDto) => file.name)).toEqual(['report.pdf', 'screen.png']);
    const workspace = (await teacher.inject('GET', '/api/v1/teacher/bootstrap')).json() as TeacherWorkspaceDto;
    const latest = workspace.submissions.find(item => item.id === resent.json().id)!;
    expect(latest.previousAttempts[0]!.attachments!.map(file => file.name)).toEqual(['report.pdf']);
  });

  it('enforces the configured file count and refuses an empty attempt', async () => {
    const student = await school({ env: { HOMEWORK_UPLOAD_MAX_FILES: '2' } })(DEV_IDS.user);
    expect((await student.upload('a.txt', bytes.txt)).complete!.statusCode).toBe(200);
    expect((await student.upload('b.txt', bytes.txt)).complete!.statusCode).toBe(200);
    const third = await student.upload('c.txt', bytes.txt);
    expect(third.reserved.statusCode).toBe(409);
    expect(third.reserved.json().error.message).toContain('2');
    expect((await student.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, { contentText: '   ' })).statusCode).toBe(400);
  });

  it('refuses expired or forged upload URLs and never confirms bytes that did not arrive', async () => {
    const student = await school()(DEV_IDS.user);
    const reserved = await student.inject('POST', `/api/v1/homework/${HOMEWORK}/uploads`, { name: 'late.pdf', size: bytes.pdf.length });
    const { file, upload } = reserved.json();
    const forged = upload.url.replace(/.$/, upload.url.endsWith('A') ? 'B' : 'A');
    expect((await student.app.inject({ method: 'PUT', url: forged, headers: upload.headers, payload: bytes.pdf })).statusCode).toBe(403);
    const incomplete = await student.inject('POST', `/api/v1/homework/${HOMEWORK}/uploads/${file.id}/complete`);
    expect(incomplete.statusCode).toBe(409);
    expect((await student.homework()).draftFiles).toEqual([]);
  });

  it('keeps unsafe names out of storage paths', async () => {
    const student = await school()(DEV_IDS.user);
    const result = await student.upload('../../etc/passwd.pdf', bytes.pdf);
    expect(result.complete!.json().name).toBe('passwd.pdf');
    const pathname = decodeURIComponent(result.upload!.url);
    expect(pathname).not.toContain('..');
  });

  it('reports uploads as unavailable instead of pretending when no storage is connected', async () => {
    const student = await school({ storage: null })(DEV_IDS.user);
    const bootstrap = (await student.inject('GET', '/api/v1/bootstrap')).json();
    expect(bootstrap.fileUploads).toMatchObject({ enabled: false });
    expect(bootstrap.fileUploads.reason).toContain('текстом');
    expect((await student.inject('POST', `/api/v1/homework/${HOMEWORK}/uploads`, { name: 'a.pdf', size: 10 })).statusCode).toBe(503);
    expect((await student.inject('POST', `/api/v1/homework/${HOMEWORK}/submissions`, { contentText: 'Текстова відповідь' })).statusCode).toBe(201);
  });
});

describe('homework file types', () => {
  it('matches the real file signature, not the name', () => {
    expect(matchesSignature('pdf', bytes.pdf)).toBe(true);
    expect(matchesSignature('pdf', bytes.png)).toBe(false);
    expect(matchesSignature('png', bytes.png)).toBe(true);
    expect(matchesSignature('docx', bytes.docx)).toBe(true);
    expect(matchesSignature('xlsx', bytes.pdf)).toBe(false);
    expect(matchesSignature('doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe(true);
    expect(matchesSignature('jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesSignature('zip', Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(matchesSignature('txt', bytes.txt)).toBe(true);
    expect(matchesSignature('txt', Buffer.from([0x41, 0x00, 0x42]))).toBe(false);
    expect(matchesSignature('txt', Buffer.from('Ї', 'utf8').subarray(0, 1))).toBe(true);
    expect(matchesSignature('txt', Buffer.alloc(0))).toBe(false);
  });
  it('cleans display names and storage keys', () => {
    expect(cleanDisplayName('C:\\Users\\me\\Звіт\u202e.pdf')).toBe('Звіт.pdf');
    expect(storageSafeName('Мій план  (фінал)!.docx', 'docx')).toBe('Mii_plan_final.docx');
    expect(storageSafeName('Пілот_книга.pdf', 'pdf')).toBe('Pilot_knyha.pdf');
    expect(storageSafeName('Щоденник Юлії, з\'їзд.txt', 'txt')).toBe('Shchodennyk_Iulii_zizd.txt');
    expect(storageSafeName('Résumé.pdf', 'pdf')).toBe('Resume.pdf');
    expect(storageSafeName('报告.pdf', 'pdf')).toBe('file.pdf');
    expect(storageSafeName('../.pdf', 'pdf')).toBe('file.pdf');
    expect(cleanDisplayName(`${'а'.repeat(300)}.pptx`)).toMatch(/^а+\.pptx$/);
    expect(cleanDisplayName(`${'а'.repeat(300)}.pptx`).length).toBe(160);
  });
  it('builds storage keys that @vercel/blob can presign', async () => {
    // The SDK checks the URL pathname against the scope inside the delegation token; a Cyrillic key
    // failed that check in production ("Blob path does not match the signed token scope").
    const { presignUrl } = await import('@vercel/blob');
    const pathname = `production/homework/${HOMEWORK}/${DEV_IDS.user}/${HOMEWORK}/${storageSafeName('Пілот_книга.pdf', 'pdf')}`;
    const validUntil = Date.now() + 60_000;
    const scope = { pathname, operations: ['put'], validUntil, allowedContentTypes: ['application/pdf'], maximumSizeInBytes: 100 };
    const token = { delegationToken: `${Buffer.from(JSON.stringify(scope)).toString('base64url')}.signature`, clientSigningToken: 'test-key', validUntil };
    const { presignedUrl } = await presignUrl(token, {
      operation: 'put', access: 'private', pathname, validUntil,
      allowedContentTypes: ['application/pdf'], maximumSizeInBytes: 100, addRandomSuffix: false, allowOverwrite: false
    });
    expect(new URL(presignedUrl).searchParams.get('pathname')).toBe(pathname);
  });
});
