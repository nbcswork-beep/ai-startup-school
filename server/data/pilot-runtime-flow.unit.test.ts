import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createJwtService, type JwtService } from '../auth/jwt-service.js';
import { MemorySessionStore } from '../auth/session-store.js';
import { loadEnv } from '../config/env.js';
import { MockAiProvider } from '../services/ai-provider.js';
import { MemoryMentoringStore } from './mentoring-store.js';
import { MemoryRepository } from './memory-repository.js';
import { MemoryPilotRuntimeStore } from './pilot-runtime-store.js';
import { DEV_IDS, PILOT, PILOT_STUDENTS, SEEDED_LESSONS } from './seed.js';

const ADMIN_ID='12000000-0000-4000-8000-000000000001';
const apps:FastifyInstance[]=[];
let jwt:JwtService;

beforeAll(async()=>{
  jwt=await createJwtService(loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'pilot-runtime-flow-pepper'}));
});

afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});

async function appFor(userId:string,runtime:MemoryPilotRuntimeStore,sessions:MemorySessionStore,mentoring=new MemoryMentoringStore()){
  const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_USER_ID:userId,DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'pilot-runtime-flow-pepper'});
  const app=await buildApp({env,repository:new MemoryRepository(undefined,{runtimeStore:runtime,sessionStore:sessions,mentoringStore:mentoring}),jwt,aiProvider:new MockAiProvider()});
  apps.push(app);
  const login=await app.inject({method:'POST',url:'/api/v1/auth/development'});
  return{app,login,headers:login.statusCode===200?{authorization:`Bearer ${login.json().accessToken as string}`}:{authorization:''}};
}

describe('persistent pilot runtime flow',()=>{
  it('shares the complete homework publish, submission and review flow across isolated instances',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();
    const teacher=await appFor(ADMIN_ID,runtime,sessions);
    const created=await teacher.app.inject({method:'POST',url:'/api/v1/teacher/homework',headers:teacher.headers,payload:{groupId:PILOT.groupId,courseId:DEV_IDS.course,classSessionId:'71000000-0000-4000-8000-000000000001',title:'Pilot persistence homework',instructions:'Create and submit a result.',dueAt:'2030-10-20T18:00:00.000Z',xpReward:80,status:'draft'}});
    expect(created.statusCode).toBe(201);const homeworkId=created.json().id as string;
    expect((await teacher.app.inject({method:'POST',url:`/api/v1/teacher/homework/${homeworkId}/publish`,headers:teacher.headers,payload:{publishAt:'2030-10-19T18:00:00.000Z'}})).statusCode).toBe(204);

    const student=await appFor(DEV_IDS.user,runtime,sessions);
    const visible=await student.app.inject({method:'GET',url:'/api/v1/homework',headers:student.headers});
    expect(visible.json()).toContainEqual(expect.objectContaining({id:homeworkId,title:'Pilot persistence homework'}));
    const submitted=await student.app.inject({method:'POST',url:`/api/v1/homework/${homeworkId}/submissions`,headers:student.headers,payload:{contentText:'Persistent student answer'}});
    expect(submitted.statusCode).toBe(201);const submissionId=submitted.json().id as string;

    const coldTeacher=await appFor(ADMIN_ID,runtime,sessions);
    const teacherWorkspace=await coldTeacher.app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:coldTeacher.headers});
    expect(teacherWorkspace.json().submissions).toContainEqual(expect.objectContaining({id:submissionId,studentId:DEV_IDS.user,homeworkId}));
    expect((await coldTeacher.app.inject({method:'PUT',url:`/api/v1/teacher/submissions/${submissionId}/review`,headers:coldTeacher.headers,payload:{score:9,effort:'high_effort',status:'completed',feedback:'Strong pilot result'}})).statusCode).toBe(204);

    const coldStudent=await appFor(DEV_IDS.user,runtime,sessions);
    const reviewed=await coldStudent.app.inject({method:'GET',url:`/api/v1/homework/${homeworkId}`,headers:coldStudent.headers});
    expect(reviewed.json()).toMatchObject({state:'completed',latestSubmission:{id:submissionId,review:{score:9,feedback:'Strong pilot result'}}});
    const otherStudent=await appFor(PILOT_STUDENTS[1]!.id,runtime,sessions);const isolated=(await otherStudent.app.inject({method:'GET',url:`/api/v1/homework/${homeworkId}`,headers:otherStudent.headers})).json();expect(isolated.latestSubmission).toBeNull();
  });

  it('preserves lesson completion and exposes actual progress to Teacher OS',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();const student=await appFor(DEV_IDS.user,runtime,sessions);
    const completed=await student.app.inject({method:'POST',url:`/api/v1/lessons/${SEEDED_LESSONS[0]!.id}/complete`,headers:student.headers,payload:{idempotencyKey:'lesson-persistence-001'}});
    expect(completed.statusCode).toBe(200);expect(completed.json().awardedXp).toBe(SEEDED_LESSONS[0]!.xp);
    const coldStudent=await appFor(DEV_IDS.user,runtime,sessions);const learning=await coldStudent.app.inject({method:'GET',url:'/api/v1/learning',headers:coldStudent.headers});
    expect(learning.json().course).toMatchObject({completedLessons:1,progressPercent:13});
    const teacher=await appFor(ADMIN_ID,runtime,sessions);const workspace=await teacher.app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:teacher.headers});
    expect(workspace.json().students.find((item:{id:string})=>item.id===DEV_IDS.user)).toMatchObject({progressPercent:13,xp:SEEDED_LESSONS[0]!.xp});
  });

  it('shares student project and portfolio mutations with Teacher and Admin',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();const student=await appFor(DEV_IDS.user,runtime,sessions);
    const created=await student.app.inject({method:'POST',url:'/api/v1/projects',headers:student.headers,payload:{title:'Pilot product',summary:'Initial'}});expect(created.statusCode).toBe(201);const projectId=created.json().id as string;
    expect((await student.app.inject({method:'PATCH',url:`/api/v1/projects/${projectId}`,headers:student.headers,payload:{title:'Persistent pilot product',summary:'Updated'}})).statusCode).toBe(200);
    expect((await student.app.inject({method:'POST',url:`/api/v1/portfolio/projects/${projectId}`,headers:student.headers,payload:{reflection:'Learned persistence'}})).statusCode).toBe(201);
    const teacher=await appFor(ADMIN_ID,runtime,sessions);const teacherData=(await teacher.app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:teacher.headers})).json();
    expect(teacherData.students.find((item:{id:string})=>item.id===DEV_IDS.user)).toMatchObject({projectTitle:'Persistent pilot product',portfolio:{projects:[expect.objectContaining({projectId,title:'Persistent pilot product'})]}});
    const admin=await appFor(ADMIN_ID,runtime,sessions);const adminData=(await admin.app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers:admin.headers})).json();
    expect(adminData.projects).toContainEqual(expect.objectContaining({id:projectId,title:'Persistent pilot product',studentId:DEV_IDS.user}));
    expect(adminData.portfolios.find((item:{studentId:string})=>item.studentId===DEV_IDS.user)).toMatchObject({items:1});
    const otherStudent=await appFor(PILOT_STUDENTS[1]!.id,runtime,sessions);expect((await otherStudent.app.inject({method:'GET',url:'/api/v1/projects',headers:otherStudent.headers})).json()).toEqual([]);
  });

  it('shares class creation and rescheduling with the Student schedule',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();const teacher=await appFor(ADMIN_ID,runtime,sessions);
    const created=await teacher.app.inject({method:'POST',url:'/api/v1/teacher/sessions',headers:teacher.headers,payload:{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Persistent live class',startsAt:'2030-11-01T15:00:00.000Z',endsAt:'2030-11-01T16:00:00.000Z',meetingUrl:PILOT.meetingUrl,meetingProvider:'Google Meet'}});expect(created.statusCode).toBe(201);const sessionId=created.json().id as string;
    expect((await teacher.app.inject({method:'POST',url:`/api/v1/teacher/sessions/${sessionId}/reschedule`,headers:teacher.headers,payload:{startsAt:'2030-11-02T16:00:00.000Z',endsAt:'2030-11-02T17:00:00.000Z'}})).statusCode).toBe(204);
    const student=await appFor(DEV_IDS.user,runtime,sessions);const schedule=(await student.app.inject({method:'GET',url:'/api/v1/schedule',headers:student.headers})).json();
    expect(schedule.upcoming).toContainEqual(expect.objectContaining({id:sessionId,title:'Persistent live class',startsAt:'2030-11-02T16:00:00.000Z',status:'rescheduled'}));
  });

  it('shares attendance and portfolio visibility with isolated Teacher, Student and Admin instances',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();const teacher=await appFor(ADMIN_ID,runtime,sessions);const sessionId='71000000-0000-4000-8000-000000000001';
    expect((await teacher.app.inject({method:'PUT',url:`/api/v1/teacher/sessions/${sessionId}/attendance/${DEV_IDS.user}`,headers:teacher.headers,payload:{status:'late',note:'Joined after start'}})).statusCode).toBe(204);
    const coldTeacher=await appFor(ADMIN_ID,runtime,sessions);const teacherData=(await coldTeacher.app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:coldTeacher.headers})).json();
    expect(teacherData.sessions.find((item:{id:string})=>item.id===sessionId).attendance).toContainEqual(expect.objectContaining({studentId:DEV_IDS.user,status:'late',note:'Joined after start'}));
    const admin=await appFor(ADMIN_ID,runtime,sessions);const attendance=(await admin.app.inject({method:'GET',url:'/api/v1/admin/explorer/attendance?sort=id',headers:admin.headers})).json();
    expect(attendance.records).toContainEqual(expect.objectContaining({student:PILOT_STUDENTS[0]!.fullName,status:'late'}));
    const portfolioId='81000000-0000-4000-8000-000000000001';
    expect((await admin.app.inject({method:'PATCH',url:`/api/v1/admin/portfolios/${portfolioId}/visibility`,headers:admin.headers,payload:{visibility:'public',reason:'Pilot publication'}})).statusCode).toBe(204);
    const student=await appFor(DEV_IDS.user,runtime,sessions);expect((await student.app.inject({method:'GET',url:'/api/v1/portfolio',headers:student.headers})).json().visibility).toBe('shared');
    const adminData=(await admin.app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers:admin.headers})).json();expect(adminData.portfolios.find((item:{id:string})=>item.id===portfolioId).visibility).toBe('public');
  });

  it('keeps account disablement effective after an isolated instance starts',async()=>{
    const runtime=new MemoryPilotRuntimeStore(),sessions=new MemorySessionStore();const student=await appFor(DEV_IDS.user,runtime,sessions);expect(student.login.statusCode).toBe(200);
    const admin=await appFor(ADMIN_ID,runtime,sessions);expect((await admin.app.inject({method:'PATCH',url:`/api/v1/admin/users/${DEV_IDS.user}/status`,headers:admin.headers,payload:{status:'disabled',reason:'Pilot security check'}})).statusCode).toBe(204);
    expect((await student.app.inject({method:'GET',url:'/api/v1/bootstrap',headers:student.headers})).statusCode).toBe(401);
    const coldStudent=await appFor(DEV_IDS.user,runtime,sessions);expect(coldStudent.login.statusCode).toBe(403);
  });
});
