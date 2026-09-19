import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS } from './seed.js';

const teacher='12000000-0000-4000-8000-000000000001';
const guardian='13000000-0000-4000-8000-000000000001';
const group='70000000-0000-4000-8000-000000000001';
const session='71000000-0000-4000-8000-000000000001';

describe('Teacher OS operations and boundaries',()=>{
  it('returns only assigned workspace data and rejects unrelated identifiers',async()=>{
    const repository=new MemoryRepository();
    const workspace=await repository.getTeacherWorkspace(teacher);
    expect(workspace.groups.map(item=>item.id)).toEqual([group]);
    expect(workspace.students.map(item=>item.id)).toContain(DEV_IDS.user);
    await expect(repository.listGroupStudents(teacher,'70000000-0000-4000-8000-000000000099')).rejects.toMatchObject({statusCode:403});
    await expect(repository.updateTeacherClass(teacher,'71000000-ffff-4000-8000-000000000099',{title:'Foreign'})).rejects.toMatchObject({statusCode:403});
    await expect(repository.createTeacherNote(teacher,'10000000-ffff-4000-8000-000000000099',{category:'general',content:'Private'})).rejects.toMatchObject({statusCode:403});
  });

  it('supports authoritative bulk attendance with exceptions',async()=>{
    const repository=new MemoryRepository();
    await repository.bulkConfirmAttendance(teacher,session,[
      {studentId:DEV_IDS.user,status:'present'},
      {studentId:'10000000-0000-4000-8000-000000000002',status:'late',note:'Приєдналася о 17:08'}
    ]);
    const current=(await repository.getTeacherWorkspace(teacher)).sessions.find(item=>item.id===session)!;
    expect(current.attendance.find(item=>item.studentId===DEV_IDS.user)?.status).toBe('present');
    expect(current.attendance.find(item=>item.studentId!==DEV_IDS.user)).toMatchObject({status:'late',note:'Приєдналася о 17:08'});
  });

  it('keeps draft publishing explicit and validates mentor overlap',async()=>{
    const repository=new MemoryRepository();
    const created=await repository.createHomework(teacher,{groupId:group,courseId:DEV_IDS.course,title:'Чернетка',instructions:'Завдання',dueAt:'2026-10-20T18:00:00.000Z',xpReward:50,status:'draft',resources:[{kind:'link',title:'Матеріал',url:'https://example.com/material'}]});
    const draft=(await repository.getTeacherWorkspace(teacher)).homework.find(item=>item.id===created.id);
    expect(draft?.status).toBe('draft');
    expect(draft?.resources).toEqual([expect.objectContaining({kind:'link',title:'Матеріал',url:'https://example.com/material'})]);
    await repository.publishHomework(teacher,created.id,'2026-10-19T18:00:00.000Z');
    expect((await repository.getTeacherWorkspace(teacher)).homework.find(item=>item.id===created.id)?.status).toBe('published');
    const startsAt='2026-11-10T16:00:00.000Z',endsAt='2026-11-10T16:30:00.000Z';
    await repository.createMentorAvailability(teacher,{startsAt,endsAt,timezone:'Europe/Kyiv',status:'open'});
    await expect(repository.createMentorAvailability(teacher,{startsAt:'2026-11-10T16:15:00.000Z',endsAt:'2026-11-10T16:45:00.000Z',timezone:'Europe/Kyiv',status:'open'})).rejects.toMatchObject({statusCode:409});
  });

  it('separates grading from XP and preserves private-note isolation',async()=>{
    const repository=new MemoryRepository();
    const before=(await repository.getHome(DEV_IDS.user)).viewer.xp;
    await repository.reviewHomework(teacher,'74000000-0000-4000-8000-000000000002',{score:3,effort:'needs_attention',status:'needs_revision',feedback:'Додай перевірку.'});
    expect((await repository.getHome(DEV_IDS.user)).viewer.xp).toBe(before);
    const secret='Приватне спостереження для викладача';
    await repository.createTeacherNote(teacher,DEV_IDS.user,{category:'learning',content:secret});
    expect(JSON.stringify(await repository.getTeacherWorkspace(teacher))).toContain(secret);
    expect(JSON.stringify(await repository.getProfile(DEV_IDS.user))).not.toContain(secret);
    expect(JSON.stringify(await repository.listParentReports(guardian,DEV_IDS.user))).not.toContain(secret);
    await expect(repository.getTeacherWorkspace(DEV_IDS.user)).rejects.toMatchObject({statusCode:403});
    await expect(repository.getTeacherWorkspace(guardian)).rejects.toMatchObject({statusCode:403});
  });

  it('requires a reviewed human comment before report approval',async()=>{
    const repository=new MemoryRepository();
    const report=(await repository.getTeacherWorkspace(teacher)).reports[0]!;
    await repository.saveTeacherReport(teacher,report.id,{teacherComment:'',status:'draft'});
    await expect(repository.approveTeacherReport(teacher,report.id)).rejects.toMatchObject({statusCode:409});
    await repository.saveTeacherReport(teacher,report.id,{teacherComment:'Сильний прогрес у роботі з джерелами.',status:'ready_for_review'});
    await repository.approveTeacherReport(teacher,report.id);
    expect((await repository.getTeacherWorkspace(teacher)).reports[0]?.status).toBe('approved');
    await expect(repository.approveTeacherReport(teacher,'93000000-ffff-4000-8000-000000000099')).rejects.toMatchObject({statusCode:403});
  });
});
