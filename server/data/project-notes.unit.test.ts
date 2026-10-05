import {describe,it,expect} from 'vitest';
import {MemoryRepository} from './memory-repository.js';
import {MemoryPilotRuntimeStore} from './pilot-runtime-store.js';
import {DEV_IDS,PILOT,PILOT_TEACHERS} from './seed.js';
import {createRuntimeSnapshot,parseRuntimeSnapshot} from './state-snapshot.js';
const student=DEV_IDS.user,teacher=PILOT_TEACHERS[1]!.id,other='10000000-0000-4000-8000-000000000002',admin='14000000-0000-4000-8000-000000000001';
const noteInput={contentText:'A real project note',contentUrl:'https://example.test/project',clientRequestId:'80000000-0000-4000-8000-000000000001'};
async function fixture(){const runtime=new MemoryPilotRuntimeStore(),repo=new MemoryRepository(undefined,{runtimeStore:runtime}),project=await repo.createProject(student,{title:'Real project',summary:'Initial'});return{runtime,repo,project};}
describe('shared project notes, links and Teacher feedback',()=>{
 it('persists notes and Teacher replies once through cold reads and backups',async()=>{
  const {repo,runtime,project}=await fixture();const first=await repo.addProjectNote(student,project.id,noteInput);await repo.addProjectNote(student,project.id,noteInput);expect(first.notes).toHaveLength(1);const note=first.notes![0]!;
  const reply={contentText:'Test the user flow',clientRequestId:'80000000-0000-4000-8000-000000000002'},before=await repo.academicRevision(student);
  await repo.replyProjectNote(teacher,student,project.id,note.id,reply,'reply');await repo.replyProjectNote(teacher,student,project.id,note.id,reply,'retry');
  expect(await repo.academicRevision(student)).not.toEqual(before);const actual=(await repo.listProjects(student))[0]!;expect(actual.notes?.[0]?.replies).toEqual([expect.objectContaining({contentText:reply.contentText,teacherId:teacher})]);expect(actual.completionPercent).toBe(0);expect(actual.tasks[1]?.status).toBe('locked');
  expect((await repo.getTeacherWorkspace(teacher)).students.find(s=>s.id===student)?.projects[0]?.notes).toEqual(actual.notes);expect(await repo.listProjects(other)).toEqual([]);
  const raw=parseRuntimeSnapshot(createRuntimeSnapshot(await runtime.read(),{environment:'local',namespace:'qa'}));const cold=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(raw.state)});expect(await cold.listProjects(student)).toEqual([actual]);
 });
 it('validates content and HTTPS links and keeps user text as text',async()=>{
  const {repo,project}=await fixture();
  for(const contentUrl of ['javascript:alert(1)','http://example.test','https://user:password@example.test','not a link'])await expect(repo.addProjectNote(student,project.id,{...noteInput,contentUrl})).rejects.toMatchObject({statusCode:400});
  await expect(repo.addProjectNote(student,project.id,{contentText:'',clientRequestId:noteInput.clientRequestId})).rejects.toMatchObject({statusCode:400});
  await expect(repo.addProjectNote(student,project.id,{...noteInput,contentText:'x'.repeat(20001)})).rejects.toMatchObject({statusCode:400});
  const text='<script>throw new Error("unsafe")</script> & a real note';const actual=await repo.addProjectNote(student,project.id,{...noteInput,contentText:text});expect(actual.notes![0]!.contentText).toBe(text);
 });
 it('rejects foreign student writes and Student feedback actions',async()=>{
  const {repo,project}=await fixture(),withNote=await repo.addProjectNote(student,project.id,noteInput),note=withNote.notes![0]!;
  await expect(repo.addProjectNote(other,project.id,noteInput)).rejects.toMatchObject({statusCode:404});
  await expect(repo.replyProjectNote(student,student,project.id,note.id,{contentText:'Forged teacher reply',clientRequestId:noteInput.clientRequestId},'self')).rejects.toMatchObject({statusCode:403});
  await expect(repo.replyProjectNote(teacher,other,project.id,note.id,{contentText:'Wrong owner',clientRequestId:noteInput.clientRequestId},'foreign')).rejects.toMatchObject({statusCode:404});
 });
 it('keeps the journal when a group is archived but blocks writes until restore',async()=>{
  const {repo,runtime,project}=await fixture(),withNote=await repo.addProjectNote(student,project.id,noteInput),note=withNote.notes![0]!;
  await repo.archiveGroup(admin,PILOT.groupId,1,'archive');
  await expect(repo.addProjectNote(student,project.id,{...noteInput,clientRequestId:'80000000-0000-4000-8000-000000000003'})).rejects.toMatchObject({statusCode:403});await expect(repo.replyProjectNote(teacher,student,project.id,note.id,{contentText:'Reply',clientRequestId:noteInput.clientRequestId},'archived')).rejects.toMatchObject({statusCode:409});
  expect((await runtime.read()).projects[student]![0]!.notes).toHaveLength(1);
 });
});
