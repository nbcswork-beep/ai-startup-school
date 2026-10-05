import {createAssignedRepository} from './data/assigned-pilot.test-fixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MockAiProvider } from './services/ai-provider.js';
import { DEV_IDS, PILOT } from './data/seed.js';

const ADMIN='14000000-0000-4000-8000-000000000001';
const TEACHER='12000000-0000-4000-8000-000000000002';
const apps:FastifyInstance[]=[];
async function fixture(userId:string){
  const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'academic-test-only',DEV_USER_ID:userId});
  const repository=createAssignedRepository(),jwt=await createJwtService(env);
  const app=await buildApp({env,repository,jwt,aiProvider:new MockAiProvider()});apps.push(app);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/development'});
  const token=login.json().accessToken as string,principal=await jwt.verify(token);
  return{app,repository,headers:{authorization:`Bearer ${token}`},principal,cookie:String(login.headers['set-cookie']).split(';')[0]};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()))});
describe('academic HTTP boundaries',()=>{
  it('validates shared project notes and blocks forged authors and Student replies',async()=>{
    const {app,headers,repository}=await fixture(DEV_IDS.user),p=await repository.createProject(DEV_IDS.user,{title:'Real journal',summary:''}),url=`/api/v1/projects/${p.id}/notes`;
    const requestId='80000000-0000-4000-8000-000000000001';
    for(const payload of [{contentText:'',clientRequestId:requestId},{contentText:'Note',contentUrl:'javascript:alert(1)',clientRequestId:requestId},{contentText:'Note',authorId:TEACHER,clientRequestId:requestId}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
    const created=await app.inject({method:'POST',url,headers,payload:{contentText:'Real note',contentUrl:'https://example.test/project',clientRequestId:requestId}});expect(created.statusCode).toBe(200);const noteId=created.json().notes[0].id;
    expect((await app.inject({method:'POST',url:`/api/v1/teacher/students/${DEV_IDS.user}/projects/${p.id}/notes/${noteId}/replies`,headers,payload:{contentText:'Forged feedback',clientRequestId:requestId}})).statusCode).toBe(403);
  });
  it('blocks Student review actions and rejects blank or forged project submissions',async()=>{
    const {app,headers,repository}=await fixture(DEV_IDS.user);
    const p=await repository.createProject(DEV_IDS.user,{title:'Real project',summary:''}),task=p.tasks[0]!;
    const url=`/api/v1/projects/${p.id}/tasks/${task.id}/submit`;
    for(const payload of [{contentText:' ',expectedVersion:1},{contentText:'Text',expectedVersion:1,status:'completed'},{contentText:'x'.repeat(20001),expectedVersion:1}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:`/api/v1/projects/${p.id}/tasks/${task.id}/complete`,headers,payload:{idempotencyKey:'old-self-completion'}})).statusCode).toBe(409);
    for(const url of [`/api/v1/teacher/sessions/71000000-0000-4000-8000-000000000001/students/${DEV_IDS.user}/review`,`/api/v1/teacher/students/${DEV_IDS.user}/projects/${p.id}/tasks/${task.id}/review`])expect((await app.inject({method:'POST',url,headers,payload:{expectedVersion:1,decision:'approved'}})).statusCode).toBe(403);
  });
  it('validates Teacher decisions and retains UTC/ Kyiv create-session time validation',async()=>{
    const {app,headers}=await fixture(TEACHER);
    const review='/api/v1/teacher/sessions/71000000-0000-4000-8000-000000000001/students/'+DEV_IDS.user+'/review';
    for(const payload of [{expectedVersion:1,decision:'completed'},{expectedVersion:1,decision:'needs_revision',feedback:''},{expectedVersion:1,decision:'approved',xp:999}])expect((await app.inject({method:'POST',url:review,headers,payload})).statusCode).toBe(400);
    const create={groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Real Kyiv lesson',localStartsAt:'2027-03-29T17:00',localEndsAt:'2027-03-29T18:30'};
    const response=await app.inject({method:'POST',url:'/api/v1/teacher/sessions',headers,payload:create});expect(response.statusCode).toBe(201);expect(response.json().startsAt).toBe('2027-03-29T14:00:00.000Z');
    expect((await app.inject({method:'POST',url:'/api/v1/teacher/sessions',headers,payload:{...create,localEndsAt:'2027-03-29T16:30'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/v1/teacher/sessions',headers,payload:{...create,startsAt:'2027-03-29T17:00:00Z'}})).statusCode).toBe(400);
  });
  it.each([DEV_IDS.user,TEACHER])('denies non-admin session extension (%s)',async(userId)=>{
    const {app,headers,principal}=await fixture(userId);
    expect((await app.inject({method:'POST',url:`/api/v1/admin/sessions/${principal.sessionId}/extend`,headers,payload:{expectedExpiresAt:'2027-01-01T00:00:00.000Z'}})).statusCode).toBe(403);
  });
  it('extends server expiry by 180 days, rejects double clicks and retains the extension after refresh',async()=>{
    const {app,headers,principal,cookie}=await fixture(ADMIN);
    const original=(await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers})).json().activeSessions.find((s:{id:string})=>s.id===principal.sessionId);
    const url=`/api/v1/admin/sessions/${principal.sessionId}/extend`;
    const extended=await app.inject({method:'POST',url,headers,payload:{expectedExpiresAt:original.expiresAt}});
    expect(extended.statusCode).toBe(200);
    expect(Date.parse(extended.json().expiresAt)-Date.parse(original.expiresAt)).toBe(180*86400000);
    expect((await app.inject({method:'POST',url,headers,payload:{expectedExpiresAt:original.expiresAt}})).statusCode).toBe(409);
    const refreshed=await app.inject({method:'POST',url:'/api/v1/auth/refresh',headers:{cookie}});
    expect(refreshed.statusCode).toBe(200);
    expect(Number(/Max-Age=(\d+)/i.exec(String(refreshed.headers['set-cookie']))?.[1])).toBeGreaterThan(180*86400);
    const next=(await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers:{authorization:`Bearer ${refreshed.json().accessToken}`}})).json().activeSessions[0];
    expect(next.expiresAt).toBe(extended.json().expiresAt);
    expect(JSON.stringify(extended.json())).not.toMatch(/refreshToken|hash|provider|userId/);
  });
  it('validates group fields and disallows mass assignment',async()=>{
    const {app,headers}=await fixture(TEACHER);
    const payload={name:'API group',academicYear:2027,startsOn:'2027-01-01',weekdays:[1],time:'17:00',teacherId:TEACHER};
    expect((await app.inject({method:'POST',url:'/api/v1/teacher/groups',headers,payload:{...payload,id:PILOT.groupId}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/v1/teacher/groups',headers,payload:{...payload,weekdays:[]}})).statusCode).toBe(400);
    const created=await app.inject({method:'POST',url:'/api/v1/teacher/groups',headers,payload});
    expect(created.statusCode).toBe(201);
    const detail=await app.inject({method:'GET',url:`/api/v1/teacher/groups/${created.json().id}`,headers});
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.json().sessions).toHaveLength(0);
  });
  it('allows a pure admin to update a lesson through the shared handler',async()=>{
    const {app,headers}=await fixture(ADMIN);
    const url='/api/v1/teacher/sessions/71000000-0000-4000-8000-000000000001';
    expect((await app.inject({method:'PATCH',url,headers,payload:{status:'cancelled'}})).statusCode).toBe(204);
  });
  it('checks local session times and homework status/version on the server',async()=>{
    const {app,headers}=await fixture(TEACHER);
    const url='/api/v1/teacher/sessions/71000000-0000-4000-8000-000000000001';
    expect((await app.inject({method:'PATCH',url,headers,payload:{localStartsAt:'2027-01-20T18:00',localEndsAt:'2027-01-20T17:00'}})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url,headers,payload:{status:'made-up'}})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url,headers,payload:{localStartsAt:'2027-01-20T17:00',localEndsAt:'2027-01-20T18:30'}})).statusCode).toBe(204);
    const homework='/api/v1/teacher/homework/73000000-0000-4000-8000-000000000001';
    expect((await app.inject({method:'PATCH',url:homework,headers,payload:{status:'unpublished'}})).statusCode).toBe(400);
    expect((await app.inject({method:'PATCH',url:homework,headers,payload:{status:'unpublished',expectedVersion:1,studentId:DEV_IDS.user}})).statusCode).toBe(400);
  });
});
