import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from './auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, MemorySessionStore } from './auth/session-store.js';
import { DEV_IDS, PILOT, PILOT_STUDENTS, SEEDED_LESSONS } from './data/seed.js';
import { createVercelApp, injectVercelRequest } from './vercel-preview.js';
import type { NotificationDeliveryDto } from './types/domain.js';

const BOT_TOKEN='123456789:production-mutation-test-token';
const TEACHER_EMAIL='teacher@production.test';
const TEACHER_PASSWORD='production-equivalent-test-password';
const apps:FastifyInstance[]=[];

class UpstashRestEmulator {
  readonly strings=new Map<string,string>();
  readonly hashes=new Map<string,Map<string,string>>();
  readonly commands:string[][]=[];

  fetch=async(_input:string|URL|Request,init?:RequestInit):Promise<Response>=>{
    const command=JSON.parse(String(init?.body)) as string[];this.commands.push(command);
    try{return Response.json({result:this.execute(command)});}catch(error){return Response.json({error:error instanceof Error?error.message:'command failed'},{status:400});}
  };

  private hash(key:string):Map<string,string>{let value=this.hashes.get(key);if(!value){value=new Map();this.hashes.set(key,value);}return value;}

  private execute(command:string[]):unknown{
    const operation=command[0]?.toUpperCase();
    if(operation==='GET')return this.strings.get(command[1]!)??null;
    if(operation==='HVALS')return [...this.hash(command[1]!).values()];
    if(operation==='HGET')return this.hash(command[1]!).get(command[2]!)??null;
    if(operation==='EVAL')return this.eval(command);
    throw new Error(`unsupported command ${operation}`);
  }

  private eval(command:string[]):unknown{
    const script=command[1]??'';
    if(script.includes("redis.call('EXISTS', KEYS[1]) == 0")){
      const key=command[3]!;if(!this.strings.has(key))this.strings.set(key,command[4]!);return this.strings.get(key)!;
    }
    if(script.includes("current ~= ARGV[1]")){
      const key=command[3]!,current=command[4]!,next=command[5]!;if(this.strings.get(key)!==current)return 0;this.strings.set(key,next);return 1;
    }
    if(script.includes('local availabilityRaw')){
      const availability=this.hash(command[3]!).get(command[5]!);if(!availability)return null;const slot=JSON.parse(availability) as {status:string;startsAtMs:number};if(slot.status!=='open'||slot.startsAtMs<=Number(command[7]))return null;const booking=JSON.parse(command[6]!) as {id:string};this.hash(command[4]!).set(booking.id,command[6]!);return command[6]!;
    }
    if(script.includes('local availabilityKey = KEYS[1]')){
      const candidate=JSON.parse(command[5]!) as {id:string};this.hash(command[3]!).set(candidate.id,command[5]!);return 'created';
    }
    if(script.includes("local currentRaw = redis.call('HGET', bookingsKey")){
      const bookings=this.hash(command[3]!),bookingId=command[4]!;if(!bookings.has(bookingId))return 'not_found';bookings.set(bookingId,command[6]!);return 'updated';
    }
    throw new Error('unsupported script');
  }
}

// This suite starts against an empty Redis, i.e. a brand new production school. Production
// otherwise refuses to seed over a missing runtime state key, so the bootstrap flag is explicit here.
async function productionEnvironment():Promise<NodeJS.ProcessEnv>{
  const pair=await generateKeyPair('ES256',{extractable:true});
  return{LOG_LEVEL:'silent',VERCEL_ENV:'production',VERCEL_PROJECT_PRODUCTION_URL:'ai-startup-school.vercel.app',TELEGRAM_BOT_TOKEN:BOT_TOKEN,TELEGRAM_WEBHOOK_SECRET:'production_mutation_webhook_secret',TELEGRAM_STUDENT_BINDINGS_JSON:JSON.stringify({illia:'987654321',ivan:'987654322'}),CRON_SECRET:'production-notification-cron-secret',ALLOW_RUNTIME_STATE_BOOTSTRAP:'true',SESSION_TOKEN_PEPPER:'production-mutation-test-pepper-with-entropy',APP_JWT_PRIVATE_KEY_BASE64:Buffer.from(await exportPKCS8(pair.privateKey)).toString('base64'),APP_JWT_PUBLIC_KEY_BASE64:Buffer.from(await exportSPKI(pair.publicKey)).toString('base64'),WEB_AUTH_ACCOUNTS_JSON:JSON.stringify([{userId:'12000000-0000-4000-8000-000000000001',email:TEACHER_EMAIL,passwordHash:await hashPassword(TEACHER_PASSWORD)}]),UPSTASH_REDIS_REST_KV_REST_API_URL:'https://production-upstash.test',UPSTASH_REDIS_REST_KV_REST_API_TOKEN:'production-write-token',SESSION_REDIS_PREFIX:'aiss:production:sessions:v1',MINI_APP_URL:'https://ai-startup-school.vercel.app'};
}

function signedInitData(telegramId:number):string{
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:`query-${telegramId}`,user:JSON.stringify({id:telegramId,first_name:'Pilot'})});
  const data=[...params.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([key,value])=>`${key}=${value}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();params.set('hash',crypto.createHmac('sha256',secret).update(data).digest('hex'));return params.toString();
}

async function request(app:FastifyInstance,path:string,init?:RequestInit):Promise<Response>{return injectVercelRequest(app,new Request(`https://ai-startup-school.vercel.app/api/backend?__aiss_path=${encodeURIComponent(path)}`,init));}
async function jsonRequest(app:FastifyInstance,path:string,method:string,body:unknown,token?:string):Promise<Response>{return request(app,path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});}

afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(apps.splice(0).map(app=>app.close()));});

describe('production-equivalent Vercel mutation smoke',()=>{
  it('persists every core pilot mutation through the Web Handler and Upstash REST stores',async()=>{
    const redis=new UpstashRestEmulator();vi.stubGlobal('fetch',redis.fetch);const env=await productionEnvironment(),sessions=new MemorySessionStore(),limiter=new MemoryLoginAttemptLimiter(),deliveries:NotificationDeliveryDto[]=[];
    const notificationSender={send:async(notification:NotificationDeliveryDto)=>{deliveries.push(notification);return{sent:true as const};}};
    const app=await createVercelApp(env,{sessionStore:sessions,loginLimiter:limiter,notificationSender});apps.push(app);
    const teacherLogin=await jsonRequest(app,'v1/auth/web','POST',{email:TEACHER_EMAIL,password:TEACHER_PASSWORD,target:'admin'});expect(teacherLogin.status).toBe(200);const teacherToken=(await teacherLogin.json() as {accessToken:string}).accessToken;
    const studentLogin=await jsonRequest(app,'v1/auth/telegram','POST',{initData:signedInitData(987654321)});expect(studentLogin.status).toBe(200);const studentToken=(await studentLogin.json() as {accessToken:string}).accessToken;

    const peopleTelegramId=987654399;
    const createdPerson=await jsonRequest(app,'v1/admin/students','POST',{firstName:'Redis',lastName:'Student',groupId:PILOT.groupId,telegramId:String(peopleTelegramId),status:'active'},teacherToken);expect(createdPerson.status).toBe(201);const createdPersonId=(await createdPerson.json() as {id:string}).id;
    const coldPeopleApp=await createVercelApp(env,{sessionStore:sessions,loginLimiter:limiter,notificationSender});apps.push(coldPeopleApp);
    const persistedPersonLogin=await jsonRequest(coldPeopleApp,'v1/auth/telegram','POST',{initData:signedInitData(peopleTelegramId)});expect(persistedPersonLogin.status).toBe(200);const persistedPersonToken=(await persistedPersonLogin.json() as {accessToken:string}).accessToken;
    const persistedPersonBootstrap=await request(coldPeopleApp,'v1/bootstrap',{headers:{authorization:`Bearer ${persistedPersonToken}`}});expect(persistedPersonBootstrap.status).toBe(200);expect(await persistedPersonBootstrap.json()).toMatchObject({home:{viewer:{id:createdPersonId}}});
    const reminderStart=new Date(Date.now()+24*60*60*1000),reminderEnd=new Date(reminderStart.getTime()+90*60*1000);
    const reminderClass=await jsonRequest(app,'v1/teacher/sessions','POST',{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Persistent reminder class',startsAt:reminderStart.toISOString(),endsAt:reminderEnd.toISOString()},teacherToken);expect(reminderClass.status).toBe(201);
    expect((await request(coldPeopleApp,'v1/notifications/worker')).status).toBe(401);
    const workerResponse=await request(coldPeopleApp,'v1/notifications/worker',{headers:{authorization:'Bearer production-notification-cron-secret'}});expect(workerResponse.status).toBe(200);expect(deliveries).toContainEqual(expect.objectContaining({recipientUserId:createdPersonId,type:'student_class_24h'}));
    const deliveryCount=deliveries.length;const duplicateWorkerResponse=await request(coldPeopleApp,'v1/notifications/worker',{headers:{authorization:'Bearer production-notification-cron-secret'}});expect(duplicateWorkerResponse.status).toBe(200);expect(deliveries).toHaveLength(deliveryCount);

    const guardianTelegramId=987654398;
    const createdGuardian=await jsonRequest(app,'v1/admin/guardians','POST',{firstName:'Redis',lastName:'Guardian',telegramId:String(guardianTelegramId),studentIds:[createdPersonId],status:'active'},teacherToken);expect(createdGuardian.status).toBe(201);
    const guardianLogin=await jsonRequest(await createAndTrack(env,sessions,limiter),'v1/auth/telegram','POST',{initData:signedInitData(guardianTelegramId)});expect(guardianLogin.status).toBe(200);const guardianToken=(await guardianLogin.json() as {accessToken:string}).accessToken;
    const guardianStudents=await request(await createAndTrack(env,sessions,limiter),'v1/guardian/students',{headers:{authorization:`Bearer ${guardianToken}`}});expect(guardianStudents.status).toBe(200);expect(await guardianStudents.json()).toContainEqual(expect.objectContaining({id:createdPersonId}));

    const createdStaff=await jsonRequest(app,'v1/admin/staff','POST',{firstName:'Redis',lastName:'Teacher',email:'redis.teacher@example.test',roles:['teacher','mentor']},teacherToken);expect(createdStaff.status).toBe(201);const activationToken=(await createdStaff.json() as {activationToken:string}).activationToken;
    const activatedStaff=await jsonRequest(await createAndTrack(env,sessions,limiter),'v1/auth/activate','POST',{token:activationToken,password:'production teacher password'},undefined);expect(activatedStaff.status).toBe(200);const activatedStaffToken=(await activatedStaff.json() as {accessToken:string}).accessToken;
    const staffWorkspace=await request(await createAndTrack(env,sessions,limiter),'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${activatedStaffToken}`}});expect(staffWorkspace.status).toBe(200);

    const homework=await jsonRequest(app,'v1/teacher/homework','POST',{groupId:PILOT.groupId,courseId:DEV_IDS.course,classSessionId:'71000000-0000-4000-8000-000000000001',title:'Production smoke homework',instructions:'Submit a persistent answer',dueAt:'2031-10-20T18:00:00.000Z',xpReward:100,status:'draft'},teacherToken);expect(homework.status).toBe(201);const homeworkId=(await homework.json() as {id:string}).id;
    expect((await jsonRequest(app,`v1/teacher/homework/${homeworkId}/publish`,'POST',{publishAt:'2031-10-19T18:00:00.000Z'},teacherToken)).status).toBe(204);

    const coldStudent=await createVercelApp(env,{sessionStore:sessions,loginLimiter:limiter});apps.push(coldStudent);const visible=await request(coldStudent,'v1/homework',{headers:{authorization:`Bearer ${studentToken}`}});expect(await visible.json()).toContainEqual(expect.objectContaining({id:homeworkId}));
    const submission=await jsonRequest(coldStudent,`v1/homework/${homeworkId}/submissions`,'POST',{contentText:'Production smoke answer'},studentToken);expect(submission.status).toBe(201);const submissionId=(await submission.json() as {id:string}).id;
    const coldTeacher=await createVercelApp(env,{sessionStore:sessions,loginLimiter:limiter});apps.push(coldTeacher);const teacherWorkspace=await request(coldTeacher,'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${teacherToken}`}});expect((await teacherWorkspace.json() as {submissions:Array<{id:string}>}).submissions).toContainEqual(expect.objectContaining({id:submissionId}));
    expect((await jsonRequest(coldTeacher,`v1/teacher/submissions/${submissionId}/review`,'PUT',{score:9,effort:'high_effort',status:'completed',feedback:'Persisted feedback'},teacherToken)).status).toBe(204);
    const reviewed=await request(await createAndTrack(env,sessions,limiter),`v1/homework/${homeworkId}`,{headers:{authorization:`Bearer ${studentToken}`}});expect(await reviewed.json()).toMatchObject({state:'completed',latestSubmission:{id:submissionId,review:{score:9,feedback:'Persisted feedback'}}});

    const createdClass=await jsonRequest(coldTeacher,'v1/teacher/sessions','POST',{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Production smoke class',startsAt:'2031-11-02T16:00:00.000Z',endsAt:'2031-11-02T17:30:00.000Z',meetingUrl:PILOT.meetingUrl,meetingProvider:'Google Meet'},teacherToken);expect(createdClass.status).toBe(201);const classId=(await createdClass.json() as {id:string}).id;
    const rescheduledStart='2031-11-03T16:00:00.000Z';expect((await jsonRequest(coldTeacher,`v1/teacher/sessions/${classId}/reschedule`,'POST',{startsAt:rescheduledStart,endsAt:'2031-11-03T17:30:00.000Z',reason:'Production smoke'},teacherToken)).status).toBe(204);
    const coldSchedule=await request(await createAndTrack(env,sessions,limiter),'v1/schedule',{headers:{authorization:`Bearer ${studentToken}`}});expect((await coldSchedule.json() as {upcoming:Array<{id:string;startsAt:string}>}).upcoming).toContainEqual(expect.objectContaining({id:classId,startsAt:rescheduledStart}));
    expect((await jsonRequest(coldTeacher,`v1/teacher/sessions/${classId}`,'PATCH',{status:'cancelled'},teacherToken)).status).toBe(204);const cancelledClass=await request(await createAndTrack(env,sessions,limiter),'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${teacherToken}`}});expect((await cancelledClass.json() as {sessions:Array<{id:string;status:string}>}).sessions).toContainEqual(expect.objectContaining({id:classId,status:'cancelled'}));

    const slotStart='2031-12-01T16:00:00.000Z';expect((await jsonRequest(coldTeacher,'v1/teacher/mentor/availability','POST',{startsAt:slotStart,endsAt:'2031-12-01T16:30:00.000Z',timezone:'Europe/Kyiv',status:'open'},teacherToken)).status).toBe(201);
    const slots=await request(await createAndTrack(env,sessions,limiter),'v1/mentor/availability',{headers:{authorization:`Bearer ${studentToken}`}});const slot=(await slots.json() as Array<{id:string;startsAt:string}>).find(item=>item.startsAt===slotStart)!;expect(slot).toBeTruthy();
    const booking=await jsonRequest(coldStudent,'v1/mentor/bookings','POST',{availabilityId:slot.id},studentToken);expect(booking.status).toBe(201);const bookingId=(await booking.json() as {id:string}).id;
    const mentorWorkspace=await request(await createAndTrack(env,sessions,limiter),'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${teacherToken}`}});expect((await mentorWorkspace.json() as {mentor:{bookings:Array<{id:string}>}}).mentor.bookings).toContainEqual(expect.objectContaining({id:bookingId}));
    expect((await jsonRequest(coldTeacher,`v1/teacher/mentor/bookings/${bookingId}`,'PATCH',{status:'cancelled'},teacherToken)).status).toBe(204);
    const cancelledBooking=await request(await createAndTrack(env,sessions,limiter),'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${teacherToken}`}});expect((await cancelledBooking.json() as {mentor:{bookings:Array<{id:string;status:string}>}}).mentor.bookings).toContainEqual(expect.objectContaining({id:bookingId,status:'cancelled'}));

    expect((await jsonRequest(coldTeacher,'v1/teacher/sessions/71000000-0000-4000-8000-000000000001/attendance','PUT',{entries:[{studentId:DEV_IDS.user,status:'present'}]},teacherToken)).status).toBe(204);
    const project=await jsonRequest(coldStudent,'v1/projects','POST',{title:'Production smoke project',summary:'Persistent'},studentToken);expect(project.status).toBe(201);const projectId=(await project.json() as {id:string}).id;
    expect((await jsonRequest(coldStudent,`v1/projects/${projectId}`,'PATCH',{title:'Updated production project'},studentToken)).status).toBe(200);
    expect((await jsonRequest(coldStudent,`v1/portfolio/projects/${projectId}`,'POST',{reflection:'Production persistence'},studentToken)).status).toBe(201);
    expect((await jsonRequest(coldStudent,`v1/lessons/${SEEDED_LESSONS[0]!.id}/complete`,'POST',{idempotencyKey:'production-smoke-progress'},studentToken)).status).toBe(200);

    const finalTeacher=await request(await createAndTrack(env,sessions,limiter),'v1/teacher/bootstrap',{headers:{authorization:`Bearer ${teacherToken}`}});const finalData=await finalTeacher.json() as {sessions:Array<{id:string;attendance:Array<{studentId:string;status:string}>}>;students:Array<{id:string;progressPercent:number;projectTitle:string|null;portfolio:{projects:Array<{projectId:string}>}}>};expect(finalData.sessions.find(item=>item.id==='71000000-0000-4000-8000-000000000001')?.attendance).toContainEqual(expect.objectContaining({studentId:DEV_IDS.user,status:'present'}));expect(finalData.students.find(item=>item.id===DEV_IDS.user)).toMatchObject({progressPercent:13,projectTitle:'Updated production project',portfolio:{projects:[expect.objectContaining({projectId})]}});

    expect((await jsonRequest(coldTeacher,`v1/admin/users/${PILOT_STUDENTS[1]!.id}/status`,'PATCH',{status:'disabled',reason:'Production smoke'},teacherToken)).status).toBe(204);
    const disabledLogin=await jsonRequest(await createAndTrack(env,sessions,limiter),'v1/auth/telegram','POST',{initData:signedInitData(987654322)});expect(disabledLogin.status).toBe(403);
    expect(redis.commands.some(command=>command[0]==='EVAL'&&String(command[1]).includes("current ~= ARGV[1]"))).toBe(true);
    expect(redis.commands.some(command=>command[0]==='EVAL'&&String(command[1]).includes('local availabilityKey = KEYS[1]'))).toBe(true);
  });
});

async function createAndTrack(env:NodeJS.ProcessEnv,sessions:MemorySessionStore,limiter:MemoryLoginAttemptLimiter):Promise<FastifyInstance>{const app=await createVercelApp(env,{sessionStore:sessions,loginLimiter:limiter});apps.push(app);return app;}
