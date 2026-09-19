import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createJwtService } from '../auth/jwt-service.js';
import { loadEnv } from '../config/env.js';
import { MockAiProvider } from '../services/ai-provider.js';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS } from './seed.js';

const teacher='12000000-0000-4000-8000-000000000001';
const guardian='13000000-0000-4000-8000-000000000001';
const group='70000000-0000-4000-8000-000000000001';

describe('education foundation invariants',()=>{
  it('preserves every homework attempt',async()=>{
    const repository=new MemoryRepository(); const homeworkId='73000000-0000-4000-8000-000000000002';
    const second=await repository.submitHomework(DEV_IDS.user,homeworkId,{contentText:'Друга версія'});
    const third=await repository.submitHomework(DEV_IDS.user,homeworkId,{contentText:'Третя версія'});
    expect(second.attemptNumber).toBe(1); expect(third.attemptNumber).toBe(2);
  });
  it('keeps XP independent from teacher score and rejects student grading',async()=>{
    const repository=new MemoryRepository(); const before=(await repository.getHome(DEV_IDS.user)).viewer.xp;
    const submission=await repository.submitHomework(DEV_IDS.user,'73000000-0000-4000-8000-000000000002',{contentText:'Перша відповідь'});
    await expect(repository.reviewHomework(DEV_IDS.user,submission.id,{score:10,effort:'high_effort',status:'completed',feedback:'ok'})).rejects.toMatchObject({statusCode:403});
    await repository.reviewHomework(teacher,submission.id,{score:4,effort:'high_effort',status:'needs_revision',feedback:'Допрацюй перевірку'});
    expect((await repository.getHome(DEV_IDS.user)).viewer.xp).toBe(before);
  });
  it('enforces assigned teacher group boundaries and attendance confirmation',async()=>{
    const repository=new MemoryRepository(); expect(await repository.listGroupStudents(teacher,group)).toHaveLength(4);
    await expect(repository.listGroupStudents(teacher,'70000000-0000-4000-8000-000000000099')).rejects.toMatchObject({statusCode:403});
    await repository.confirmAttendance(teacher,'71000000-0000-4000-8000-000000000001',DEV_IDS.user,'present','Підтверджено викладачем');
    await expect(repository.confirmAttendance(DEV_IDS.user,'71000000-0000-4000-8000-000000000001',DEV_IDS.user,'present')).rejects.toMatchObject({statusCode:403});
  });
  it('restricts guardian data to explicitly linked students',async()=>{
    const repository=new MemoryRepository(); expect(await repository.listLinkedStudents(guardian)).toHaveLength(1);
    const reports=await repository.listParentReports(guardian,DEV_IDS.user); expect(reports).toHaveLength(0);
    await expect(repository.listParentReports(guardian,'10000000-0000-4000-8000-000000000002')).rejects.toMatchObject({statusCode:403});
    await expect(repository.listMentorSlots(guardian)).rejects.toMatchObject({statusCode:403});
  });
  it('preserves the rescheduled class state and new timezone-safe timestamps',async()=>{
    const repository=new MemoryRepository(); const sessionId='71000000-0000-4000-8000-000000000001';
    const startsAt='2026-10-06T15:00:00.000Z'; const endsAt='2026-10-06T16:30:00.000Z';
    await repository.rescheduleClass(teacher,sessionId,{startsAt,endsAt,reason:'Зміна розкладу'});
    const session=(await repository.getSchedule(DEV_IDS.user)).upcoming.find(item=>item.id===sessionId);
    expect(session).toMatchObject({startsAt,endsAt,status:'rescheduled',durationMinutes:90});
  });
  it('keeps portfolio private and prevents mentor double booking',async()=>{
    const repository=new MemoryRepository(); expect((await repository.getPortfolio(DEV_IDS.user)).visibility).toBe('private');
    const startsAt=new Date(Date.now()+86_400_000).toISOString();const endsAt=new Date(Date.now()+88_200_000).toISOString();
    await repository.createMentorAvailability(teacher,{startsAt,endsAt,timezone:'Europe/Kyiv',status:'open'});
    const slot=(await repository.listMentorSlots(DEV_IDS.user))[0]!; await repository.bookMentorSlot(DEV_IDS.user,slot.id);
    await expect(repository.bookMentorSlot(DEV_IDS.user,slot.id)).rejects.toMatchObject({statusCode:409});
  });
});

describe('teacher API validation',()=>{
  let app:FastifyInstance|undefined; afterEach(async()=>app?.close());
  it('rejects unsafe meeting URLs and out-of-range scores',async()=>{
    const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'test-pepper',DEV_USER_ID:teacher});
    const jwt=await createJwtService(env); app=await buildApp({env,repository:new MemoryRepository(),jwt,aiProvider:new MockAiProvider()});
    const login=await app.inject({method:'POST',url:'/api/v1/auth/development'}); const token=login.json().accessToken; const headers={authorization:`Bearer ${token}`};
    const unsafe=await app.inject({method:'POST',url:'/api/v1/teacher/sessions',headers,payload:{groupId:group,courseId:DEV_IDS.course,title:'Live',startsAt:'2026-10-01T15:00:00.000Z',endsAt:'2026-10-01T16:30:00.000Z',meetingUrl:'javascript:alert(1)'}});
    expect(unsafe.statusCode).toBe(400);
    const score=await app.inject({method:'PUT',url:'/api/v1/teacher/submissions/74000000-0000-4000-8000-000000000002/review',headers,payload:{score:11,effort:'high_effort',status:'completed',feedback:'x'}});
    expect(score.statusCode).toBe(400);
  });
  it('enforces role boundaries on teacher endpoints',async()=>{
    const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'test-pepper',DEV_USER_ID:DEV_IDS.user});
    const jwt=await createJwtService(env); app=await buildApp({env,repository:new MemoryRepository(),jwt,aiProvider:new MockAiProvider()});
    const login=await app.inject({method:'POST',url:'/api/v1/auth/development'}); const token=login.json().accessToken;
    const response=await app.inject({method:'GET',url:'/api/v1/teacher/groups',headers:{authorization:`Bearer ${token}`}});
    expect(response.statusCode).toBe(403);
  });
});
