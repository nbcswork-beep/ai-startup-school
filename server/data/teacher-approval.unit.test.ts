import {describe,it,expect} from 'vitest';
import {MemoryRepository} from './memory-repository.js';
import {createPilotRuntimeState,MemoryPilotRuntimeStore,migratePilotRuntimeState} from './pilot-runtime-store.js';
import {DEV_IDS,PILOT,PILOT_TEACHERS,SEEDED_LESSONS} from './seed.js';
import {PILOT_SESSION_TITLES} from './group-model.js';
import {createRuntimeSnapshot,parseRuntimeSnapshot} from './state-snapshot.js';
const student=DEV_IDS.user,teacher=PILOT_TEACHERS[1]!.id,admin='14000000-0000-4000-8000-000000000001';
const approved={expectedVersion:1,decision:'approved' as const,feedback:''};
async function fixture(){
 const runtime=new MemoryPilotRuntimeStore(),repo=new MemoryRepository(undefined,{runtimeStore:runtime});
 const session=await repo.createClassSession(teacher,{groupId:PILOT.groupId,courseId:DEV_IDS.course,lessonId:SEEDED_LESSONS[0]!.id,title:'Real first lesson',startsAt:'2027-03-01T15:00:00.000Z',endsAt:'2027-03-01T16:30:00.000Z'});
 const second=await repo.createClassSession(teacher,{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Real second lesson',startsAt:'2027-03-08T15:00:00.000Z',endsAt:'2027-03-08T16:30:00.000Z'});
 return{runtime,repo,session,second};
}
describe('teacher confirmation is the only completion authority',()=>{
 it('removes cancelled, archived or foreign sessions and unpublished homework from recovery cards',async()=>{
  const {repo,runtime,session}=await fixture();await repo.confirmAttendance(teacher,session.id,student,'absent');
  const homework=await repo.createHomework(teacher,{groupId:PILOT.groupId,courseId:DEV_IDS.course,classSessionId:session.id,title:'Real recovery work',instructions:'A real task',status:'draft',xpReward:0});await repo.publishHomework(teacher,homework.id,new Date().toISOString());
  expect((await repo.listMissedLessonRecoveries(student))[0]?.homework?.id).toBe(homework.id);
  await repo.updateHomework(teacher,homework.id,{expectedVersion:2,status:'unpublished'},'withdraw');expect((await repo.listMissedLessonRecoveries(student))[0]?.homework).toBeNull();
  for(const status of ['cancelled','archived'] as const){await repo.updateTeacherClass(teacher,session.id,{status});expect(await repo.listMissedLessonRecoveries(student)).toEqual([]);await repo.updateTeacherClass(teacher,session.id,{status:'scheduled'});}
  await repo.setGroupStudent(admin,PILOT.groupId,student,false,(await runtime.read()).directory[student]!.version,'remove');expect(await repo.listMissedLessonRecoveries(student)).toEqual([]);
 });
 it('retains historical project records while replacing self-checked completion with sequential review',async()=>{
  const {repo,runtime}=await fixture(),project=await repo.createProject(student,{title:'Existing project',summary:'Retain this'}),state=await runtime.read();delete state.academicApprovalMigrationApplied;
  const original=state.projects[student]![0]!;original.status='completed';original.tasks.forEach(t=>t.status='completed');state.xp[student]=520;
  const restored=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(state)}),result=(await restored.listProjects(student))[0]!;
  expect(result).toMatchObject({id:project.id,title:'Existing project',summary:'Retain this',completionPercent:0,status:'active'});expect(result.tasks.map(t=>t.status)).toEqual(['in_progress','locked','locked','locked']);expect(result.tasks.map(t=>t.id)).toEqual(project.tasks.map(t=>t.id));
  await restored.submitProjectTask(student,project.id,result.tasks[0]!.id,{contentText:'A real response',expectedVersion:2});await restored.reviewProjectTask(teacher,student,project.id,result.tasks[0]!.id,{...approved,expectedVersion:3},'confirm');expect((await restored.getHome(student)).viewer.xp).toBe(520);
 });
 it('keeps a lesson pending, next lesson locked and XP unchanged until Teacher approves once',async()=>{
  const {repo,session,second}=await fixture();const xp=(await repo.getHome(student)).viewer.xp;
  const teacherBefore=await repo.academicRevision(teacher);await repo.completeLesson(student,session.id,'request-one');await repo.completeLesson(student,session.id,'request-again');
  expect((await repo.getLearning(student)).course.completedLessons).toBe(0);expect((await repo.getHome(student)).viewer.xp).toBe(xp);
  expect(await repo.academicRevision(teacher)).not.toEqual(teacherBefore);await expect(repo.getLesson(student,second.id)).rejects.toMatchObject({statusCode:403});
  await repo.reviewLessonCompletion(teacher,session.id,student,approved,'confirm');
  expect((await repo.getHome(student)).viewer.xp).toBe(xp+80);expect((await repo.getLearning(student)).course.completedLessons).toBe(1);expect(await repo.getLesson(student,second.id)).not.toBeNull();
  await expect(repo.reviewLessonCompletion(admin,session.id,student,approved,'duplicate')).rejects.toMatchObject({statusCode:409});expect((await repo.getHome(student)).viewer.xp).toBe(xp+80);
 });
 it('supports lesson return and resubmission, and rejects cancellation or moved membership during review',async()=>{
  const {repo,runtime,session}=await fixture();await repo.completeLesson(student,session.id,'request');
  await repo.reviewLessonCompletion(teacher,session.id,student,{...approved,decision:'needs_revision',feedback:'Review the example'},'return');
  expect((await repo.getLesson(student,session.id))?.completionReview).toMatchObject({status:'needs_revision',feedback:'Review the example',version:2});
  await repo.completeLesson(student,session.id,'retry');await repo.updateTeacherClass(teacher,session.id,{status:'cancelled'});
  await expect(repo.reviewLessonCompletion(teacher,session.id,student,{...approved,expectedVersion:3},'cancelled')).rejects.toMatchObject({statusCode:409});
  await repo.updateTeacherClass(teacher,session.id,{status:'scheduled'});await repo.setGroupStudent(admin,PILOT.groupId,student,false,(await runtime.read()).directory[student]!.version,'remove');
  await expect(repo.reviewLessonCompletion(teacher,session.id,student,{...approved,expectedVersion:3},'moved')).rejects.toMatchObject({statusCode:403});
 });
 it('requires a written first project stage, prevents skipping and disables the legacy self-complete endpoint',async()=>{
  const {repo}=await fixture();const p=await repo.createProject(student,{title:'Real product',summary:'Problem'}),first=p.tasks[0]!,next=p.tasks[1]!;
  await expect(repo.submitProjectTask(student,p.id,first.id,{contentText:' ',expectedVersion:1})).rejects.toMatchObject({statusCode:400});
  await expect(repo.submitProjectTask(student,p.id,next.id,{contentText:'Skip first',expectedVersion:1})).rejects.toMatchObject({statusCode:403});
  await expect(repo.completeProjectTask(student,p.id,first.id,'legacy')).rejects.toMatchObject({statusCode:409});
  const waiting=await repo.submitProjectTask(student,p.id,first.id,{contentText:'A concrete problem',expectedVersion:1});expect(waiting.completionPercent).toBe(0);expect(waiting.tasks[1]?.status).toBe('locked');
  await repo.reviewProjectTask(teacher,student,p.id,first.id,{...approved,expectedVersion:2},'confirm');
  const actual=(await repo.listProjects(student))[0]!;expect(actual.completionPercent).toBe(35);expect(actual.tasks[1]?.status).toBe('in_progress');expect(actual.stage).toMatchObject({position:2,total:4});
 });
 it('preserves project answers and feedback across return, resubmit, restart and backup',async()=>{
  const {repo,runtime}=await fixture();const p=await repo.createProject(student,{title:'Real product',summary:''}),task=p.tasks[0]!;
  const staffBefore=await repo.academicRevision(teacher);await repo.submitProjectTask(student,p.id,task.id,{contentText:'First response',expectedVersion:1});expect(await repo.academicRevision(teacher)).not.toEqual(staffBefore);
  await repo.reviewProjectTask(teacher,student,p.id,task.id,{expectedVersion:2,decision:'needs_revision',feedback:'Add evidence'},'return');
  expect((await repo.listProjects(student))[0]?.tasks[0]).toMatchObject({status:'needs_revision',contentText:'First response',feedback:'Add evidence'});
  await repo.submitProjectTask(student,p.id,task.id,{contentText:'Response with evidence',expectedVersion:3});
  await repo.reviewProjectTask(teacher,student,p.id,task.id,{...approved,expectedVersion:4},'confirm');
  const raw=await runtime.read();expect(raw.projects[student]?.[0]?.tasks[0]?.attempts).toEqual([expect.objectContaining({contentText:'First response',decision:'needs_revision',feedback:'Add evidence'}),expect.objectContaining({contentText:'Response with evidence',decision:'approved'})]);
  const snapshot=parseRuntimeSnapshot(createRuntimeSnapshot(raw,{environment:'local',namespace:'qa'}));const restarted=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(snapshot.state)});
  expect(await restarted.listProjects(student)).toEqual(await repo.listProjects(student));expect(snapshot.state.academicApprovalMigrationApplied).toBe(true);
 });
 it('rejects Student and foreign Teacher review, stale requests and duplicate XP',async()=>{
  const {repo}=await fixture();const p=await repo.createProject(student,{title:'Real product',summary:''}),task=p.tasks[0]!;
  await repo.submitProjectTask(student,p.id,task.id,{contentText:'Problem',expectedVersion:1});
  await expect(repo.reviewProjectTask(student,student,p.id,task.id,{...approved,expectedVersion:2},'self')).rejects.toMatchObject({statusCode:403});
  const foreign=await repo.createGroup(admin,{name:'Foreign group',academicYear:2027,startsOn:'2027-03-01',lessonCount:0,weekdays:[1],time:'17:00',teacherId:PILOT_TEACHERS[0]!.id,status:'active'},'create');
  const first=await repo.adminCreateStudent(admin,{firstName:'Foreign',lastName:'Student',groupId:foreign.id,status:'active'},'student');
  const otherProject=await repo.createProject(first.id,{title:'Foreign product',summary:''});await repo.submitProjectTask(first.id,otherProject.id,otherProject.tasks[0]!.id,{contentText:'Foreign answer',expectedVersion:1});
  await expect(repo.reviewProjectTask(teacher,first.id,otherProject.id,otherProject.tasks[0]!.id,{...approved,expectedVersion:2},'foreign')).rejects.toMatchObject({statusCode:403});
  await expect(repo.reviewProjectTask(teacher,student,p.id,task.id,approved,'stale')).rejects.toMatchObject({statusCode:409});
  await repo.reviewProjectTask(teacher,student,p.id,task.id,{...approved,expectedVersion:2},'first');const xp=(await repo.getHome(student)).viewer.xp;
  await expect(repo.reviewProjectTask(teacher,student,p.id,task.id,{...approved,expectedVersion:2},'duplicate')).rejects.toMatchObject({statusCode:409});expect((await repo.getHome(student)).viewer.xp).toBe(xp);
 });
 it('completes all four stages only through review and preserves sequential access',async()=>{
  const {repo}=await fixture();let p=await repo.createProject(student,{title:'Real product',summary:''});
  for(let i=0;i<4;i++){const task=p.tasks[i]!;await repo.submitProjectTask(student,p.id,task.id,{contentText:'Real stage '+i,expectedVersion:task.version??1});await repo.reviewProjectTask(teacher,student,p.id,task.id,{...approved,expectedVersion:(task.version??1)+1},'approve-'+i);p=(await repo.listProjects(student))[0]!;}
  expect(p).toMatchObject({status:'completed',completionPercent:100,stage:{position:4,total:4}});expect(p.tasks.every(t=>t.reviewedBy===teacher)).toBe(true);
 });
 it('retains historical self-completion data without presenting it as Teacher approval or granting XP again',()=>{
  const old=createPilotRuntimeState();delete old.academicApprovalMigrationApplied;
  old.lessonProgress[student]={legacy:{progressPercent:100,completedAt:'2026-10-01T10:00:00.000Z'}};old.xp[student]=80;
  const migrated=migratePilotRuntimeState(old);expect(migrated.lessonProgress[student]!.legacy).toMatchObject({progressPercent:0,reviewStatus:'pending_review',legacyProgressPercent:100,approvalXpAlreadyAwarded:true});expect(migrated.xp[student]).toBe(80);
  migrated.lessonProgress[student]!.legacy!.reviewStatus='approved';migrated.lessonProgress[student]!.legacy!.progressPercent=100;expect(migratePilotRuntimeState(migrated).lessonProgress[student]!.legacy!.progressPercent).toBe(100);
 });
});

describe('no silently generated lessons remain active',()=>{
 it('retires only untouched automatic group placeholders once and preserves all IDs',async()=>{
  const {runtime,repo,session}=await fixture(),state=await runtime.read();delete state.automaticGroupSessionsCleanupApplied;
  const placeholder={...state.classSessions[0]!,id:'automatic-placeholder',title:PILOT_SESSION_TITLES[0]!,lessonTitle:PILOT_SESSION_TITLES[0]!,lessonId:null,number:1,scheduleManaged:true,description:'',meetingProvider:null,meetingUrl:null};state.classSessions.push(placeholder);
  const migrated=migratePilotRuntimeState(state);expect(migrated.classSessions.find(s=>s.id===placeholder.id)?.status).toBe('archived');expect(migrated.classSessions.find(s=>s.id===session.id)?.status).toBe('scheduled');
  placeholder.status='scheduled';expect(migratePilotRuntimeState(migrated).classSessions.find(s=>s.id===placeholder.id)?.status).toBe('scheduled');expect(migrated.classSessions).toHaveLength(3);
 });
 it('preserves edited automatic lessons and any lesson with attendance, homework or progress',async()=>{
  const {runtime}=await fixture(),state=await runtime.read();delete state.automaticGroupSessionsCleanupApplied;
  const base={...state.classSessions[0]!,title:PILOT_SESSION_TITLES[0]!,lessonTitle:PILOT_SESSION_TITLES[0]!,lessonId:null,number:1,scheduleManaged:true,description:'',meetingProvider:null,meetingUrl:null};
  state.classSessions.push({...base,id:'notes',teacherNotes:'Real teacher notes'},{...base,id:'progress'},{...base,id:'attendance'},{...base,id:'homework'});
  state.lessonProgress[student]!.progress={progressPercent:20,completedAt:null};state.attendance.push({sessionId:'attendance',studentId:student,status:'present',note:'Retain',confirmedAt:'2026-10-01T10:00:00.000Z',confirmedBy:teacher});
  state.homework.push({id:'real-homework',groupId:PILOT.groupId,groupName:'Real',classSessionId:'homework',title:'Real work',instructions:'Authored',status:'draft',version:1,publishAt:null,dueAt:null,xpReward:0,submissionCount:0,reviewCount:0,needsRevisionCount:0,resources:[]});
  expect(migratePilotRuntimeState(state).classSessions.slice(2).every(s=>s.status==='scheduled')).toBe(true);
 });
});
