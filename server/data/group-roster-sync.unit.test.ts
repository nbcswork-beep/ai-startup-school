import {describe,expect,it} from 'vitest';
import {MemoryRepository} from './memory-repository.js';
import {MemoryPilotRuntimeStore,createPilotRuntimeState} from './pilot-runtime-store.js';
import {DEV_IDS,PILOT,PILOT_STUDENTS,PILOT_TEACHERS} from './seed.js';
const admin='14000000-0000-4000-8000-000000000001',teacher=PILOT_TEACHERS[1]!.id;
async function setup(){
 const runtime=new MemoryPilotRuntimeStore(createPilotRuntimeState()),first=new MemoryRepository(undefined,{runtimeStore:runtime}),second=new MemoryRepository(undefined,{runtimeStore:runtime});
 for(let i=0;i<2;i++)await first.adminCreateStudent(admin,{firstName:'Real '+i,lastName:'Student',groupId:PILOT.groupId,status:'active'},'create');
 const session=await first.createClassSession(teacher,{groupId:PILOT.groupId,courseId:DEV_IDS.course,title:'Real session',startsAt:'2027-03-01T15:00:00.000Z',endsAt:'2027-03-01T16:30:00.000Z'});
 return{runtime,first,second,sessionId:session.id};
}
describe('one current group roster across teacher/admin/student data',()=>{
 it('returns all six members even when only one attendance record exists',async()=>{
  const {first,second,sessionId}=await setup();await first.confirmAttendance(teacher,sessionId,DEV_IDS.user,'present','Persisted note');
  const t=await second.getTeacherWorkspace(teacher),a=await second.getAdminWorkspace(admin),g=await second.getGroupDetail(teacher,PILOT.groupId);
  expect(t.groups[0]?.studentCount).toBe(6);expect(a.groups[0]?.studentCount).toBe(6);expect(g.students).toHaveLength(6);
  expect(t.sessions.find(s=>s.id===sessionId)?.attendance).toHaveLength(6);
  expect(t.sessions.find(s=>s.id===sessionId)?.attendance.filter(s=>s.status===null)).toHaveLength(5);
 });
 it('does not confuse login status with membership or activate disabled accounts',async()=>{
  const {runtime,first,second,sessionId}=await setup();
  await runtime.mutate(s=>{for(const [i,p] of Object.values(s.directory).filter(p=>p.roles.includes('student')).entries()){if(i>0){p.status=i===1?'pending':'disabled';s.userStatus[p.id]=p.status;}}});
  expect((await second.getTeacherWorkspace(teacher)).groups[0]?.studentCount).toBe(6);
  expect((await second.getTeacherWorkspace(teacher)).sessions[0]?.attendance).toHaveLength(6);
  await first.confirmAttendance(teacher,sessionId,PILOT_STUDENTS[1]!.id,'late');
  expect((await second.getAuthUser(PILOT_STUDENTS[1]!.id))?.status).toBe('pending');
  expect((await second.getAuthUser(PILOT_STUDENTS[2]!.id))?.status).toBe('disabled');
 });
 it('updates membership/revision and retains former members as read-only attendance history',async()=>{
  const {runtime,first,second,sessionId}=await setup();await first.confirmAttendance(teacher,sessionId,DEV_IDS.user,'present','Retain history');
  const before=await second.academicRevision(teacher),version=(await runtime.read()).directory[DEV_IDS.user]!.version;
  await first.setGroupStudent(admin,PILOT.groupId,DEV_IDS.user,false,version,'remove');
  const t=await second.getTeacherWorkspace(teacher);expect(t.groups[0]?.studentCount).toBe(5);
  expect(t.sessions[0]?.attendance.find(a=>a.studentId===DEV_IDS.user)).toMatchObject({isCurrentMember:false,status:'present',note:'Retain history'});
  expect(t.sessions[0]?.attendance.filter(a=>a.isCurrentMember)).toHaveLength(5);expect(await second.academicRevision(teacher)).not.toEqual(before);
  expect((await second.getHome(DEV_IDS.user)).viewer.group).toBeNull();expect(await second.listHomework(DEV_IDS.user)).toEqual([]);
  await expect(second.confirmAttendance(teacher,sessionId,DEV_IDS.user,'absent')).rejects.toMatchObject({statusCode:403});
 });
 it('uses current group names and shared homework visibility after rename/restart',async()=>{
  const {runtime,first,second}=await setup();const state=await runtime.read(),group=state.groups[0]!;
  const hw=await first.createHomework(teacher,{groupId:group.id,courseId:group.courseId,title:'Real HW',instructions:'Initial task',status:'draft',xpReward:0});
  await first.publishHomework(teacher,hw.id,new Date().toISOString());
  await first.updateGroup(admin,group.id,{name:'Renamed real group',academicYear:group.academicYear,startsOn:group.startsOn,lessonCount:group.lessonCount,weekdays:group.weekdays,time:group.time,teacherId:group.teacherId,status:group.status,expectedVersion:group.version},'rename');
  const restarted=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(await runtime.read())});
  expect((await restarted.getTeacherWorkspace(teacher)).homework.find(h=>h.id===hw.id)?.groupName).toBe('Renamed real group');
  expect((await restarted.getHome(DEV_IDS.user)).viewer.group?.name).toBe('Renamed real group');
  expect((await second.getLearning(DEV_IDS.user)).modules[0]?.title).toBe('Renamed real group');
  await first.updateHomework(teacher,hw.id,{expectedVersion:2,instructions:'Updated task'},'edit');expect((await second.listHomework(DEV_IDS.user))[0]?.instructions).toBe('Updated task');
  await first.updateHomework(teacher,hw.id,{expectedVersion:3,status:'unpublished'},'unpublish');expect(await second.listHomework(DEV_IDS.user)).toEqual([]);
 });
 it('rejects inactive sessions and duplicate attendance without partial writes',async()=>{
  const {runtime,first,sessionId}=await setup();
  await expect(first.bulkConfirmAttendance(teacher,sessionId,[{studentId:DEV_IDS.user,status:'present'},{studentId:DEV_IDS.user,status:'absent'}])).rejects.toMatchObject({code:'ATTENDANCE_DUPLICATE'});
  await first.updateTeacherClass(teacher,sessionId,{status:'cancelled'});
  await expect(first.confirmAttendance(teacher,sessionId,DEV_IDS.user,'present')).rejects.toMatchObject({statusCode:409});expect((await runtime.read()).attendance).toEqual([]);
 });
});
