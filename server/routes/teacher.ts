import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';

const uuid = z.string().uuid();
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:', 'Only HTTPS URLs are allowed');
const timeRange = z.object({ startsAt:z.string().datetime(),endsAt:z.string().datetime() }).refine(value=>Date.parse(value.endsAt)>Date.parse(value.startsAt),'End must be after start');

export function registerTeacherRoutes(app:FastifyInstance,repository:AppRepository,authenticate:preHandlerHookHandler):void{
  const secured={preHandler:authenticate};
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
  app.put('/api/v1/teacher/sessions/:sessionId/attendance/:studentId',secured,async(request,reply)=>{
    const {sessionId,studentId}=z.object({sessionId:uuid,studentId:uuid}).parse(request.params); const parsed=z.object({status:z.enum(['present','late','absent','excused']),note:z.string().trim().max(2000).optional()}).parse(request.body);
    await repository.confirmAttendance(request.auth.userId,sessionId,studentId,parsed.status,parsed.note); return reply.status(204).send();
  });
  app.post('/api/v1/teacher/homework',secured,async(request,reply)=>{
    const parsed=z.object({groupId:uuid,courseId:uuid,moduleId:uuid.optional(),lessonId:uuid.optional(),classSessionId:uuid.optional(),title:z.string().trim().min(1).max(180),instructions:z.string().trim().min(1).max(20000),publishAt:z.string().datetime().optional(),dueAt:z.string().datetime().optional(),xpReward:z.number().int().min(0).max(10000),status:z.enum(['draft','published'])}).refine(value=>value.status==='draft'||Boolean(value.publishAt),'Published homework requires publishAt').refine(value=>!value.publishAt||!value.dueAt||Date.parse(value.dueAt)>Date.parse(value.publishAt),'Due time must follow publish time').parse(request.body);
    const input:Parameters<AppRepository['createHomework']>[1]={groupId:parsed.groupId,courseId:parsed.courseId,title:parsed.title,instructions:parsed.instructions,xpReward:parsed.xpReward,status:parsed.status};
    for(const key of ['moduleId','lessonId','classSessionId','publishAt','dueAt'] as const)if(parsed[key]!==undefined)input[key]=parsed[key];
    return reply.status(201).send(await repository.createHomework(request.auth.userId,input));
  });
  app.put('/api/v1/teacher/submissions/:submissionId/review',secured,async(request,reply)=>{
    const {submissionId}=z.object({submissionId:uuid}).parse(request.params); const parsed=z.object({score:z.number().int().min(0).max(10),effort:z.enum(['needs_attention','good_effort','high_effort']),status:z.enum(['reviewed','needs_revision','completed']),feedback:z.string().trim().max(10000)}).parse(request.body);
    await repository.reviewHomework(request.auth.userId,submissionId,parsed); return reply.status(204).send();
  });
}
