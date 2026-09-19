import { afterEach,describe,expect,it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createJwtService } from '../auth/jwt-service.js';
import { loadEnv } from '../config/env.js';
import { MockAiProvider } from '../services/ai-provider.js';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS } from './seed.js';

const ADMIN='14000000-0000-4000-8000-000000000001';
const TEACHER='12000000-0000-4000-8000-000000000002';
const GUARDIAN='13000000-0000-4000-8000-000000000001';
const STUDENT=DEV_IDS.user;
let apps:FastifyInstance[]=[];

async function session(userId:string){const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'admin-test-pepper',DEV_USER_ID:userId});const repository=new MemoryRepository();const jwt=await createJwtService(env);const app=await buildApp({env,repository,jwt,aiProvider:new MockAiProvider()});apps.push(app);const login=await app.inject({method:'POST',url:'/api/v1/auth/development'});const accessToken=login.json().accessToken as string;const cookie=String(login.headers['set-cookie']).split(';')[0];return{app,repository,jwt,accessToken,cookie,headers:{authorization:`Bearer ${accessToken}`}};}
afterEach(async()=>{await Promise.all(apps.map(app=>app.close()));apps=[]});

describe('Admin Control Center authorization and security',()=>{
  it.each([[STUDENT,'student'],[TEACHER,'teacher'],[GUARDIAN,'guardian']])('rejects %s from every admin boundary',async(userId)=>{const {app,headers}=await session(userId);const response=await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers});expect(response.statusCode).toBe(403);});

  it('allows an active admin and never returns session hashes or secret configuration values',async()=>{const {app,headers}=await session(ADMIN);const response=await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers});expect(response.statusCode).toBe(200);const body=response.json();expect(body.admin.role).toBe('admin');expect(body.students.length).toBeGreaterThan(0);const serialized=JSON.stringify(body);expect(serialized).not.toMatch(/refreshTokenHash|refresh_token_hash|SESSION_TOKEN_PEPPER|TELEGRAM_BOT_TOKEN|PRIVATE_KEY|DATABASE_URL/i);expect(body.activeSessions[0]).not.toHaveProperty('refreshTokenHash');});

  it('revokes an access session immediately and creates audit/security events',async()=>{const {app,jwt,accessToken,headers}=await session(ADMIN);const principal=await jwt.verify(accessToken);const revoked=await app.inject({method:'POST',url:`/api/v1/admin/sessions/${principal.sessionId}/revoke`,headers,payload:{reason:'Підозріла активність'}});expect(revoked.statusCode).toBe(204);expect((await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers})).statusCode).toBe(401);});

  it('invalidates an otherwise unexpired access token on logout',async()=>{const {app,cookie,headers}=await session(ADMIN);const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{...headers,cookie}});expect(logout.statusCode).toBe(204);expect((await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers})).statusCode).toBe(401);});

  it('prevents role mass assignment and rejects invalid explorer sorting',async()=>{const {app,headers}=await session(ADMIN);const mass=await app.inject({method:'PATCH',url:`/api/v1/admin/users/${STUDENT}/status`,headers,payload:{status:'disabled',reason:'Контроль доступу',role:'admin'}});expect(mass.statusCode).toBe(400);const invalidSort=await app.inject({method:'GET',url:'/api/v1/admin/explorer/users?sort=refreshTokenHash',headers});expect(invalidSort.statusCode).toBe(400);});

  it('enforces bounded pagination and masks the system explorer',async()=>{const {app,headers}=await session(ADMIN);const tooLarge=await app.inject({method:'GET',url:'/api/v1/admin/explorer/users?pageSize=101',headers});expect(tooLarge.statusCode).toBe(400);const valid=await app.inject({method:'GET',url:'/api/v1/admin/explorer/users?pageSize=1&sort=id',headers});expect(valid.statusCode).toBe(200);expect(valid.json().pageSize).toBe(1);expect(valid.json().records).toHaveLength(1);expect(JSON.stringify(valid.json())).not.toMatch(/token|secret|password/i);});

  it('audits account and portfolio mutations without exposing child data publicly',async()=>{const {app,headers}=await session(ADMIN);expect((await app.inject({method:'PATCH',url:`/api/v1/admin/users/${STUDENT}/status`,headers,payload:{status:'disabled',reason:'Запит служби підтримки'}})).statusCode).toBe(204);expect((await app.inject({method:'PATCH',url:'/api/v1/admin/portfolios/81000000-0000-4000-8000-000000000001/visibility',headers,payload:{visibility:'shareable',reason:'Погоджений показ родині'}})).statusCode).toBe(204);const body=(await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers})).json();expect(body.auditEvents.map((event:{action:string})=>event.action)).toEqual(expect.arrayContaining(['account.status_changed','portfolio.visibility_changed']));expect(body.portfolios[0].visibility).toBe('shareable');});

  it('blocks guardian IDOR and student privilege escalation attempts server-side',async()=>{const guardian=await session(GUARDIAN);expect((await guardian.app.inject({method:'POST',url:'/api/v1/admin/guardian-links/92000000-0000-4000-8000-000000000099/revoke',headers:guardian.headers,payload:{reason:'guess'}})).statusCode).toBe(403);const student=await session(STUDENT);expect((await student.app.inject({method:'PATCH',url:`/api/v1/admin/users/${STUDENT}/status`,headers:student.headers,payload:{status:'active',reason:'role admin'}})).statusCode).toBe(403);});
  it('rate-limits repeated global-search requests',async()=>{const {app,headers}=await session(ADMIN);let response;for(let index=0;index<31;index+=1)response=await app.inject({method:'GET',url:'/api/v1/admin/search?q=Максим',headers});expect(response?.statusCode).toBe(429);});
  it('sets restrictive browser headers and no-store API caching',async()=>{const {app,headers}=await session(ADMIN);const response=await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers});expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");expect(response.headers['x-content-type-options']).toBe('nosniff');expect(response.headers['permissions-policy']).toContain('camera=()');expect(response.headers['cache-control']).toBe('no-store');});
  it('fails closed for unsafe production auth and CORS configuration',()=>{expect(()=>loadEnv({NODE_ENV:'production',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',APP_ORIGINS:'https://admin.example.com'})).toThrow(/Development auth/);const production={NODE_ENV:'production',DATA_BACKEND:'postgres',DATABASE_URL:'postgres://database.invalid/app',TELEGRAM_BOT_TOKEN:'placeholder',APP_JWT_PRIVATE_KEY_BASE64:'placeholder',APP_JWT_PUBLIC_KEY_BASE64:'placeholder',SESSION_TOKEN_PEPPER:'placeholder',WEB_AUTH_ACCOUNTS_JSON:'placeholder'};expect(()=>loadEnv({...production,APP_ORIGINS:'*'})).toThrow(/Production APP_ORIGINS/);expect(()=>loadEnv({...production,APP_ORIGINS:'http://admin.example.com'})).toThrow(/Production APP_ORIGINS/);expect(()=>loadEnv({...production,APP_ORIGINS:''})).toThrow(/Production APP_ORIGINS/);});
});
