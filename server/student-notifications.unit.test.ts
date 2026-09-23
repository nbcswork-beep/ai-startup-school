import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { createPilotRuntimeState, MemoryPilotRuntimeStore, type PilotNotification } from './data/pilot-runtime-store.js';
import { DEV_IDS, PILOT_STUDENTS } from './data/seed.js';
import { MockAiProvider } from './services/ai-provider.js';

const notification = (overrides:Partial<PilotNotification>):PilotNotification=>({
  id:'90000000-0000-4000-8000-000000000001',
  recipientUserId:DEV_IDS.user,
  recipientTelegramId:'123456789',
  type:'student_homework_assigned',
  relatedEntityId:'91000000-0000-4000-8000-000000000001',
  scheduledFor:'2026-09-22T12:00:00.000Z',
  sentAt:'2026-09-22T12:00:01.000Z',
  status:'sent',attempts:1,lastAttemptAt:'2026-09-22T12:00:00.000Z',nextAttemptAt:null,
  idempotencyKey:'homework:test',safeMetadata:{text:'📝 Нове домашнє завдання\n\nПеревір гіпотезу'},errorCode:null,
  dueAt:'2026-09-22T12:00:00.000Z',expiresAt:'2026-09-29T12:00:00.000Z',entityStamp:'homework:test',readAt:null,
  ...overrides
});

describe('student notifications',()=>{
  let app:FastifyInstance|undefined;
  afterEach(async()=>app?.close());

  it('returns only the current student notifications and persists read state without touching Telegram delivery',async()=>{
    const state=createPilotRuntimeState();
    const firstHomework=state.homework[0]!;
    const own=notification({relatedEntityId:firstHomework.id});
    const other=notification({id:'90000000-0000-4000-8000-000000000002',recipientUserId:PILOT_STUDENTS[1]!.id,idempotencyKey:'homework:other'});
    const guardian=notification({id:'90000000-0000-4000-8000-000000000003',type:'guardian_weekly_digest',recipientUserId:'13000000-0000-4000-8000-000000000001',idempotencyKey:'guardian:test'});
    state.notifications.push(own,other,guardian);
    const runtimeStore=new MemoryPilotRuntimeStore(state);
    const repository=new MemoryRepository(undefined,{runtimeStore});

    const initial=await repository.listStudentNotifications(DEV_IDS.user);
    expect(initial.unreadCount).toBe(1);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]?.destination).toEqual({tab:'learn',homeworkId:firstHomework.id});

    const afterRead=await repository.markStudentNotificationsRead(DEV_IDS.user,[own.id,other.id]);
    expect(afterRead.unreadCount).toBe(0);
    const persisted=await new MemoryRepository(undefined,{runtimeStore}).listStudentNotifications(DEV_IDS.user);
    expect(persisted.items[0]?.readAt).not.toBeNull();

    const stored=await runtimeStore.read();
    expect(stored.notifications.find(item=>item.id===own.id)).toMatchObject({status:'sent',sentAt:own.sentAt,idempotencyKey:own.idempotencyKey});
    expect(stored.notifications.find(item=>item.id===other.id)?.readAt).toBeNull();
  });

  it('returns the empty state model and only valid Student App destinations',async()=>{
    const state=createPilotRuntimeState();
    state.notifications.push(
      notification({type:'student_class_1h',relatedEntityId:state.classSessions[0]!.id}),
      notification({id:'90000000-0000-4000-8000-000000000004',type:'student_project_updated',relatedEntityId:null,idempotencyKey:'project:test'})
    );
    const repository=new MemoryRepository(undefined,{runtimeStore:new MemoryPilotRuntimeStore(state)});
    const result=await repository.listStudentNotifications(DEV_IDS.user);
    expect(result.items.map(item=>item.destination?.tab)).toEqual(['learn','project']);
    expect(result.items.every(item=>!item.destination||['learn','project'].includes(item.destination.tab))).toBe(true);
    expect((await repository.listStudentNotifications(PILOT_STUDENTS[2]!.id))).toEqual({items:[],unreadCount:0});
  });

  it.each(['disabled','archived'] as const)('rejects a %s student at the authenticated API boundary',async status=>{
    const runtimeStore=new MemoryPilotRuntimeStore();
    const repository=new MemoryRepository(undefined,{runtimeStore});
    const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_AUTH_ENABLED:'true',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'test-pepper'});
    app=await buildApp({env,repository,jwt:await createJwtService(env),aiProvider:new MockAiProvider()});
    const login=await app.inject({method:'POST',url:'/api/v1/auth/development'});
    const {accessToken}=login.json();
    await runtimeStore.mutate(state=>{state.directory[DEV_IDS.user]!.status=status;state.userStatus[DEV_IDS.user]=status;});
    const response=await app.inject({method:'GET',url:'/api/v1/notifications',headers:{authorization:`Bearer ${accessToken}`}});
    expect(response.statusCode).toBe(401);
  });
});
