import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';
import { groupInputSchema } from '../data/group-model.js';

export function registerGroupRoutes(app:FastifyInstance, repository:AppRepository, prefix:string, preHandler:preHandlerHookHandler[]):void {
  const secured={preHandler,config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  const params=z.object({groupId:z.string().uuid()});
  app.get(`${prefix}/groups/directory`,secured,request=>repository.groupDirectory(request.auth.userId));
  app.get(`${prefix}/groups/:groupId`,secured,request=>repository.getGroupDetail(request.auth.userId,params.parse(request.params).groupId));
  app.post(`${prefix}/groups`,secured,async(request,reply)=>reply.code(201).send(await repository.createGroup(request.auth.userId,groupInputSchema.parse(request.body),request.id)));
  app.patch(`${prefix}/groups/:groupId`,secured,async(request,reply)=>{
    const input=groupInputSchema.extend({expectedVersion:z.number().int().positive()}).parse(request.body);
    await repository.updateGroup(request.auth.userId,params.parse(request.params).groupId,input,request.id);return reply.code(204).send();
  });
  app.post(`${prefix}/groups/:groupId/archive`,secured,async(request,reply)=>{
    const {expectedVersion}=z.object({expectedVersion:z.number().int().positive()}).strict().parse(request.body);
    await repository.archiveGroup(request.auth.userId,params.parse(request.params).groupId,expectedVersion,request.id);return reply.code(204).send();
  });
  app.put(`${prefix}/groups/:groupId/students/:studentId`,secured,async(request,reply)=>{
    const {groupId,studentId}=params.extend({studentId:z.string().uuid()}).parse(request.params);
    const {add,expectedVersion}=z.object({add:z.boolean(),expectedVersion:z.number().int().positive()}).strict().parse(request.body);
    await repository.setGroupStudent(request.auth.userId,groupId,studentId,add,expectedVersion,request.id);return reply.code(204).send();
  });
}
