import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { createJwtService } from '../../auth/jwt-service.js';
import { loadEnv } from '../../config/env.js';
import { createAssignedPilotState } from '../../data/assigned-pilot.test-fixture.js';
import { MemoryRepository } from '../../data/memory-repository.js';
import { MemoryPilotRuntimeStore } from '../../data/pilot-runtime-store.js';
import { RedisAiStore } from '../store.js';
import type { MockProviderServer } from './mock-provider.js';
import { RedisEmulator } from './redis-emulator.js';
import { LocalDevFileStorage } from '../../storage/file-storage.js';
import type { AiWorkerDispatcher } from '../service.js';

/**
 * The whole app for AI tests: a pilot school, the real Lua scripts in a Redis emulator, local file
 * storage, and a mock provider over HTTP. Every student or admin is a separate signed-in app instance.
 */

export const ADMIN_ID = '14000000-0000-4000-8000-000000000001';
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export interface SseEvent { event: string; data: any }

export function parseSse(body: string): SseEvent[] {
  return body.split('\n\n').filter(frame => frame.startsWith('event:')).map(frame => {
    const [eventLine, dataLine] = frame.split('\n');
    return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
  });
}

export function aiSchool(options: { fetcher?: typeof fetch; generationBudgetMs?: number; worker?: { dispatcher: AiWorkerDispatcher | null; callbackSecret?: string } } = {}) {
  const runtime = new MemoryPilotRuntimeStore(createAssignedPilotState());
  const redis = new RedisEmulator();
  const aiStore = new RedisAiStore(redis, 'aiss:test:ai:v1');
  // One file store for every app instance (and for a worker in tests), like one Blob store in production.
  const fileStorage = new LocalDevFileStorage();
  const apps: FastifyInstance[] = [];
  const as = async (userId: string) => {
    const env = loadEnv({ NODE_ENV: 'test', DATA_BACKEND: 'memory', DEV_AUTH_ENABLED: 'true', DEV_EPHEMERAL_JWT: 'true', SESSION_TOKEN_PEPPER: 'ai-agent-test-pepper', DEV_USER_ID: userId });
    const app = await buildApp({ env, repository: new MemoryRepository(undefined, { runtimeStore: runtime }), jwt: await createJwtService(env), aiStore, aiNotifier: null, fileStorage, ...(options.worker ? { aiWorker: { dispatcher: options.worker.dispatcher, problem: null, callbackSecret: options.worker.callbackSecret ?? null } } : {}), ...(options.fetcher ? { aiFetcher: options.fetcher } : {}), ...(options.generationBudgetMs ? { aiGenerationBudgetMs: options.generationBudgetMs } : {}) });
    apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/development' });
    expect(login.statusCode).toBe(200);
    const token = login.json().accessToken as string;
    const headers = { authorization: `Bearer ${token}` };
    const call = (method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    const send = async (content: string, options: { conversationId?: string; modelId?: string; mode?: 'chat' | 'agent'; skillId?: string; attachmentIds?: string[]; clientRequestId?: string; continueJobId?: string } = {}) => {
      const response = await call('POST', `/api/v1/ai/conversations/${options.conversationId ?? 'new'}/stream`, {
        content, clientRequestId: options.clientRequestId ?? randomUUID(),
        ...(options.modelId ? { modelId: options.modelId } : {}), ...(options.mode ? { mode: options.mode } : {}),
        ...(options.skillId ? { skillId: options.skillId } : {}), ...(options.attachmentIds ? { attachmentIds: options.attachmentIds } : {}),
        ...(options.continueJobId ? { continueJobId: options.continueJobId } : {})
      });
      const events = response.statusCode === 200 ? parseSse(response.body) : [];
      return { response, events, done: events.find(item => item.event === 'done')?.data, error: events.find(item => item.event === 'error')?.data };
    };
    /** Uploads bytes the way the app does: reserve, PUT to storage, confirm. */
    const attach = async (name: string, bytes: Buffer) => {
      const reserved = await call('POST', '/api/v1/ai/attachments', { name, size: bytes.length });
      if (reserved.statusCode !== 201) return { reserved, completed: null };
      const { attachment, upload } = reserved.json();
      const put = await app.inject({ method: upload.method, url: upload.url, headers: upload.headers, payload: bytes });
      expect(put.statusCode).toBe(200);
      const completed = await call('POST', `/api/v1/ai/attachments/${attachment.id}/complete`);
      return { reserved, completed };
    };
    return { app, token, headers, call, send, attach };
  };
  return { redis, aiStore, fileStorage, as, close: () => Promise.all(apps.splice(0).map(app => app.close())) };
}

export async function configureMock(admin: Awaited<ReturnType<ReturnType<typeof aiSchool>['as']>>, mock: MockProviderServer, key: string, models: string[], protocol: 'openai' | 'anthropic' = 'openai') {
  const created = await admin.call('POST', '/api/v1/admin/ai/providers', { name: 'Mock reseller', protocol, baseUrl: protocol === 'anthropic' ? mock.anthropicBaseUrl : mock.baseUrl, apiKey: key, headers: [] });
  expect(created.statusCode).toBe(201);
  const ids: Record<string, string> = {};
  for (const apiModelId of models) {
    const model = await admin.call('POST', '/api/v1/admin/ai/models', { providerId: created.json().id, apiModelId, label: apiModelId.toUpperCase(), family: 'gpt', maxOutputTokens: 1024, maxInputTokens: 16000, pricing: { currency: 'USD', inputPer1M: 2, outputPer1M: 8, cachedInputPer1M: 1 } });
    expect(model.statusCode).toBe(201);
    const enabled = await admin.call('PATCH', `/api/v1/admin/ai/models/${model.json().id}`, { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    ids[apiModelId] = model.json().id;
  }
  expect((await admin.call('PUT', '/api/v1/admin/ai/settings', { defaultModelId: ids[models[0]!] })).statusCode).toBe(200);
  return { providerId: created.json().id as string, ids };
}
