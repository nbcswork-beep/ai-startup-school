import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { MemoryPilotRuntimeStore } from './pilot-runtime-store.js';
import { MemorySessionStore } from '../auth/session-store.js';
import { PILOT, PILOT_STUDENTS } from './seed.js';
import crypto from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { createJwtService } from '../auth/jwt-service.js';
import { buildApp } from '../app.js';
import { MockAiProvider } from '../services/ai-provider.js';

const ADMIN='14000000-0000-4000-8000-000000000001';

function isolatedPair(){
  const runtime=new MemoryPilotRuntimeStore();
  return {
    runtime,
    first:new MemoryRepository(undefined,{runtimeStore:runtime,sessionStore:new MemorySessionStore(),requireSeededTelegramIdentity:true}),
    second:new MemoryRepository(undefined,{runtimeStore:runtime,sessionStore:new MemorySessionStore(),requireSeededTelegramIdentity:true})
  };
}

describe('persistent People Management lifecycle',()=>{
  it('creates a student once and exposes it to an isolated Teacher instance',async()=>{
    const {first,second}=isolatedPair();
    const created=await first.adminCreateStudent(ADMIN,{firstName:'Олена',lastName:'Тестова',groupId:PILOT.groupId,telegramId:' 777777001 ',status:'active'},'student-create');
    const studentId=String(created.id);
    expect((await second.listGroupStudents(ADMIN,PILOT.groupId)).find(item=>item.id===studentId)?.firstName).toBe('Олена Тестова');
    expect((await second.resolveTelegramUser({telegramId:'777777001',firstName:'Ignored'})).id).toBe(studentId);
    expect(Object.values((await first.getAdminWorkspace(ADMIN)).students).filter(item=>item.id===studentId)).toHaveLength(1);
    expect((await first.getAdminWorkspace(ADMIN)).students.filter(item=>PILOT_STUDENTS.some(seed=>seed.id===item.id))).toHaveLength(PILOT_STUDENTS.length);
  });

  it('enforces unique Telegram bindings and optimistic versions',async()=>{
    const {first}=isolatedPair();
    const one=await first.adminCreateStudent(ADMIN,{firstName:'Один',lastName:'Учень',groupId:PILOT.groupId,telegramId:'777777002',status:'active'},'one');
    const withoutTelegram=await first.adminCreateStudent(ADMIN,{firstName:'Без',lastName:'Telegram',groupId:PILOT.groupId,status:'active'},'without-telegram');
    expect(String(withoutTelegram.id)).toMatch(/^[0-9a-f-]{36}$/);
    await expect(first.resolveTelegramUser({telegramId:'777777099',firstName:'Unknown'})).rejects.toMatchObject({statusCode:403});
    await expect(first.adminCreateStudent(ADMIN,{firstName:'Другий',lastName:'Учень',groupId:PILOT.groupId,telegramId:'777777002',status:'active'},'two')).rejects.toMatchObject({statusCode:409});
    await first.adminUpdateStudent(ADMIN,String(one.id),{firstName:'Оновлений',expectedVersion:1},'edit');
    await expect(first.adminUpdateStudent(ADMIN,String(one.id),{lastName:'Застарілий',expectedVersion:1},'stale')).rejects.toMatchObject({statusCode:409});
  });

  it('persists many-to-many guardian access and rejects IDOR immediately after unlink',async()=>{
    const {first,second}=isolatedPair();
    const other=await first.adminCreateStudent(ADMIN,{firstName:'Друга',lastName:'Дитина',groupId:PILOT.groupId,status:'active'},'second-child');
    const guardian=await first.adminCreateGuardian(ADMIN,{firstName:'Марія',lastName:'Тестова',telegramId:'777777003',studentIds:[PILOT_STUDENTS[0]!.id,String(other.id)],status:'active'},'guardian-create');
    const dashboard=await second.getGuardianSummaryByTelegram('777777003');
    expect(dashboard.students.map(item=>item.id)).toEqual(expect.arrayContaining([PILOT_STUDENTS[0]!.id,String(other.id)]));
    await expect(second.getParentSummary(String(guardian.id),PILOT_STUDENTS[1]!.id)).rejects.toMatchObject({statusCode:403});
    await first.adminUnlinkGuardian(ADMIN,String(guardian.id),String(other.id),'unlink');
    await expect(second.getParentSummary(String(guardian.id),String(other.id))).rejects.toMatchObject({statusCode:403});
    expect((await second.getGuardianSummaryByTelegram('777777003')).students).toHaveLength(1);
  });

  it('revokes guardian access on binding change and deactivation',async()=>{
    const {first,second}=isolatedPair();
    const guardian=await first.adminCreateGuardian(ADMIN,{firstName:'Ірина',lastName:'Тестова',telegramId:'777777004',studentIds:[PILOT_STUDENTS[0]!.id],status:'active'},'guardian-create');
    await first.adminSetTelegramBinding(ADMIN,String(guardian.id),'777777005',1,'binding-change');
    expect(await second.getTelegramAudience('777777004')).toBeNull();
    expect((await second.getTelegramAudience('777777005'))?.userId).toBe(guardian.id);
    await first.adminSetAccountStatus(ADMIN,String(guardian.id),'disabled','Перевірка вимкнення','guardian-disable');
    await expect(second.getGuardianSummaryByTelegram('777777005')).rejects.toMatchObject({statusCode:403});
  });

  it('allows two active guardians to independently access the same child',async()=>{
    const {first,second}=isolatedPair(),studentId=PILOT_STUDENTS[0]!.id;
    await first.adminCreateGuardian(ADMIN,{firstName:'Перший',lastName:'Опікун',telegramId:'777777041',studentIds:[studentId],status:'active'},'guardian-one');
    await first.adminCreateGuardian(ADMIN,{firstName:'Другий',lastName:'Опікун',telegramId:'777777042',studentIds:[studentId],status:'active'},'guardian-two');
    expect((await second.getGuardianSummaryByTelegram('777777041',studentId)).selected?.student.id).toBe(studentId);
    expect((await second.getGuardianSummaryByTelegram('777777042',studentId)).selected?.student.id).toBe(studentId);
    await expect(second.getGuardianSummaryByTelegram('777777099',studentId)).rejects.toMatchObject({statusCode:403});
  });

  it('creates and activates staff without env credentials and applies roles persistently',async()=>{
    const {first,second}=isolatedPair();
    const created=await first.adminCreateStaff(ADMIN,{firstName:'Нова',lastName:'Викладачка',email:'Teacher@Example.Test',roles:['teacher']},'staff-create');
    const staffId=String(created.id),token=String(created.activationToken);
    expect((await second.getAuthUser(staffId))?.status).toBe('pending');
    await expect(first.adminCreateStaff(ADMIN,{firstName:'Дубль',lastName:'Email',email:'teacher@example.test',roles:['teacher']},'duplicate')).rejects.toMatchObject({statusCode:409});
    await second.activatePersistentWebUser(token,'correct horse battery staple');
    expect((await first.authenticatePersistentWebUser('TEACHER@example.test','correct horse battery staple'))?.id).toBe(staffId);
    const version=Number((await first.getAdminWorkspace(ADMIN)).teachers.find(item=>item.id===staffId)?.version);
    await first.adminUpdateStaff(ADMIN,staffId,{roles:['teacher','mentor'],expectedVersion:version},'roles');
    expect((await second.getWebAuthUser(staffId))?.roles).toEqual(expect.arrayContaining(['teacher','mentor']));
    await expect(second.activatePersistentWebUser(token,'another correct horse battery')).rejects.toMatchObject({statusCode:400});
  });

  it('runs the three complete API lifecycles through auth and RBAC',async()=>{
    const botToken='123456789:people-lifecycle-test';
    const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',DEV_USER_ID:ADMIN,SESSION_TOKEN_PEPPER:'people-api-test-pepper',TELEGRAM_BOT_TOKEN:botToken});
    const repository=new MemoryRepository(undefined,{requireSeededTelegramIdentity:true});
    const app=await buildApp({env,repository,jwt:await createJwtService(env),aiProvider:new MockAiProvider()});
    await app.ready();
    try{
      const adminLogin=await app.inject({method:'POST',url:'/api/v1/auth/development'});const adminHeaders={authorization:`Bearer ${adminLogin.json().accessToken}`};
      const studentResponse=await app.inject({method:'POST',url:'/api/v1/admin/students',headers:adminHeaders,payload:{firstName:'API',lastName:'Учень',groupId:PILOT.groupId,telegramId:'777777101',status:'active'}});expect(studentResponse.statusCode).toBe(201);const studentId=studentResponse.json().id as string;
      const studentLogin=await app.inject({method:'POST',url:'/api/v1/auth/telegram',payload:{initData:signedInitData(botToken,'777777101')}});expect(studentLogin.statusCode).toBe(200);expect((await app.inject({method:'GET',url:'/api/v1/bootstrap',headers:{authorization:`Bearer ${studentLogin.json().accessToken}`}})).statusCode).toBe(200);

      const guardianResponse=await app.inject({method:'POST',url:'/api/v1/admin/guardians',headers:adminHeaders,payload:{firstName:'API',lastName:'Мама',telegramId:'777777102',studentIds:[studentId],status:'active'}});expect(guardianResponse.statusCode).toBe(201);
      const guardianLogin=await app.inject({method:'POST',url:'/api/v1/auth/telegram',payload:{initData:signedInitData(botToken,'777777102')}});expect(guardianLogin.statusCode).toBe(200);const guardianHeaders={authorization:`Bearer ${guardianLogin.json().accessToken}`};expect((await app.inject({method:'GET',url:'/api/v1/guardian/students',headers:guardianHeaders})).json()).toHaveLength(1);expect((await app.inject({method:'GET',url:`/api/v1/guardian/students/${studentId}/summary`,headers:guardianHeaders})).statusCode).toBe(200);expect((await app.inject({method:'GET',url:`/api/v1/guardian/students/${PILOT_STUDENTS[1]!.id}/summary`,headers:guardianHeaders})).statusCode).toBe(403);expect((await app.inject({method:'POST',url:'/api/v1/projects',headers:guardianHeaders,payload:{title:'Forbidden',summary:'Guardian cannot mutate'}})).statusCode).toBe(403);

      const staffResponse=await app.inject({method:'POST',url:'/api/v1/admin/staff',headers:adminHeaders,payload:{firstName:'API',lastName:'Викладач',email:'api.teacher@example.test',roles:['teacher','mentor']}});expect(staffResponse.statusCode).toBe(201);const staffId=staffResponse.json().id as string,activationToken=staffResponse.json().activationToken as string;
      expect((await app.inject({method:'POST',url:'/api/v1/auth/activate',payload:{token:activationToken,password:'correct horse battery staple'}})).statusCode).toBe(200);
      const teacherLogin=await app.inject({method:'POST',url:'/api/v1/auth/web',payload:{email:'API.TEACHER@example.test',password:'correct horse battery staple',target:'teacher'}});expect(teacherLogin.statusCode).toBe(200);const teacherHeaders={authorization:`Bearer ${teacherLogin.json().accessToken}`};expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:teacherHeaders})).statusCode).toBe(200);expect((await app.inject({method:'GET',url:'/api/v1/admin/bootstrap',headers:teacherHeaders})).statusCode).toBe(403);
      expect((await app.inject({method:'PATCH',url:`/api/v1/admin/users/${staffId}/status`,headers:adminHeaders,payload:{status:'disabled',reason:'Lifecycle regression'}})).statusCode).toBe(204);expect((await app.inject({method:'GET',url:'/api/v1/teacher/bootstrap',headers:teacherHeaders})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/api/v1/auth/web',payload:{email:'api.teacher@example.test',password:'correct horse battery staple',target:'teacher'}})).statusCode).toBe(403);
    }finally{await app.close();}
  });
});

function signedInitData(botToken:string,telegramId:string):string{const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:`people-${telegramId}`,user:JSON.stringify({id:Number(telegramId),first_name:'Test',language_code:'uk'})});const check=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(botToken).digest();params.set('hash',crypto.createHmac('sha256',secret).update(check).digest('hex'));return params.toString();}
