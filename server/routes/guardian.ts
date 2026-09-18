import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';

export function registerGuardianRoutes(app:FastifyInstance,repository:AppRepository,authenticate:preHandlerHookHandler):void{
  const secured={preHandler:authenticate};
  app.get('/api/v1/guardian/students',secured,async request=>repository.listLinkedStudents(request.auth.userId));
  app.get('/api/v1/guardian/students/:studentId/reports',secured,async request=>{
    const {studentId}=z.object({studentId:z.string().uuid()}).parse(request.params); return repository.listParentReports(request.auth.userId,studentId);
  });
}
