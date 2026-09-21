import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppEnv } from '../config/env.js';
import type { NotificationWorker } from '../services/telegram-notification-service.js';

function authorized(value:string|string[]|undefined,secret:string):boolean{
  if(typeof value!=='string')return false;
  const actual=Buffer.from(value),expected=Buffer.from(`Bearer ${secret}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export function registerNotificationWorkerRoute(app:FastifyInstance,env:AppEnv,worker:NotificationWorker|undefined):void{
  app.get('/api/v1/notifications/worker',async(request,reply)=>{
    if(!env.CRON_SECRET||!worker)return reply.status(503).send({error:{code:'NOTIFICATION_WORKER_NOT_CONFIGURED',message:'Notification worker is not configured'}});
    if(!authorized(request.headers.authorization,env.CRON_SECRET))return reply.status(401).send({error:{code:'CRON_UNAUTHORIZED',message:'Unauthorized'}});
    return worker.run(new Date());
  });
}
