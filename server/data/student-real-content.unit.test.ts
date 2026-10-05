import {describe,expect,it} from 'vitest';
import {MemoryRepository} from './memory-repository.js';
import {createPilotRuntimeState,MemoryPilotRuntimeStore,migratePilotRuntimeState} from './pilot-runtime-store.js';
import {DEV_IDS,PILOT,PILOT_TEACHERS,SEEDED_LESSONS} from './seed.js';
import {PILOT_SESSION_TITLES} from './group-model.js';

const teacher=PILOT_TEACHERS[1]!.id,admin='14000000-0000-4000-8000-000000000001';
describe('student sees assigned content instead of automatic templates',()=>{
 it('starts with no lessons or homework and rejects direct access to the old catalog',async()=>{
  const state=createPilotRuntimeState(),repository=new MemoryRepository();
  expect(state.classSessions).toEqual([]);expect(state.homework).toEqual([]);
  expect(await repository.getLearning(DEV_IDS.user)).toMatchObject({course:{totalLessons:0,progressPercent:0},modules:[]});
  expect((await repository.getSchedule(DEV_IDS.user)).upcoming).toEqual([]);expect(await repository.listHomework(DEV_IDS.user)).toEqual([]);
  expect(await repository.getHome(DEV_IDS.user)).toMatchObject({currentLesson:null,nextClass:null,homeworkDue:null});
  expect(await repository.getLesson(DEV_IDS.user,SEEDED_LESSONS[0]!.id)).toBeNull();
  await expect(repository.completeLesson(DEV_IDS.user,SEEDED_LESSONS[0]!.id,'unassigned')).rejects.toMatchObject({statusCode:404});
 });
 it('retires legacy automatic templates once without deleting attempts, grades or progress',()=>{
  const state=createPilotRuntimeState({includeDemoContent:true});delete state.seededContentCleanupApplied;
  const homeworkId=state.homework[0]!.id,lessonId=state.classSessions[0]!.lessonId!;
  state.lessonProgress[DEV_IDS.user]![lessonId]={progressPercent:100,completedAt:'2026-10-01T12:00:00.000Z'};
  state.submissions.push({id:'retained-attempt',studentId:DEV_IDS.user,homeworkId,attemptNumber:1,submittedAt:'2026-10-01T12:00:00.000Z',studentComment:'',contentText:'Retained answer',contentUrl:null,status:'completed',review:{score:9,effort:'high_effort',status:'completed',feedback:'Retained feedback',reviewedAt:'2026-10-01T13:00:00.000Z'}});
  const migrated=migratePilotRuntimeState(state);
  expect(migrated.classSessions.every(s=>s.status==='archived')).toBe(true);expect(migrated.homework.every(h=>h.status==='unpublished')).toBe(true);
  expect(migrated.submissions[0]).toMatchObject({contentText:'Retained answer',review:{score:9,feedback:'Retained feedback'}});
  expect(migrated.lessonProgress[DEV_IDS.user]![lessonId]?.progressPercent).toBe(100);
  migrated.homework[0]!.status='published';migrated.classSessions[0]!.status='scheduled';
  expect(migratePilotRuntimeState(migrated).homework[0]!.status).toBe('published');expect(migrated.classSessions[0]!.status).toBe('scheduled');
 });
 it('preserves recognizable teacher edits instead of treating them as untouched templates',()=>{
  const state=createPilotRuntimeState({includeDemoContent:true});delete state.seededContentCleanupApplied;
  state.homework[0]!.instructions='Teacher-authored task';state.classSessions[0]!.title='Teacher-authored lesson';state.classSessions[1]!.status='completed';
  const migrated=migratePilotRuntimeState(state);
  expect(migrated.homework[0]!.status).toBe('published');expect(migrated.classSessions[0]!.status).toBe('scheduled');expect(migrated.classSessions[1]!.status).toBe('completed');
 });
 it('preserves original sessions with teacher-authored homework, descriptions or explicit status changes',()=>{
  const state=createPilotRuntimeState({includeDemoContent:true});delete state.seededContentCleanupApplied;
  state.homework[0]!.instructions='Real teacher task linked to the original session';
  state.classSessions[1]!.description='Real teacher description';
  state.classSessions[2]!.changedAt='2026-10-01T12:00:00.000Z';
  state.homework[4]!.resources=[{id:'teacher-material',kind:'link',title:'Teacher material',url:'https://example.test/material'}];
  const migrated=migratePilotRuntimeState(state);
  expect(migrated.classSessions.slice(0,3).map(s=>s.status)).toEqual(['scheduled','scheduled','scheduled']);
  expect(migrated.classSessions[3]!.status).toBe('archived');
  expect(migrated.homework[4]!.status).toBe('published');expect(migrated.classSessions[4]!.status).toBe('scheduled');
 });
 it('uses the actual group sessions for the route, cancellation and direct lesson access',async()=>{
  const runtime=new MemoryPilotRuntimeStore(),repository=new MemoryRepository(undefined,{runtimeStore:runtime});
  const input={name:'Реальна група',academicYear:2027,startsOn:'2027-03-01',weekdays:[1],time:'17:00',teacherId:teacher,status:'active' as const,lessonCount:8};
  const group=await repository.createGroup(teacher,input,'real');await repository.setGroupStudent(admin,group.id,DEV_IDS.user,true,1,'assign');
  const sessions=(await repository.getSchedule(DEV_IDS.user)).upcoming,learning=await repository.getLearning(DEV_IDS.user);
  expect(learning.modules[0]!.lessons.map(l=>l.title)).toEqual(PILOT_SESSION_TITLES);expect(learning.modules[0]!.lessons.map(l=>l.id)).toEqual(sessions.map(s=>s.id));
  const first=sessions[0]!;expect(await repository.getLesson(DEV_IDS.user,first.id)).toMatchObject({id:first.id,title:first.title,content:{task:{prompt:''}}});
  await repository.updateTeacherClass(teacher,first.id,{status:'cancelled'});
  expect((await repository.getLearning(DEV_IDS.user)).course.totalLessons).toBe(7);expect(await repository.getLesson(DEV_IDS.user,first.id)).toBeNull();
  await repository.archiveGroup(teacher,group.id,1,'archive');expect((await repository.getLearning(DEV_IDS.user)).modules).toEqual([]);
  await repository.updateGroup(teacher,group.id,{...input,expectedVersion:2},'restore');expect((await repository.getLearning(DEV_IDS.user)).course.totalLessons).toBe(7);
  await repository.updateTeacherClass(teacher,first.id,{status:'scheduled'});expect((await repository.getLearning(DEV_IDS.user)).course.totalLessons).toBe(8);
 });
 it('shows homework only after a real teacher publishes it and retains it across restart',async()=>{
  const runtime=new MemoryPilotRuntimeStore(),repository=new MemoryRepository(undefined,{runtimeStore:runtime});
  const h=await repository.createHomework(teacher,{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Реальне ДЗ',instructions:'Робота викладача',xpReward:0,status:'draft'});
  expect(await repository.listHomework(DEV_IDS.user)).toEqual([]);await repository.publishHomework(teacher,h.id,new Date().toISOString());
  expect((await repository.listHomework(DEV_IDS.user)).map(item=>item.id)).toEqual([h.id]);
  await repository.updateHomework(teacher,h.id,{status:'unpublished',expectedVersion:2},'withdraw');
  const restarted=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(await runtime.read())});expect(await restarted.listHomework(DEV_IDS.user)).toEqual([]);
 });
});
