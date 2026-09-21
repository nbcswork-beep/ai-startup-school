import { describe, expect, it } from 'vitest';
import { MemorySessionStore } from '../auth/session-store.js';
import { NotificationWorker, type NotificationSender } from '../services/telegram-notification-service.js';
import type { NotificationDeliveryDto } from '../types/domain.js';
import { MemoryRepository } from './memory-repository.js';
import { MemoryPilotRuntimeStore } from './pilot-runtime-store.js';
import { PILOT, PILOT_TEACHERS, SEEDED_LESSONS } from './seed.js';

const ADMIN='14000000-0000-4000-8000-000000000001';
const TEACHER=PILOT_TEACHERS[0]!.id;

class CaptureSender implements NotificationSender {
  readonly deliveries:NotificationDeliveryDto[]=[];
  constructor(private readonly fail=false){}
  async send(notification:NotificationDeliveryDto):Promise<{sent:true}|{sent:false;errorCode:string;retryable:boolean}>{this.deliveries.push(notification);return this.fail?{sent:false,errorCode:'TELEGRAM_TEMPORARY',retryable:true}:{sent:true};}
}

async function fixture(){
  const runtime=new MemoryPilotRuntimeStore();
  const repository=new MemoryRepository(undefined,{runtimeStore:runtime,sessionStore:new MemorySessionStore(),requireSeededTelegramIdentity:true});
  const student=await repository.adminCreateStudent(ADMIN,{firstName:'Нотифікаційний',lastName:'Учень',groupId:PILOT.groupId,telegramId:'777778001',status:'active'},'student');
  const guardian=await repository.adminCreateGuardian(ADMIN,{firstName:'Тестова',lastName:'Мама',telegramId:'777778002',studentIds:[String(student.id)],status:'active'},'guardian');
  return{runtime,repository,studentId:String(student.id),guardianId:String(guardian.id)};
}

describe('persistent Telegram notification worker',()=>{
  it('delivers class and homework reminders exactly once across worker runs',async()=>{
    const {repository,runtime,studentId,guardianId}=await fixture(),now=new Date('2026-09-22T09:00:00.000Z');
    await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',lessonId:SEEDED_LESSONS[0]!.id,title:'Notification class',startsAt:new Date(now.getTime()+24*60*60*1000).toISOString(),endsAt:new Date(now.getTime()+25*60*60*1000).toISOString(),meetingUrl:'https://meet.example.test/class'});
    await repository.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Notification homework',instructions:'Complete the task',publishAt:now.toISOString(),dueAt:new Date(now.getTime()+24*60*60*1000).toISOString(),xpReward:20,status:'published'});
    const sender=new CaptureSender(),worker=new NotificationWorker(repository,sender,0,19);
    expect((await worker.run(now)).sent).toBe(3);
    expect(sender.deliveries.filter(item=>item.recipientUserId===studentId).map(item=>item.type)).toEqual(expect.arrayContaining(['student_class_24h','student_homework_assigned','student_homework_deadline']));
    expect(await worker.run(now)).toEqual({claimed:0,sent:0,failed:0});
    expect(sender.deliveries).toHaveLength(3);

    const oneHour=await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'One hour class',startsAt:new Date(now.getTime()+60*60*1000).toISOString(),endsAt:new Date(now.getTime()+2*60*60*1000).toISOString(),meetingUrl:'https://meet.example.test/hour'});
    const overdue=await repository.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Overdue homework',instructions:'Finish it',publishAt:new Date(now.getTime()-3*60*60*1000).toISOString(),dueAt:new Date(now.getTime()-60*60*1000).toISOString(),xpReward:20,status:'published'});
    const reviewedHomework=await repository.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Reviewed homework',instructions:'Submit it',publishAt:new Date(now.getTime()-3*60*60*1000).toISOString(),dueAt:new Date(now.getTime()+3*86_400_000).toISOString(),xpReward:20,status:'published'});
    const submission=await repository.submitHomework(studentId,reviewedHomework.id,{contentText:'Done'});await repository.reviewHomework(TEACHER,submission.id,{score:9,effort:'high_effort',status:'completed',feedback:'Сильна й самостійна робота'});
    const rescheduled=await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Rescheduled class',startsAt:new Date(now.getTime()+3*86_400_000).toISOString(),endsAt:new Date(now.getTime()+3*86_400_000+60*60*1000).toISOString()});
    await repository.rescheduleClass(TEACHER,rescheduled.id,{startsAt:new Date(now.getTime()+4*86_400_000).toISOString(),endsAt:new Date(now.getTime()+4*86_400_000+60*60*1000).toISOString()});
    const cancelled=await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Cancelled class',startsAt:new Date(now.getTime()+5*86_400_000).toISOString(),endsAt:new Date(now.getTime()+5*86_400_000+60*60*1000).toISOString()});
    await repository.updateTeacherClass(TEACHER,cancelled.id,{status:'cancelled'});
    await runtime.mutate(state=>{const reviewed=state.submissions.find(item=>item.id===submission.id);if(reviewed?.review)reviewed.review.reviewedAt=now.toISOString();for(const id of [rescheduled.id,cancelled.id]){const session=state.classSessions.find(item=>item.id===id);if(session)session.changedAt=now.toISOString();}});
    const expanded=await worker.run(now);expect(expanded.sent).toBeGreaterThanOrEqual(5);
    expect(sender.deliveries.filter(item=>item.recipientUserId===studentId).map(item=>item.type)).toEqual(expect.arrayContaining(['student_class_1h','student_homework_overdue','student_homework_reviewed']));
    expect(sender.deliveries.filter(item=>item.recipientUserId===guardianId).map(item=>item.type)).toEqual(expect.arrayContaining(['guardian_session_rescheduled','guardian_session_cancelled']));
    expect(sender.deliveries.find(item=>item.relatedEntityId===oneHour.id)?.buttonUrl).toBe('https://meet.example.test/hour');
    expect(sender.deliveries.find(item=>item.relatedEntityId===overdue.id)?.type).toBe('student_homework_overdue');
    expect(await worker.run(now)).toEqual({claimed:0,sent:0,failed:0});
  });

  it('alerts an authorized guardian about absence and stops after unlink',async()=>{
    const {repository,studentId,guardianId}=await fixture();
    const startsAt=new Date(Date.now()-60*60*1000).toISOString(),endsAt=new Date(Date.now()+30*60*1000).toISOString();
    const session=await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',lessonId:SEEDED_LESSONS[0]!.id,title:'Recovery class',description:'Lesson recovery',startsAt,endsAt});
    await repository.addClassMaterial(TEACHER,session.id,{kind:'document',title:'Конспект',url:'https://school.example.test/material'});
    const homework=await repository.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:'course',classSessionId:session.id,title:'Recovery homework',instructions:'Try again',xpReward:10,status:'published'});
    await repository.confirmAttendance(TEACHER,session.id,studentId,'absent');
    const recoveries=await repository.listMissedLessonRecoveries(studentId);
    expect(recoveries[0]).toMatchObject({sessionId:session.id,recordingUrl:null,homework:{id:homework.id},materials:[{title:'Конспект'}]});
    const sender=new CaptureSender(),worker=new NotificationWorker(repository,sender,0,19);
    await worker.run(new Date());
    expect(sender.deliveries.some(item=>item.recipientUserId===guardianId&&item.type==='guardian_absent_lesson')).toBe(true);

    await repository.confirmAttendance(TEACHER,session.id,studentId,'present');
    await repository.confirmAttendance(TEACHER,session.id,studentId,'absent');
    await repository.adminUnlinkGuardian(ADMIN,guardianId,studentId,'unlink');
    const count=sender.deliveries.length;
    await worker.run(new Date());
    expect(sender.deliveries).toHaveLength(count);
    await expect(repository.createParentContactRequestByTelegram('777778002',studentId,'learning','Потрібна допомога')).rejects.toMatchObject({statusCode:403});
  });

  it('does not notify a deactivated student',async()=>{
    const {repository,studentId}=await fixture(),now=new Date();
    await repository.createClassSession(TEACHER,{groupId:PILOT.groupId,courseId:'course',title:'Disabled student class',startsAt:new Date(now.getTime()+24*60*60*1000).toISOString(),endsAt:new Date(now.getTime()+25*60*60*1000).toISOString()});
    await repository.adminSetAccountStatus(ADMIN,studentId,'disabled','Notification security test','disable-student');
    const sender=new CaptureSender(),worker=new NotificationWorker(repository,sender,0,19);
    await worker.run(now);
    expect(sender.deliveries.some(item=>item.recipientUserId===studentId)).toBe(false);
  });

  it('persists consultation requests, weekly digests, failures and admin resolution',async()=>{
    const {repository,studentId,guardianId}=await fixture();
    const request=await repository.createParentContactRequestByTelegram('777778002',studentId,'project','Допоможіть із наступним кроком');
    let workspace=await repository.getAdminWorkspace(ADMIN);
    expect(workspace.parentRequests?.find(item=>item.id===request.id)).toMatchObject({status:'new',guardianId,studentId});
    await repository.adminResolveParentContactRequest(ADMIN,request.id,'resolve');
    workspace=await repository.getAdminWorkspace(ADMIN);
    expect(workspace.parentRequests?.find(item=>item.id===request.id)).toMatchObject({status:'resolved'});

    const sundayKyiv19=new Date('2026-09-27T16:00:00.000Z'),sender=new CaptureSender(true),worker=new NotificationWorker(repository,sender,0,19);
    expect((await worker.run(sundayKyiv19)).failed).toBeGreaterThanOrEqual(1);
    expect(sender.deliveries.find(item=>item.recipientUserId===guardianId)).toMatchObject({recipientUserId:guardianId,type:'guardian_weekly_digest',attempts:1});
    expect((await worker.run(new Date(sundayKyiv19.getTime()+4*60*1000))).claimed).toBe(0);
    expect((await worker.run(new Date(sundayKyiv19.getTime()+6*60*1000))).failed).toBeGreaterThanOrEqual(1);
    expect(sender.deliveries.filter(item=>item.recipientUserId===guardianId).at(-1)?.attempts).toBe(2);
  });
});
