import {afterEach,describe,expect,it,vi} from 'vitest';
import {MemorySessionStore,RedisRestSessionStore} from './session-store.js';
import type {NewSession} from '../types/domain.js';
const now=new Date('2026-10-05T12:00:00.000Z');
const session:NewSession={id:'aaaaaaaa-0000-4000-8000-000000000001',familyId:'aaaaaaaa-0000-4000-8000-000000000002',userId:'10000000-0000-4000-8000-000000000001',provider:'web',refreshTokenHash:'synthetic-hash',createdAt:now,expiresAt:new Date('2026-11-05T12:00:00.000Z')};
afterEach(()=>vi.unstubAllGlobals());
describe('manual session extension',()=>{
 it('refuses expired, revoked and replaced sessions and preserves the extended refresh family',async()=>{
  const store=new MemorySessionStore();await store.create(session);
  const extended=await store.extendById(session.id,session.expiresAt.toISOString(),now);
  expect(extended.expiresAt.getTime()-session.expiresAt.getTime()).toBe(180*86400000);
  const rotated=await store.rotate(session.refreshTokenHash,{...session,id:'aaaaaaaa-0000-4000-8000-000000000003',refreshTokenHash:'next-synthetic-hash'},now);
  expect(rotated.status).toBe('ok');if(rotated.status==='ok')expect(rotated.session.expiresAt).toEqual(extended.expiresAt);
  await expect(store.extendById(session.id,extended.expiresAt.toISOString(),now)).rejects.toMatchObject({code:'SESSION_NOT_ACTIVE'});
  await store.revokeUser(session.userId,now);
  await expect(store.extendById('aaaaaaaa-0000-4000-8000-000000000003',extended.expiresAt.toISOString(),now)).rejects.toMatchObject({code:'SESSION_NOT_ACTIVE'});
  const expired=new MemorySessionStore();await expired.create({...session,expiresAt:new Date(now.getTime()-1)});
  await expect(expired.extendById(session.id,new Date(now.getTime()-1).toISOString(),now)).rejects.toMatchObject({code:'SESSION_NOT_ACTIVE'});
 });
 it.each(['inactive','changed'])('maps a Redis atomic conflict to a safe response (%s)',async(result)=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({result}),{status:200})));
  const store=new RedisRestSessionStore('https://redis.example.test','synthetic-test-token','preview:qa');
  await expect(store.extendById(session.id,session.expiresAt.toISOString(),now)).rejects.toMatchObject({statusCode:409,code:result==='inactive'?'SESSION_NOT_ACTIVE':'SESSION_CHANGED'});
 });
 it('sends a fixed server-side increment and compare value to the atomic Redis command',async()=>{
  const nextDate=new Date(session.expiresAt.getTime()+180*86400000).toISOString();let command:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{command=JSON.parse(options.body);return new Response(JSON.stringify({result:JSON.stringify({...session,createdAt:now.toISOString(),expiresAt:nextDate,revokedAt:null,replacedBy:null})}),{status:200})}));
  const store=new RedisRestSessionStore('https://redis.example.test','synthetic-test-token','preview:qa');
  expect((await store.extendById(session.id,session.expiresAt.toISOString(),now)).expiresAt.toISOString()).toBe(nextDate);
  expect(command[0]).toBe('EVAL');expect(command.slice(3)).toEqual(['preview:qa',session.id,session.expiresAt.toISOString(),String(now.getTime()),nextDate]);
 });
});
