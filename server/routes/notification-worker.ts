import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppEnv } from '../config/env.js';
import type { NotificationWorker } from '../services/telegram-notification-service.js';

function authorized(value:string|string[]|undefined,secret:string):boolean{
  if(typeof value!=='string')return false;
  const actual=Buffer.from(value),expected=Buffer.from(`Bearer ${secret}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

/** aiSweep finishes AI answers whose function died and retries their notices; it rides on the same schedule. */
export function registerNotificationWorkerRoute(app:FastifyInstance,env:AppEnv,worker:NotificationWorker|undefined,aiSweep?:()=>Promise<unknown>):void{
  app.get('/api/v1/notifications/worker',async(request,reply)=>{
    if(!env.CRON_SECRET||!worker)return reply.status(503).send({error:{code:'NOTIFICATION_WORKER_NOT_CONFIGURED',message:'Notification worker is not configured'}});
    if(!authorized(request.headers.authorization,env.CRON_SECRET))return reply.status(401).send({error:{code:'CRON_UNAUTHORIZED',message:'Unauthorized'}});
    const result=await worker.run(new Date());
    if(!aiSweep)return result;
    try{return{...result,ai:await aiSweep()};}
    catch(error){request.log.error({err:error},'AI job sweep failed');return{...result,ai:null};}
  });
}
