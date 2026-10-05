import {createAssignedRepository,createAssignedPilotState} from './assigned-pilot.test-fixture.js';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { createPilotRuntimeState, MemoryPilotRuntimeStore, migratePilotRuntimeState, type PilotNotification } from './pilot-runtime-store.js';
import { DEV_IDS, PILOT, PILOT_TEACHERS } from './seed.js';
import { PILOT_SESSION_TITLES, zonedStart, type GroupInput } from './group-model.js';
import { evaluateDelivery } from './notification-policy.js';

const ADMIN='14000000-0000-4000-8000-000000000001';
const TEACHER=PILOT_TEACHERS[1]!.id; // Teacher without the admin role.
const OTHER=PILOT_TEACHERS[0]!.id;
const STUDENT=DEV_IDS.user;
const SECOND='10000000-0000-4000-8000-000000000002';
const input:GroupInput={name:'Пілот 2027',academicYear:2027,startsOn:'2027-03-22',lessonCount:8,weekdays:[1,4],time:'17:00',teacherId:TEACHER,status:'active'};
function pair(){const runtime=new MemoryPilotRuntimeStore(createAssignedPilotState());return{runtime,first:createAssignedRepository(undefined,{runtimeStore:runtime}),second:createAssignedRepository(undefined,{runtimeStore:runtime})};}
async function add(repository:MemoryRepository,runtime:MemoryPilotRuntimeStore,groupId:string,studentId=STUDENT){await repository.setGroupStudent(ADMIN,groupId,studentId,true,(await runtime.read()).directory[studentId]!.version,'add');}

describe('shared academic state and group ownership',()=>{
  it('checks live lesson, homework and group membership before delivering queued reminders',()=>{
    const state=createAssignedPilotState(),now=new Date('2026-10-05T12:00:00.000Z');
    state.directory[STUDENT]!.telegramId='synthetic-test-chat';
    const notification:PilotNotification={id:'queued-test',recipientUserId:STUDENT,recipientTelegramId:'synthetic-test-chat',type:'student_class_1h',relatedEntityId:state.classSessions[0]!.id,scheduledFor:now.toISOString(),sentAt:null,status:'pending',attempts:0,lastAttemptAt:null,nextAttemptAt:null,idempotencyKey:'queued-test',safeMetadata:{text:'Synthetic reminder'},errorCode:null,dueAt:now.toISOString(),expiresAt:new Date(now.getTime()+86400000).toISOString(),entityStamp:null,readAt:null};
    state.classSessions[0]!.status='archived';
    expect(evaluateDelivery(state,notification,now)).toEqual({deliver:false,reason:'CLASS_INACTIVE'});
    state.classSessions[0]!.status='scheduled';state.directory[STUDENT]!.groupId=null;
    expect(evaluateDelivery(state,notification,now)).toEqual({deliver:false,reason:'GROUP_MEMBERSHIP_CHANGED'});
    state.directory[STUDENT]!.groupId=PILOT.groupId;
    notification.type='student_homework_assigned';notification.relatedEntityId=state.homework[0]!.id;state.homework[0]!.status='unpublished';
    expect(evaluateDelivery(state,notification,now)).toEqual({deliver:false,reason:'HOMEWORK_INACTIVE'});
    state.homework[0]!.status='published';state.groups[0]!.status='archived';
    expect(evaluateDelivery(state,notification,now)).toEqual({deliver:false,reason:'HOMEWORK_INACTIVE'});
  });
  it('creates eight persistent sessions in Kyiv time and exposes them to the assigned teacher/admin',async()=>{
    const {first,second,runtime}=pair();const {id}=await first.createGroup(TEACHER,input,'create');
    const sessions=(await second.getTeacherWorkspace(TEACHER)).sessions.filter(s=>s.groupId===id);
    expect(sessions.map(s=>s.title)).toEqual(PILOT_SESSION_TITLES);
    expect(sessions.map(s=>s.number)).toEqual([1,2,3,4,5,6,7,8]);
    expect(sessions[0]?.startsAt).toBe('2027-03-22T15:00:00.000Z');
    expect(sessions[2]?.startsAt).toBe('2027-03-29T14:00:00.000Z'); // Summer-time transition.
    expect((await second.getAdminWorkspace(ADMIN)).groups.some(g=>g.id===id)).toBe(true);
    expect((await second.getTeacherWorkspace(OTHER)).groups.some(g=>g.id===id)).toBe(false);
    await add(first,runtime,id);
    await add(first,runtime,id,SECOND);
    expect((await second.getSchedule(STUDENT)).upcoming.map(s=>s.id)).toEqual(sessions.map(s=>s.id));
    expect((await second.getSchedule(SECOND)).upcoming).toEqual((await first.getSchedule(STUDENT)).upcoming);
  });

  it('updates a stable schedule, retains manually moved/completed sessions and archives excess occurrences',async()=>{
    const {first,second,runtime}=pair();const {id}=await first.createGroup(TEACHER,input,'create');
    const before=(await runtime.read()).classSessions.filter(s=>s.groupId===id);
    await first.rescheduleClass(TEACHER,before[1]!.id,{startsAt:'2027-04-01T12:00:00.000Z',endsAt:'2027-04-01T13:00:00.000Z'});
    await first.updateTeacherClass(TEACHER,before[0]!.id,{status:'completed'});
    await first.updateGroup(TEACHER,id,{...input,name:'Оновлена',time:'18:00',lessonCount:6,expectedVersion:1},'edit');
    let sessions=(await second.getTeacherWorkspace(TEACHER)).sessions.filter(s=>s.groupId===id);
    expect(sessions.find(s=>s.id===before[0]!.id)).toMatchObject({status:'completed',startsAt:before[0]!.startsAt});
    expect(sessions.find(s=>s.id===before[1]!.id)).toMatchObject({status:'rescheduled',startsAt:'2027-04-01T12:00:00.000Z'});
    expect(sessions.find(s=>s.id===before[2]!.id)?.startsAt).toBe('2027-03-29T15:00:00.000Z');
    expect(sessions.filter(s=>s.status==='archived')).toHaveLength(2);
    await first.updateGroup(TEACHER,id,{...input,time:'18:00',expectedVersion:2},'restore-count');
    sessions=(await runtime.read()).classSessions.filter(s=>s.groupId===id);
    expect(new Set(sessions.map(s=>s.id))).toEqual(new Set(before.map(s=>s.id)));
    expect(sessions.filter(s=>s.status==='archived')).toHaveLength(0);
    await expect(first.updateGroup(TEACHER,id,{...input,expectedVersion:1},'stale')).rejects.toMatchObject({statusCode:409});
  });

  it('uses one state for create/update/cancel/restore/archive and survives a repository restart',async()=>{
    const {first,second,runtime}=pair();const {id}=await first.createGroup(TEACHER,input,'create');await add(first,runtime,id);
    const newClass=await first.createClassSession(TEACHER,{groupId:id,courseId:DEV_IDS.course,title:'Нова зустріч',startsAt:'2027-04-20T14:00:00.000Z',endsAt:'2027-04-20T15:30:00.000Z'});
    const revision=await second.academicRevision(STUDENT);
    await first.updateTeacherClass(TEACHER,newClass.id,{startsAt:'2027-04-21T14:00:00.000Z',endsAt:'2027-04-21T15:30:00.000Z'});
    expect((await second.getSchedule(STUDENT)).upcoming.find(s=>s.id===newClass.id)?.startsAt).toBe('2027-04-21T14:00:00.000Z');
    expect(await second.academicRevision(STUDENT)).not.toEqual(revision);
    for(const status of ['cancelled','archived','completed'] as const){
      await first.updateTeacherClass(ADMIN,newClass.id,{status});
      expect((await second.getSchedule(STUDENT)).upcoming.some(s=>s.id===newClass.id)).toBe(false);
      expect((await second.getAdminWorkspace(ADMIN)).sessions.find(s=>s.id===newClass.id)?.status).toBe(status);
      await first.updateTeacherClass(TEACHER,newClass.id,{status:'scheduled'});
      expect((await second.getSchedule(STUDENT)).upcoming.some(s=>s.id===newClass.id)).toBe(true);
    }
    const restarted=createAssignedRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(await runtime.read())});
    expect(await restarted.getSchedule(STUDENT)).toEqual(await second.getSchedule(STUDENT));
  });

  it('enforces ownership on group, session, homework, attendance and private-note writes',async()=>{
    const {first,runtime}=pair();const {id}=await first.createGroup(ADMIN,{...input,teacherId:OTHER},'other');await add(first,runtime,id);
    const session=(await runtime.read()).classSessions.find(s=>s.groupId===id)!;
    const homework=await first.createHomework(ADMIN,{groupId:id,courseId:DEV_IDS.course,title:'Приватне',instructions:'Завдання',xpReward:10,status:'draft'});
    for(const operation of [
      ()=>first.getGroupDetail(TEACHER,id),
      ()=>first.updateTeacherClass(TEACHER,session.id,{status:'cancelled'}),
      ()=>first.bulkConfirmAttendance(TEACHER,session.id,[{studentId:STUDENT,status:'present'}]),
      ()=>first.updateHomework(TEACHER,homework.id,{expectedVersion:1,status:'published'},'foreign'),
      ()=>first.deleteHomework(TEACHER,homework.id,1,'foreign'),
      ()=>first.createTeacherNote(TEACHER,STUDENT,{category:'general',content:'Foreign'}),
      ()=>first.archiveGroup(TEACHER,id,1,'foreign')
    ])await expect(operation()).rejects.toMatchObject({statusCode:403});
    await expect(first.createGroup(TEACHER,{...input,teacherId:OTHER},'assign-other')).rejects.toMatchObject({statusCode:403});
    await expect(first.createGroup(STUDENT,input,'student')).rejects.toMatchObject({statusCode:403});
  });

  it('archives a group without deleting children/history, then restores it',async()=>{
    const {first,second,runtime}=pair();const {id}=await first.createGroup(TEACHER,input,'create');await add(first,runtime,id);
    const session=(await runtime.read()).classSessions.find(s=>s.groupId===id)!;
    await first.confirmAttendance(TEACHER,session.id,STUDENT,'present');
    const homework=await first.createHomework(TEACHER,{groupId:id,courseId:DEV_IDS.course,title:'Робота',instructions:'Опис',xpReward:10,status:'published'});
    const submission=await first.submitHomework(STUDENT,homework.id,{contentText:'Відповідь'});
    await first.archiveGroup(TEACHER,id,1,'archive');
    expect((await second.getSchedule(STUDENT)).upcoming).toEqual([]);
    expect(await second.listHomework(STUDENT)).toEqual([]);
    expect((await second.getAdminWorkspace(ADMIN)).groups.find(g=>g.id===id)?.status).toBe('archived');
    const raw=await runtime.read();expect(raw.submissions.some(s=>s.id===submission.id)).toBe(true);expect(raw.attendance.some(a=>a.sessionId===session.id)).toBe(true);
    await first.updateGroup(ADMIN,id,{...input,expectedVersion:2},'restore');
    expect((await second.listHomework(STUDENT)).some(h=>h.id===homework.id)).toBe(true);
    await first.setGroupStudent(TEACHER,id,STUDENT,false,(await runtime.read()).directory[STUDENT]!.version,'remove');
    expect((await runtime.read()).directory[STUDENT]).toMatchObject({groupId:null,status:'active'});
    expect((await runtime.read()).submissions.some(s=>s.id===submission.id)).toBe(true);
  });

  it('migrates the original persisted state without reseeding or duplicating manual sessions',async()=>{
    const old=createAssignedPilotState();delete (old as Partial<typeof old>).groups;
    old.classSessions.forEach(s=>{delete s.number;delete s.scheduleManaged});old.classSessions[0]!.status='cancelled';
    const migrated=migratePilotRuntimeState(old);
    expect(migrated.classSessions[0]!.status).toBe('cancelled');expect(migrated.classSessions.map(s=>s.number)).toEqual([1,2,3,4,5,6,7,8]);
    const repository=createAssignedRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(migrated)});
    const group=migrated.groups[0]!;
    await repository.updateGroup(ADMIN,PILOT.groupId,{...input,name:group.name,teacherId:group.teacherId,startsOn:'2027-01-01',expectedVersion:1},'edit-legacy');
    expect((await repository.getTeacherWorkspace(OTHER)).sessions).toHaveLength(8);
    expect(()=>zonedStart('2027-03-28','03:30','Europe/Kyiv')).toThrow();
  });
});

describe('homework lifecycle preserves submitted work',()=>{
  it('changes the authorized revision on submission/review without exposing another student’s work',async()=>{
    const {first,second}=pair();const id='73000000-0000-4000-8000-000000000001';
    const before=await first.academicRevision(TEACHER),other=await first.academicRevision(SECOND);
    const submission=await second.submitHomework(STUDENT,id,{contentText:'Private QA answer'});
    expect(await first.academicRevision(TEACHER)).not.toEqual(before);
    expect(await first.academicRevision(SECOND)).toEqual(other);
    const own=await first.academicRevision(STUDENT);
    await first.reviewHomework(TEACHER,submission.id,{score:8,effort:'good_effort',status:'completed',feedback:'Private feedback'});
    expect(await first.academicRevision(STUDENT)).not.toEqual(own);
    expect(JSON.stringify(await first.academicRevision(STUDENT))).not.toMatch(/answer|feedback|studentId|homeworkId/);
  });
  it('publishes, edits, unpublishes, archives and restores one persistent assignment',async()=>{
    const {first,second,runtime}=pair();const created=await first.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'QA assignment',instructions:'Task',xpReward:20,status:'draft'});
    expect((await second.listHomework(STUDENT)).some(h=>h.id===created.id)).toBe(false);
    await first.publishHomework(TEACHER,created.id,new Date().toISOString());
    const submission=await second.submitHomework(STUDENT,created.id,{contentText:'Учнівська відповідь'});
    await first.reviewHomework(TEACHER,submission.id,{score:9,effort:'high_effort',status:'completed',feedback:'Збережений відгук'});
    await first.updateHomework(TEACHER,created.id,{expectedVersion:2,title:'Edited',status:'unpublished'},'unpublish');
    expect((await second.listHomework(STUDENT)).some(h=>h.id===created.id)).toBe(false);
    await expect(second.submitHomework(STUDENT,created.id,{contentText:'Late'})).rejects.toMatchObject({statusCode:404});
    await first.updateHomework(TEACHER,created.id,{expectedVersion:3,status:'archived'},'archive');
    await expect(first.deleteHomework(TEACHER,created.id,4,'delete')).rejects.toMatchObject({code:'HOMEWORK_HAS_SUBMISSIONS'});
    expect((await runtime.read()).submissions.find(s=>s.id===submission.id)).toMatchObject({contentText:'Учнівська відповідь',review:{score:9,feedback:'Збережений відгук'}});
    await first.updateHomework(TEACHER,created.id,{expectedVersion:4,status:'draft'},'restore');
    await first.publishHomework(TEACHER,created.id,new Date().toISOString());
    const restarted=createAssignedRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(await runtime.read())});
    expect((await restarted.listHomework(STUDENT)).find(h=>h.id===created.id)).toMatchObject({title:'Edited',latestSubmission:{id:submission.id}});
    await expect(first.updateHomework(TEACHER,created.id,{expectedVersion:1,title:'Stale'},'stale')).rejects.toMatchObject({statusCode:409});
  });
  it('allows permanent deletion only before any submission exists',async()=>{
    const {first,second}=pair();const h=await first.createHomework(TEACHER,{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Unused',instructions:'Task',xpReward:0,status:'draft'});
    await first.deleteHomework(TEACHER,h.id,1,'delete');
    expect((await second.getTeacherWorkspace(TEACHER)).homework.some(x=>x.id===h.id)).toBe(false);
  });
});
