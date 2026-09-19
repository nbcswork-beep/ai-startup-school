import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../config/env.js';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';

const uuid=z.string().uuid();
const reason=z.string().trim().min(3).max(1000);
const entity=z.enum(['users','students','teachers','guardians','groups','courses','modules','lessons','sessions','attendance','homework','submissions','reviews','projects','portfolios','mentor_bookings','reports']);
const readLimit={config:{rateLimit:{max:90,timeWindow:'1 minute'}}};
const mutationLimit={config:{rateLimit:{max:20,timeWindow:'1 minute'}}};

export function registerAdminRoutes(app:FastifyInstance,repository:AppRepository,authenticate:preHandlerHookHandler,env:AppEnv):void{
  const authorize=async(request:FastifyRequest)=>{if(request.access.role!=='admin'){await repository.recordSecurityEvent({eventType:'unauthorized_admin_endpoint_attempt',severity:'high',actorUserId:request.auth.userId,metadata:{method:request.method,path:request.routeOptions.url},correlationId:request.id});throw new AppError('ADMIN_REQUIRED',403,'Потрібні права адміністратора');}};
  const secured=(limits:typeof readLimit)=>({preHandler:[authenticate,authorize],...limits});

  app.get('/api/v1/admin/bootstrap',secured(readLimit),async request=>{
    const result=await repository.getAdminWorkspace(request.auth.userId);
    result.health={...result.health,
      productionMode:{status:env.NODE_ENV==='production'?'ok':'warning',label:env.NODE_ENV==='production'?'Production mode':'Development mode'},
      telegram:{status:env.TELEGRAM_BOT_TOKEN?'ok':'required',label:env.TELEGRAM_BOT_TOKEN?'Telegram configured':'Telegram configuration required'},
      storage:{status:env.STORAGE_PRIVATE_BUCKETS_CONFIGURED?'ok':'required',label:env.STORAGE_PRIVATE_BUCKETS_CONFIGURED?'Private storage configured':'Private storage verification required'},
      signingKeys:{status:env.APP_JWT_PRIVATE_KEY_BASE64&&env.APP_JWT_PUBLIC_KEY_BASE64?'ok':'warning',label:env.DEV_EPHEMERAL_JWT?'Ephemeral development keys':'Persistent signing keys configured'},
      devAuth:{status:env.NODE_ENV==='production'&&!env.DEV_AUTH_ENABLED?'ok':'warning',label:env.DEV_AUTH_ENABLED?'Development auth enabled':'Development auth disabled'},
      origins:{status:env.origins.length&&!env.origins.includes('*')?'ok':'required',label:`${env.origins.length} allowed origin(s)`},
      securityHeaders:{status:'ok',label:'CSP and security headers enabled'},
      adminMfa:{status:env.ADMIN_MFA_CONFIGURED?'ok':'required',label:env.ADMIN_MFA_CONFIGURED?'Admin MFA configured':'Admin MFA required before production'},
      monitoring:{status:env.SECURITY_MONITORING_CONFIGURED?'ok':'required',label:env.SECURITY_MONITORING_CONFIGURED?'Security monitoring configured':'Security monitoring required'}
    };
    return result;
  });
  app.get('/api/v1/admin/search',secured({...readLimit,config:{rateLimit:{max:30,timeWindow:'1 minute'}}}),async request=>{const {q}=z.object({q:z.string().trim().min(2).max(80)}).parse(request.query);return repository.searchAdmin(request.auth.userId,q);});
  app.get('/api/v1/admin/explorer/:entity',secured(readLimit),async request=>{const {entity:selected}=z.object({entity}).parse(request.params);const input=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),sort:z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(40).default('id'),direction:z.enum(['asc','desc']).default('asc'),q:z.string().trim().max(80).optional()}).parse(request.query);return repository.exploreAdmin(request.auth.userId,{entity:selected,page:input.page,pageSize:input.pageSize,sort:input.sort,direction:input.direction,...(input.q?{query:input.q}:{})});});

  app.patch('/api/v1/admin/users/:userId/status',secured(mutationLimit),async(request,reply)=>{const {userId}=z.object({userId:uuid}).parse(request.params);const input=z.object({status:z.enum(['active','disabled','archived']),reason}).strict().parse(request.body);await repository.adminSetAccountStatus(request.auth.userId,userId,input.status,input.reason,request.id);return reply.status(204).send();});
  app.patch('/api/v1/admin/attendance/:attendanceId',secured(mutationLimit),async(request,reply)=>{const {attendanceId}=z.object({attendanceId:uuid}).parse(request.params);const input=z.object({status:z.enum(['present','late','absent','excused']),reason}).strict().parse(request.body);await repository.adminCorrectAttendance(request.auth.userId,attendanceId,input.status,input.reason,request.id);return reply.status(204).send();});
  app.patch('/api/v1/admin/portfolios/:portfolioId/visibility',secured(mutationLimit),async(request,reply)=>{const {portfolioId}=z.object({portfolioId:uuid}).parse(request.params);const input=z.object({visibility:z.enum(['private','shareable','public']),reason}).strict().parse(request.body);await repository.adminSetPortfolioVisibility(request.auth.userId,portfolioId,input.visibility,input.reason,request.id);return reply.status(204).send();});
  app.post('/api/v1/admin/guardian-links/:linkId/revoke',secured(mutationLimit),async(request,reply)=>{const {linkId}=z.object({linkId:uuid}).parse(request.params);const input=z.object({reason}).strict().parse(request.body);await repository.adminRevokeGuardianLink(request.auth.userId,linkId,input.reason,request.id);return reply.status(204).send();});
  app.post('/api/v1/admin/reports/:reportId/resend',secured({...mutationLimit,config:{rateLimit:{max:5,timeWindow:'10 minutes'}}}),async(request,reply)=>{const {reportId}=z.object({reportId:uuid}).parse(request.params);z.object({confirm:z.literal(true)}).strict().parse(request.body);await repository.adminResendReport(request.auth.userId,reportId,request.id);return reply.status(202).send();});
  app.post('/api/v1/admin/sessions/:sessionId/revoke',secured(mutationLimit),async(request,reply)=>{const {sessionId}=z.object({sessionId:uuid}).parse(request.params);const input=z.object({reason}).strict().parse(request.body);await repository.adminRevokeUserSession(request.auth.userId,sessionId,input.reason,request.id);return reply.status(204).send();});
}
