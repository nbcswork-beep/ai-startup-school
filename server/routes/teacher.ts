import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';
import { requireRole } from '../middleware/authenticate.js';

const uuid = z.string().uuid();
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:', 'Only HTTPS URLs are allowed');
const timeRange = z.object({ startsAt:z.string().datetime(),endsAt:z.string().datetime() }).refine(value=>Date.parse(value.endsAt)>Date.parse(value.startsAt),'End must be after start');

export function registerTeacherRoutes(app:FastifyInstance,repository:AppRepository,authenticate:preHandlerHookHandler):void{
  const secured={preHandler:[authenticate,requireRole('teacher')]};
  app.get('/api/v1/teacher/bootstrap',secured,async request=>repository.getTeacherWorkspace(request.auth.userId));
  app.get('/api/v1/teacher/search',secured,async request=>{
    const {q}=z.object({q:z.string().trim().min(2).max(80)}).parse(request.query);
    return repository.searchTeacherScope(request.auth.userId,q);
  });
  app.get('/api/v1/teacher/groups',secured,async request=>repository.listTeacherGroups(request.auth.userId));
  app.get('/api/v1/teacher/groups/:groupId/students',secured,async request=>{
    const {groupId}=z.object({groupId:uuid}).parse(request.params); return repository.listGroupStudents(request.auth.userId,groupId);
  });
  app.post('/api/v1/teacher/sessions',secured,async(request,reply)=>{
    const parsed=z.object({groupId:uuid,courseId:uuid,moduleId:uuid.optional(),lessonId:uuid.optional(),title:z.string().trim().min(1).max(160),description:z.string().trim().max(4000).optional(),startsAt:z.string().datetime(),endsAt:z.string().datetime(),meetingUrl:httpsUrl.optional(),meetingProvider:z.string().trim().max(60).optional()}).refine(value=>Date.parse(value.endsAt)>Date.parse(value.startsAt),'End must be after start').parse(request.body);
    const input:Parameters<AppRepository['createClassSession']>[1]={groupId:parsed.groupId,courseId:parsed.courseId,title:parsed.title,startsAt:parsed.startsAt,endsAt:parsed.endsAt};
    for(const key of ['moduleId','lessonId','description','meetingUrl','meetingProvider'] as const)if(parsed[key]!==undefined)input[key]=parsed[key];
    return reply.status(201).send(await repository.createClassSession(request.auth.userId,input));
  });
  app.post('/api/v1/teacher/sessions/:sessionId/reschedule',secured,async(request,reply)=>{
    const {sessionId}=z.object({sessionId:uuid}).parse(request.params); const parsed=timeRange.extend({reason:z.string().trim().max(2000).optional()}).parse(request.body);
    const input:Parameters<AppRepository['rescheduleClass']>[2]={startsAt:parsed.startsAt,endsAt:parsed.endsAt};if(parsed.reason!==undefined)input.reason=parsed.reason;
    await repository.rescheduleClass(request.auth.userId,sessionId,input); return reply.status(204).send();
  });
  app.patch('/api/v1/teacher/sessions/:sessionId',secured,async(request,reply)=>{
    const {sessionId}=z.object({sessionId:uuid}).parse(request.params);
    const parsed=z.object({title:z.string().trim().min(1).max(160).optional(),description:z.string().trim().max(4000).optional(),lessonId:uuid.nullable().optional(),meetingUrl:httpsUrl.nullable().optional(),meetingProvider:z.string().trim().max(60).nullable().optional(),teacherNotes:z.string().trim().max(10000).optional(),status:z.enum(['scheduled','in_progress','completed','cancelled']).optional()}).refine(value=>Object.keys(value).length>0,'At least one field is required').parse(request.body);
    const input:Parameters<AppRepository['updateTeacherClass']>[2]={};
    for(const key of ['title','description','lessonId','meetingUrl','meetingProvider','teacherNotes','status'] as const)if(parsed[key]!==undefined)(input as Record<string,unknown>)[key]=parsed[key];
    await repository.updateTeacherClass(request.auth.userId,sessionId,input); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/sessions/:sessionId/materials',secured,async(request,reply)=>{
    const {sessionId}=z.object({sessionId:uuid}).parse(request.params);
    const parsed=z.object({kind:z.enum(['presentation','document','link','reference','other']),title:z.string().trim().min(1).max(180),url:httpsUrl}).parse(request.body);
    await repository.addClassMaterial(request.auth.userId,sessionId,parsed); return reply.status(201).send();
  });
  app.put('/api/v1/teacher/sessions/:sessionId/attendance',secured,async(request,reply)=>{
    const {sessionId}=z.object({sessionId:uuid}).parse(request.params);
    const {entries}=z.object({entries:z.array(z.object({studentId:uuid,status:z.enum(['present','late','absent','excused']),note:z.string().trim().max(2000).optional()})).min(1).max(100)}).parse(request.body);
    await repository.bulkConfirmAttendance(request.auth.userId,sessionId,entries.map(entry=>entry.note===undefined?{studentId:entry.studentId,status:entry.status}:{studentId:entry.studentId,status:entry.status,note:entry.note})); return reply.status(204).send();
  });
  app.put('/api/v1/teacher/sessions/:sessionId/attendance/:studentId',secured,async(request,reply)=>{
    const {sessionId,studentId}=z.object({sessionId:uuid,studentId:uuid}).parse(request.params); const parsed=z.object({status:z.enum(['present','late','absent','excused']),note:z.string().trim().max(2000).optional()}).parse(request.body);
    await repository.confirmAttendance(request.auth.userId,sessionId,studentId,parsed.status,parsed.note); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/homework',secured,async(request,reply)=>{
    const parsed=z.object({groupId:uuid,courseId:uuid,moduleId:uuid.optional(),lessonId:uuid.optional(),classSessionId:uuid.optional(),title:z.string().trim().min(1).max(180),instructions:z.string().trim().min(1).max(20000),publishAt:z.string().datetime().optional(),dueAt:z.string().datetime().optional(),xpReward:z.number().int().min(0).max(10000),status:z.enum(['draft','published']),resources:z.array(z.object({kind:z.enum(['presentation','document','link','reference','other']),title:z.string().trim().min(1).max(180),url:httpsUrl})).max(10).optional()}).refine(value=>value.status==='draft'||Boolean(value.publishAt),'Published homework requires publishAt').refine(value=>!value.publishAt||!value.dueAt||Date.parse(value.dueAt)>Date.parse(value.publishAt),'Due time must follow publish time').parse(request.body);
    const input:Parameters<AppRepository['createHomework']>[1]={groupId:parsed.groupId,courseId:parsed.courseId,title:parsed.title,instructions:parsed.instructions,xpReward:parsed.xpReward,status:parsed.status};
    for(const key of ['moduleId','lessonId','classSessionId','publishAt','dueAt','resources'] as const)if(parsed[key]!==undefined)(input as Record<string,unknown>)[key]=parsed[key];
    return reply.status(201).send(await repository.createHomework(request.auth.userId,input));
  });
  app.put('/api/v1/teacher/submissions/:submissionId/review',secured,async(request,reply)=>{
    const {submissionId}=z.object({submissionId:uuid}).parse(request.params); const parsed=z.object({score:z.number().int().min(0).max(10),effort:z.enum(['needs_attention','good_effort','high_effort']),status:z.enum(['reviewed','needs_revision','completed']),feedback:z.string().trim().max(10000)}).parse(request.body);
    await repository.reviewHomework(request.auth.userId,submissionId,parsed); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/homework/:homeworkId/publish',secured,async(request,reply)=>{
    const {homeworkId}=z.object({homeworkId:uuid}).parse(request.params);
    const {publishAt}=z.object({publishAt:z.string().datetime()}).parse(request.body);
    await repository.publishHomework(request.auth.userId,homeworkId,publishAt); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/students/:studentId/notes',secured,async(request,reply)=>{
    const {studentId}=z.object({studentId:uuid}).parse(request.params);
    const parsed=z.object({category:z.enum(['general','learning','project','mentoring']),content:z.string().trim().min(1).max(10000)}).parse(request.body);
    return reply.status(201).send(await repository.createTeacherNote(request.auth.userId,studentId,parsed));
  });
  app.patch('/api/v1/teacher/portfolio/items/:itemId',secured,async(request,reply)=>{
    const {itemId}=z.object({itemId:uuid}).parse(request.params);
    const parsed=z.object({title:z.string().trim().min(1).max(180).nullable().optional(),shortDescription:z.string().trim().max(500).optional(),reflection:z.string().trim().max(5000).optional(),learned:z.string().trim().max(5000).optional()}).refine(value=>Object.keys(value).length>0,'At least one field is required').parse(request.body);
    const input:Parameters<AppRepository['updatePortfolioItemAsTeacher']>[2]={};
    for(const key of ['title','shortDescription','reflection','learned'] as const)if(parsed[key]!==undefined)(input as Record<string,unknown>)[key]=parsed[key];
    await repository.updatePortfolioItemAsTeacher(request.auth.userId,itemId,input); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/mentor/availability',secured,async(request,reply)=>{
    const parsed=timeRange.extend({timezone:z.string().trim().min(1).max(80),status:z.enum(['open','blocked'])}).parse(request.body);
    await repository.createMentorAvailability(request.auth.userId,parsed); return reply.status(201).send();
  });
  app.patch('/api/v1/teacher/mentor/bookings/:bookingId',secured,async(request,reply)=>{
    const {bookingId}=z.object({bookingId:uuid}).parse(request.params);
    const parsed=z.object({status:z.enum(['confirmed','completed','cancelled','rescheduled','no_show']),meetingUrl:httpsUrl.nullable().optional(),startsAt:z.string().datetime().optional(),endsAt:z.string().datetime().optional()}).refine(value=>!value.startsAt===!value.endsAt,'Both start and end are required').refine(value=>!value.startsAt||Date.parse(value.endsAt!)>Date.parse(value.startsAt),'End must be after start').parse(request.body);
    const input:Parameters<AppRepository['updateMentorBooking']>[2]={status:parsed.status};
    for(const key of ['meetingUrl','startsAt','endsAt'] as const)if(parsed[key]!==undefined)(input as Record<string,unknown>)[key]=parsed[key];
    await repository.updateMentorBooking(request.auth.userId,bookingId,input); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/reports/generate',secured,async(request,reply)=>{
    const parsed=z.object({groupId:uuid,periodStart:z.string().date(),periodEnd:z.string().date()}).refine(value=>value.periodEnd>=value.periodStart,'Period end must follow start').parse(request.body);
    await repository.generateTeacherReports(request.auth.userId,parsed.groupId,parsed.periodStart,parsed.periodEnd); return reply.status(201).send();
  });
  app.put('/api/v1/teacher/reports/:reportId',secured,async(request,reply)=>{
    const {reportId}=z.object({reportId:uuid}).parse(request.params);
    const parsed=z.object({teacherComment:z.string().trim().max(10000),status:z.enum(['draft','ready_for_review'])}).parse(request.body);
    await repository.saveTeacherReport(request.auth.userId,reportId,parsed); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/reports/:reportId/approve',secured,async(request,reply)=>{
    const {reportId}=z.object({reportId:uuid}).parse(request.params);
    await repository.approveTeacherReport(request.auth.userId,reportId); return reply.status(204).send();
  });
}
