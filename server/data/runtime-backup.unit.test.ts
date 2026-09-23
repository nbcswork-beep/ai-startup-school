import { describe, expect, it, vi } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createJwtService } from '../auth/jwt-service.js';
import { hashPassword } from '../auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, MemorySessionStore } from '../auth/session-store.js';
import { loadEnv } from '../config/env.js';
import { MemoryRepository } from './memory-repository.js';
import { MemoryMentoringStore } from './mentoring-store.js';
import { MockAiProvider } from '../services/ai-provider.js';
import {
  MemoryPilotRuntimeStore,
  RedisRestPilotRuntimeStore,
  RuntimeStateMissingError,
  createPilotRuntimeState,
  type PilotRuntimeState
} from './pilot-runtime-store.js';
import {
  FORBIDDEN_SNAPSHOT_KEYS,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotValidationError,
  createRuntimeSnapshot,
  findSnapshotSecrets,
  parseRuntimeSnapshot,
  summarizeRuntimeState
} from './state-snapshot.js';
import { applyRuntimeRestore, planRuntimeRestore, RestoreRefusedError } from './runtime-restore.js';

const ADMIN = '14000000-0000-4000-8000-000000000001';
const TEACHER = '12000000-0000-4000-8000-000000000001';
const TEACHER_ONLY = '12000000-0000-4000-8000-000000000002';
const STUDENT = '10000000-0000-4000-8000-000000000001';

/** Minimal Upstash REST emulator covering the commands the runtime store issues. */
class UpstashRestEmulator {
  readonly strings = new Map<string, string>();
  fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const command = JSON.parse(String(init?.body)) as string[];
    const operation = command[0]?.toUpperCase();
    if (operation === 'GET') return Response.json({ result: this.strings.get(command[1]!) ?? null });
    if (operation === 'SET') { this.strings.set(command[1]!, command[2]!); return Response.json({ result: 'OK' }); }
    if (operation === 'EVAL') {
      const script = command[1] ?? '';
      if (script.includes("redis.call('EXISTS', KEYS[1]) == 0")) {
        const key = command[3]!;
        if (!this.strings.has(key)) this.strings.set(key, command[4]!);
        return Response.json({ result: this.strings.get(key)! });
      }
      if (script.includes('current ~= ARGV[1]')) {
        const [key, current, next] = [command[3]!, command[4]!, command[5]!];
        if (this.strings.get(key) !== current) return Response.json({ result: 0 });
        this.strings.set(key, next);
        return Response.json({ result: 1 });
      }
    }
    return Response.json({ error: `unsupported ${operation}` }, { status: 400 });
  };
}

function populated(): PilotRuntimeState {
  const state = createPilotRuntimeState();
  state.directory[TEACHER]!.passwordHash = 'scrypt$live-teacher-secret';
  state.directory[TEACHER]!.email = 'teacher@school.test';
  state.directory[ADMIN]!.activationTokenHash = 'a'.repeat(64);
  state.telegramBindings['555000111'] = STUDENT;
  state.directory[STUDENT]!.telegramId = '555000111';
  state.submissions.push({
    id: '99000000-0000-4000-8000-000000000001', studentId: STUDENT, homeworkId: state.homework[0]!.id,
    attemptNumber: 1, submittedAt: '2026-09-22T10:00:00.000Z', studentComment: 'done', contentText: 'work',
    contentUrl: null, status: 'completed',
    review: { score: 9, effort: 'high_effort', status: 'completed', feedback: 'great', reviewedAt: '2026-09-22T12:00:00.000Z' }
  });
  state.attendance.push({
    id: '98000000-0000-4000-8000-000000000001', sessionId: state.classSessions[0]!.id, studentId: STUDENT,
    status: 'present', note: '', confirmedAt: '2026-09-22T09:00:00.000Z'
  });
  return state;
}

describe('runtime state export', () => {
  it('captures every persistent collection', () => {
    const snapshot = createRuntimeSnapshot(populated(), { environment: 'production', namespace: 'aiss:production:sessions:v1:pilot-runtime:v1:state' });
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.environment).toBe('production');
    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const collection of [
      'directory', 'telegramBindings', 'guardianRelations', 'userStatus', 'xp', 'streak', 'lessonProgress',
      'projects', 'achievements', 'classSessions', 'attendance', 'homework', 'submissions', 'portfolioProjects',
      'portfolioVisibility', 'teacherNotes', 'teacherReports', 'adminAuditEvents', 'securityEvents',
      'notifications', 'parentContactRequests'
    ]) {
      expect(snapshot.state, `missing ${collection}`).toHaveProperty(collection);
    }
    expect(snapshot.counts.submissions).toBe(1);
    expect(snapshot.counts.reviews).toBe(1);
    expect(snapshot.counts.attendance).toBe(1);
    expect(snapshot.counts.telegramBindings).toBe(1);
    expect(snapshot.counts.students).toBeGreaterThan(0);
  });

  it('strips credential material and reports who was redacted', () => {
    const source = populated();
    const snapshot = createRuntimeSnapshot(source, { environment: 'production', namespace: 'ns' });
    expect(snapshot.state.directory[TEACHER]!.passwordHash).toBeNull();
    expect(snapshot.state.directory[ADMIN]!.activationTokenHash).toBeNull();
    expect(snapshot.redactedCredentialUserIds).toEqual(expect.arrayContaining([TEACHER, ADMIN]));
    // the live state is untouched
    expect(source.directory[TEACHER]!.passwordHash).toBe('scrypt$live-teacher-secret');
  });

  it('contains no secrets anywhere in the serialized payload', () => {
    const snapshot = createRuntimeSnapshot(populated(), { environment: 'production', namespace: 'ns' });
    expect(findSnapshotSecrets(snapshot)).toEqual([]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('scrypt$live-teacher-secret');
    expect(serialized).not.toContain('a'.repeat(64));
    for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
      if (key === 'passwordHash' || key === 'activationTokenHash') continue;
      expect(serialized, `leaked ${key}`).not.toContain(`"${key}":"`);
    }
  });

  it('survives a JSON serialization round trip without losing data', () => {
    const snapshot = createRuntimeSnapshot(populated(), { environment: 'production', namespace: 'ns' });
    const restored = parseRuntimeSnapshot(JSON.stringify(snapshot));
    expect(restored).toEqual(snapshot);
    expect(summarizeRuntimeState(restored.state)).toEqual(snapshot.counts);
  });

  it('keeps fields a future schema version might add', () => {
    const snapshot = createRuntimeSnapshot(populated(), { environment: 'production', namespace: 'ns' }) as Record<string, unknown>;
    (snapshot.state as Record<string, unknown>).futureCollection = [{ id: 'x' }];
    const restored = parseRuntimeSnapshot(JSON.stringify(snapshot)) as unknown as Record<string, unknown>;
    expect((restored.state as Record<string, unknown>).futureCollection).toEqual([{ id: 'x' }]);
  });
});

describe('snapshot validation', () => {
  const valid = () => JSON.parse(JSON.stringify(createRuntimeSnapshot(populated(), { environment: 'preview', namespace: 'ns' })));

  it('rejects malformed JSON', () => {
    expect(() => parseRuntimeSnapshot('{not json')).toThrow(SnapshotValidationError);
  });

  it('rejects a payload that is not a snapshot', () => {
    expect(() => parseRuntimeSnapshot({ hello: 'world' })).toThrow(/does not match the expected schema/);
  });

  it('rejects a snapshot missing a persistent collection', () => {
    const broken = valid();
    delete broken.state.guardianRelations;
    expect(() => parseRuntimeSnapshot(broken)).toThrow(/does not match the expected schema/);
  });

  it('rejects a snapshot whose directory entries are the wrong shape', () => {
    const broken = valid();
    broken.state.directory[STUDENT].roles = 'student';
    expect(() => parseRuntimeSnapshot(broken)).toThrow(SnapshotValidationError);
  });

  it('rejects a snapshot from a newer schema version', () => {
    const broken = valid();
    broken.schemaVersion = SNAPSHOT_SCHEMA_VERSION + 1;
    expect(() => parseRuntimeSnapshot(broken)).toThrow(/newer than this build supports/);
  });

  it('rejects a snapshot that smuggles a credential into a directory entry', () => {
    const broken = valid();
    broken.state.directory[TEACHER].passwordHash = 'scrypt$injected';
    // The schema pins these fields to null, so this is caught before the deep scan runs.
    expect(() => parseRuntimeSnapshot(broken)).toThrow(SnapshotValidationError);
  });

  it('rejects a credential hidden anywhere the schema does not constrain', () => {
    const broken = valid();
    broken.state.adminAuditEvents.push({ id: 'a1', action: 'x', metadata: { passwordHash: 'scrypt$hidden' } });
    expect(() => parseRuntimeSnapshot(broken)).toThrow(/credential material/);

    const alsoBroken = valid();
    alsoBroken.state.notifications.push({ id: 'n1', safeMetadata: { text: 'hi', botToken: '123:abc' } });
    expect(() => parseRuntimeSnapshot(alsoBroken)).toThrow(/credential material/);
  });

  it('names the offending field so an operator can fix the file', () => {
    const broken = valid();
    broken.environment = 'staging';
    let caught: unknown;
    try { parseRuntimeSnapshot(broken); } catch (error) { caught = error; }
    expect((caught as SnapshotValidationError).issues.join(' ')).toContain('environment');
  });
});

describe('recovery', () => {
  const snapshotOf = (state: PilotRuntimeState, environment: 'production' | 'preview' = 'production') =>
    parseRuntimeSnapshot(JSON.stringify(createRuntimeSnapshot(state, { environment, namespace: 'ns' })));

  it('dry run changes nothing', async () => {
    const live = populated();
    const store = new MemoryPilotRuntimeStore(live);
    const before = JSON.stringify(await store.read());
    const incoming = createPilotRuntimeState();
    incoming.classSessions = [];
    const plan = await planRuntimeRestore(store, snapshotOf(incoming), 'production');
    expect(plan.current!.classSessions).toBeGreaterThan(0);
    expect(plan.incoming.classSessions).toBe(0);
    expect(JSON.stringify(await store.read())).toBe(before);
  });

  it('refuses to restore a preview snapshot into production', async () => {
    const store = new MemoryPilotRuntimeStore(populated());
    const snapshot = snapshotOf(createPilotRuntimeState(), 'preview');
    const plan = await planRuntimeRestore(store, snapshot, 'production');
    expect(plan.environmentMismatch).toBe(true);
    await expect(applyRuntimeRestore(store, snapshot, plan, { backup: async () => 'x' }))
      .rejects.toThrow(RestoreRefusedError);
    await expect(applyRuntimeRestore(store, snapshot, plan, { backup: async () => 'x' }))
      .rejects.toThrow(/Refusing to restore a "preview" snapshot into the "production"/);
  });

  it('allows a deliberate cross-environment restore', async () => {
    const store = new MemoryPilotRuntimeStore(populated());
    const incoming = createPilotRuntimeState();
    incoming.classSessions = [];
    const snapshot = snapshotOf(incoming, 'preview');
    const plan = await planRuntimeRestore(store, snapshot, 'production');
    const result = await applyRuntimeRestore(store, snapshot, plan, { backup: async () => '/tmp/pre.json', allowEnvironmentMismatch: true });
    expect(result.restoredCounts.classSessions).toBe(0);
  });

  it('writes a pre-restore backup before overwriting, and aborts if the backup fails', async () => {
    const live = populated();
    const store = new MemoryPilotRuntimeStore(live);
    const incoming = createPilotRuntimeState();
    incoming.classSessions = [];
    const snapshot = snapshotOf(incoming);
    const plan = await planRuntimeRestore(store, snapshot, 'production');

    const failing = vi.fn(async () => { throw new Error('disk full'); });
    await expect(applyRuntimeRestore(store, snapshot, plan, { backup: failing })).rejects.toThrow('disk full');
    expect((await store.read()).classSessions.length).toBeGreaterThan(0);

    const captured: unknown[] = [];
    const ok = vi.fn(async (preRestore: unknown) => { captured.push(preRestore); return '/backups/pre-restore.json'; });
    const result = await applyRuntimeRestore(store, snapshot, plan, { backup: ok });
    expect(result.backupLocation).toBe('/backups/pre-restore.json');
    expect(captured).toHaveLength(1);
    const preRestore = parseRuntimeSnapshot(JSON.stringify(captured[0]));
    expect(preRestore.counts.classSessions).toBe(live.classSessions.length);
    expect(preRestore.counts.submissions).toBe(1);
    expect((await store.read()).classSessions).toHaveLength(0);
  });

  it('never wipes credentials: they are carried over from the live state', async () => {
    const live = populated();
    const store = new MemoryPilotRuntimeStore(live);
    const snapshot = snapshotOf(populated());
    expect(snapshot.state.directory[TEACHER]!.passwordHash).toBeNull();

    const plan = await planRuntimeRestore(store, snapshot, 'production');
    expect(plan.credentialsPreserved).toContain(TEACHER);
    await applyRuntimeRestore(store, snapshot, plan, { backup: async () => '/backups/pre.json' });
    const after = await store.read();
    expect(after.directory[TEACHER]!.passwordHash).toBe('scrypt$live-teacher-secret');
    expect(after.directory[ADMIN]!.activationTokenHash).toBe('a'.repeat(64));
  });

  it('reports staff whose credentials cannot be recovered', async () => {
    const store = new MemoryPilotRuntimeStore(createPilotRuntimeState());
    const plan = await planRuntimeRestore(store, snapshotOf(populated()), 'production');
    expect(plan.credentialsUnrecoverable).toContain(TEACHER);
  });

  it('restores a real school round trip through the production-equivalent Redis store', async () => {
    const redis = new UpstashRestEmulator();
    vi.stubGlobal('fetch', redis.fetch);
    try {
      const namespace = 'aiss:production:sessions:v1:pilot-runtime:v1';
      const store = new RedisRestPilotRuntimeStore('https://upstash.test', 'token', namespace, { bootstrapPolicy: 'seed' });

      await store.mutate(state => { state.directory[TEACHER]!.passwordHash = 'scrypt$live'; });
      await store.mutate(state => { state.parentContactRequests.push({ id: 'r1', guardianId: '13000000-0000-4000-8000-000000000001', studentId: STUDENT, category: 'learning', message: 'hello', status: 'new', createdAt: '2026-09-22T10:00:00.000Z', resolvedAt: null }); });

      const good = createRuntimeSnapshot(await store.read(), { environment: 'production', namespace: (await store.status()).namespace });
      expect(good.counts.parentContactRequests).toBe(1);
      expect(findSnapshotSecrets(good)).toEqual([]);

      // Someone wrecks the state.
      await store.mutate(state => { state.parentContactRequests = []; state.submissions = []; state.directory = {}; });
      expect((await store.read()).parentContactRequests).toHaveLength(0);

      const snapshot = parseRuntimeSnapshot(JSON.stringify(good));
      const plan = await planRuntimeRestore(store, snapshot, 'production');
      const backups: unknown[] = [];
      await applyRuntimeRestore(store, snapshot, plan, { backup: async item => { backups.push(item); return '/backups/pre.json'; } });

      const recovered = await store.read();
      expect(recovered.parentContactRequests).toHaveLength(1);
      expect(backups).toHaveLength(1);
      expect((await store.status()).initialized).toBe(true);
      // The wipe destroyed the live credential and the snapshot deliberately never carried it,
      // so the teacher needs a fresh activation link. The plan says so instead of hiding it.
      expect(recovered.directory[TEACHER]!.passwordHash).toBeNull();
      expect(plan.credentialsUnrecoverable).toContain(TEACHER);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('missing runtime state', () => {
  it('seeds locally but refuses to seed when the policy requires existing state', async () => {
    const redis = new UpstashRestEmulator();
    vi.stubGlobal('fetch', redis.fetch);
    try {
      const seeding = new RedisRestPilotRuntimeStore('https://upstash.test', 'token', 'aiss:local:runtime', { bootstrapPolicy: 'seed' });
      expect((await seeding.status()).initialized).toBe(false);
      expect(Object.keys((await seeding.read()).directory).length).toBeGreaterThan(0);
      expect((await seeding.status()).initialized).toBe(true);

      const strict = new RedisRestPilotRuntimeStore('https://upstash.test', 'token', 'aiss:production:runtime', { bootstrapPolicy: 'require' });
      const status = await strict.status();
      expect(status.initialized).toBe(false);
      await expect(strict.read()).rejects.toThrow(RuntimeStateMissingError);
      await expect(strict.read()).rejects.toThrow(/Стан школи недоступний/);
      await expect(strict.mutate(state => state)).rejects.toThrow(RuntimeStateMissingError);
      // Failing closed must not create the key.
      expect((await strict.status()).initialized).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('carries an operator-facing diagnostic that names the namespace and the recovery command', async () => {
    const redis = new UpstashRestEmulator();
    vi.stubGlobal('fetch', redis.fetch);
    try {
      const strict = new RedisRestPilotRuntimeStore('https://upstash.test', 'token', 'aiss:production:runtime', { bootstrapPolicy: 'require' });
      let caught: unknown;
      try { await strict.read(); } catch (error) { caught = error; }
      const details = (caught as RuntimeStateMissingError).details as { namespace: string; operatorMessage: string };
      expect((caught as RuntimeStateMissingError).statusCode).toBe(503);
      expect(details.namespace).toBe('aiss:production:runtime:state');
      expect(details.operatorMessage).toContain('runtime:restore');
      expect(details.operatorMessage).toContain('ALLOW_RUNTIME_STATE_BOOTSTRAP');
      expect(details.operatorMessage).not.toContain('token');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('admin export endpoint', () => {
  const apps: FastifyInstance[] = [];

  async function adminApp(runtime: MemoryPilotRuntimeStore) {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const env = loadEnv({
      NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', SESSION_TOKEN_PEPPER: 'export-test-pepper',
      DEV_USER_ID: ADMIN, VERCEL_ENV: 'production', SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1',
      APP_JWT_PRIVATE_KEY_BASE64: Buffer.from(await exportPKCS8(pair.privateKey)).toString('base64'),
      APP_JWT_PUBLIC_KEY_BASE64: Buffer.from(await exportSPKI(pair.publicKey)).toString('base64')
    });
    const repository = new MemoryRepository(undefined, {
      runtimeStore: runtime, mentoringStore: new MemoryMentoringStore(), sessionStore: new MemorySessionStore()
    });
    const app = await buildApp({
      env, repository, jwt: await createJwtService(env), aiProvider: new MockAiProvider(), loginLimiter: new MemoryLoginAttemptLimiter()
    });
    apps.push(app);
    return app;
  }

  async function tokenFor(app: FastifyInstance) {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
    return login.json().accessToken as string;
  }

  it('returns a validated, secret-free snapshot to an admin and records an audit event', async () => {
    const runtime = new MemoryPilotRuntimeStore(populated(), 'aiss:production:sessions:v1:pilot-runtime:v1');
    const app = await adminApp(runtime);
    const response = await app.inject({
      method: 'GET', url: '/api/v1/admin/export/runtime-state', headers: { authorization: `Bearer ${await tokenFor(app)}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="aiss-runtime-production-/);

    const snapshot = parseRuntimeSnapshot(response.body);
    expect(snapshot.environment).toBe('production');
    expect(snapshot.namespace).toBe('aiss:production:sessions:v1:pilot-runtime:v1');
    expect(snapshot.counts.submissions).toBe(1);
    expect(findSnapshotSecrets(snapshot)).toEqual([]);
    expect(response.body).not.toContain('scrypt$live-teacher-secret');
    expect(response.body).not.toContain('export-test-pepper');

    const audit = (await runtime.read()).adminAuditEvents;
    expect(audit.some(event => event.action === 'runtime_state.exported')).toBe(true);
    await Promise.all(apps.splice(0).map(app => app.close()));
  });

  it('is closed to non-admin callers', async () => {
    // TEACHER (maksym) is seeded as teacher+mentor+admin, so the teacher-only account is the
    // meaningful negative case here.
    for (const userId of [TEACHER_ONLY, STUDENT]) {
      const runtime = new MemoryPilotRuntimeStore(populated(), 'aiss:production:sessions:v1:pilot-runtime:v1');
      const pair = await generateKeyPair('ES256', { extractable: true });
      const env = loadEnv({
        NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', SESSION_TOKEN_PEPPER: 'export-test-pepper',
        DEV_USER_ID: userId, VERCEL_ENV: 'production', SESSION_REDIS_PREFIX: 'aiss:production:sessions:v1',
        APP_JWT_PRIVATE_KEY_BASE64: Buffer.from(await exportPKCS8(pair.privateKey)).toString('base64'),
        APP_JWT_PUBLIC_KEY_BASE64: Buffer.from(await exportSPKI(pair.publicKey)).toString('base64')
      });
      const repository = new MemoryRepository(undefined, {
        runtimeStore: runtime, mentoringStore: new MemoryMentoringStore(), sessionStore: new MemorySessionStore()
      });
      const app = await buildApp({ env, repository, jwt: await createJwtService(env), aiProvider: new MockAiProvider(), loginLimiter: new MemoryLoginAttemptLimiter() });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
      const response = await app.inject({
        method: 'GET', url: '/api/v1/admin/export/runtime-state', headers: { authorization: `Bearer ${login.json().accessToken}` }
      });
      expect(response.statusCode, `${userId} must not export`).toBe(403);
      await app.close();
    }
  });

  it('requires authentication', async () => {
    const app = await adminApp(new MemoryPilotRuntimeStore(populated(), 'aiss:production:sessions:v1:pilot-runtime:v1'));
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/export/runtime-state' })).statusCode).toBe(401);
    await Promise.all(apps.splice(0).map(app => app.close()));
  });
});
