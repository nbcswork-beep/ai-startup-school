import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService, type JwtService } from './auth/jwt-service.js';
import { hashPassword } from './auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, MemorySessionStore } from './auth/session-store.js';
import { loadEnv, type AppEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MockAiProvider } from './services/ai-provider.js';

const ADMIN_ID='12000000-0000-4000-8000-000000000001';
const TEACHER_ID='12000000-0000-4000-8000-000000000002';
const ADMIN_EMAIL='maksym@example.test';
const TEACHER_EMAIL='vadym@example.test';
const ADMIN_PASSWORD='admin correct battery horse';
const TEACHER_PASSWORD='teacher correct battery horse';
let env:AppEnv;
let jwt:JwtService;
let apps:FastifyInstance[]=[];

beforeAll(async()=>{
  env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'false',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'web-auth-test-pepper',WEB_AUTH_ACCOUNTS_JSON:JSON.stringify([
    {userId:ADMIN_ID,email:ADMIN_EMAIL,passwordHash:await hashPassword(ADMIN_PASSWORD)},
    {userId:TEACHER_ID,email:TEACHER_EMAIL,passwordHash:await hashPassword(TEACHER_PASSWORD)}
  ])});
  jwt=await createJwtService(env);
});

afterEach(async()=>{await Promise.all(apps.map(app=>app.close()));apps=[]});

async function appWith(store=new MemorySessionStore(),limiter=new MemoryLoginAttemptLimiter()){
  const app=await buildApp({env,repository:new MemoryRepository(undefined,{sessionStore:store}),jwt,aiProvider:new MockAiProvider(),loginLimiter:limiter});
  apps.push(app);return app;
}

async function login(app:FastifyInstance,email:string,password:string,target:'teacher'|'admin'){
  return app.inject({method:'POST',url:'/api/v1/auth/web',payload:{email,password,target}});
}

describe('production web authentication',()=>{
  it('logs in each teacher account and sets a hardened refresh cookie',async()=>{
    const app=await appWith();
    const response=await login(app,TEACHER_EMAIL,TEACHER_PASSWORD,'teacher');
    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(TEACHER_ID);
    expect(response.headers['set-cookie']).toMatch(/aiss_refresh=.*HttpOnly.*SameSite=Strict/i);
    expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:{authorization:`Bearer ${response.json().accessToken}`}})).statusCode).toBe(200);
  });

  it('returns the same generic response for a wrong password and unknown email',async()=>{
    const app=await appWith();
    const wrong=await login(app,TEACHER_EMAIL,'definitely incorrect','teacher');
    const unknown=await login(app,'unknown@example.test','definitely incorrect','teacher');
    expect(wrong.statusCode).toBe(401);expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(JSON.stringify(wrong.json())).not.toContain(TEACHER_EMAIL);
  });

  it('enforces server-side roles while allowing the admin to use both workspaces',async()=>{
    const app=await appWith();
    const teacherAdmin=await login(app,TEACHER_EMAIL,TEACHER_PASSWORD,'admin');
    expect(teacherAdmin.statusCode).toBe(403);
    const admin=await login(app,ADMIN_EMAIL,ADMIN_PASSWORD,'admin');
    expect(admin.statusCode).toBe(200);
    const headers={authorization:`Bearer ${admin.json().accessToken}`};
    expect((await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers})).statusCode).toBe(200);
    expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers})).statusCode).toBe(200);
  });

  it('blocks unauthenticated APIs and invalidates an access token on logout',async()=>{
    const app=await appWith();
    expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap'})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/v1/admin/bootstrap'})).statusCode).toBe(401);
    const response=await login(app,TEACHER_EMAIL,TEACHER_PASSWORD,'teacher');
    const access={authorization:`Bearer ${response.json().accessToken}`};
    const cookie=String(response.headers['set-cookie']).split(';')[0];
    expect((await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{cookie}})).statusCode).toBe(204);
    expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:access})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/v1/auth/refresh',headers:{cookie}})).statusCode).toBe(401);
  });

  it('keeps login, bootstrap and refresh valid across isolated repository instances',async()=>{
    const store=new MemorySessionStore();
    const first=await appWith(store);const second=await appWith(store);
    const response=await login(first,TEACHER_EMAIL,TEACHER_PASSWORD,'teacher');
    const cookie=String(response.headers['set-cookie']).split(';')[0];
    expect((await second.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:{authorization:`Bearer ${response.json().accessToken}`}})).statusCode).toBe(200);
    const refreshed=await second.inject({method:'POST',url:'/api/v1/auth/refresh',headers:{cookie}});
    expect(refreshed.statusCode).toBe(200);
  });

  it('rejects expired sessions and limits repeated login attempts',async()=>{
    const store=new MemorySessionStore();
    await store.create({id:'expired-session',familyId:'expired-family',userId:TEACHER_ID,provider:'web',refreshTokenHash:'expired-hash',createdAt:new Date(0),expiresAt:new Date(1)});
    expect(await store.isActive(TEACHER_ID,'expired-session',new Date())).toBe(false);
    expect((await store.rotate('expired-hash',{id:'next',familyId:'next',userId:'',provider:'web',refreshTokenHash:'next-hash',createdAt:new Date(),expiresAt:new Date(Date.now()+1000)},new Date())).status).toBe('expired');
    const app=await appWith(new MemorySessionStore(),new MemoryLoginAttemptLimiter());
    let response;for(let attempt=0;attempt<6;attempt+=1)response=await login(app,'blocked@example.test','incorrect password','teacher');
    expect(response?.statusCode).toBe(429);
  });
});
