import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MockAiProvider } from './services/ai-provider.js';
import { buildApp } from './app.js';

describe('HTTP API', () => {
  let app: FastifyInstance | undefined;
  afterEach(async()=>app?.close());
  it('rejects protected routes and serves a data-driven bootstrap after development login', async () => {
    const env=loadEnv({ NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'test-pepper' });
    const jwt=await createJwtService(env); app=await buildApp({env,repository:new MemoryRepository(),jwt,aiProvider:new MockAiProvider()});
    expect((await app.inject({method:'GET',url:'/api/v1/bootstrap'})).statusCode).toBe(401);
    const login=await app.inject({method:'POST',url:'/api/v1/auth/development'});
    expect(login.statusCode).toBe(200);
    const {accessToken}=login.json();
    const response=await app.inject({method:'GET',url:'/api/v1/bootstrap',headers:{authorization:`Bearer ${accessToken}`}});
    expect(response.statusCode).toBe(200);
    expect(response.json().learning.course.totalLessons).toBe(8);
    expect(response.json().projects).toEqual([]);
    const invalid=await app.inject({method:'POST',url:'/api/v1/projects',headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},payload:{title:''}});
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
  });
});
