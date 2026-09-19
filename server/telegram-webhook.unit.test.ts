import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { MockAiProvider } from './services/ai-provider.js';
import { createSchoolBot } from './telegram/school-bot.js';
import { unavailableTelegramWebhookDependencies } from './routes/telegram-webhook.js';

const SECRET='telegram_webhook_test_secret_123';
const MINI_APP_URL='https://ai-startup-school.example.test';
let apps:FastifyInstance[]=[];

async function testApp(configured=true,handler?:Parameters<typeof buildApp>[0]['telegramWebhookHandler']){
  const env=loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'webhook-test-pepper',...(configured?{TELEGRAM_BOT_TOKEN:'123456789:test-token',TELEGRAM_WEBHOOK_SECRET:SECRET,MINI_APP_URL}: {})});
  const app=await buildApp({env,repository:new MemoryRepository(),jwt:await createJwtService(env),aiProvider:new MockAiProvider(),...(handler?{telegramWebhookHandler:handler}:{})});
  apps.push(app);return app;
}

afterEach(async()=>{await Promise.all(apps.map(app=>app.close()));apps=[]});

function update(updateId:number,text:string,userId=987654321){return{update_id:updateId,message:{message_id:updateId,date:1,chat:{id:userId,type:'private'},from:{id:userId,is_bot:false,first_name:'Test'},text,entities:[{offset:0,length:text.length,type:'bot_command'}]}}}

describe('Telegram production webhook',()=>{
  it('rejects missing or wrong webhook secrets before processing the update',async()=>{
    const handler=vi.fn(async(_request,_reply)=>undefined);
    const app=await testApp(true,handler);
    expect((await app.inject({method:'POST',url:'/api/telegram/webhook',payload:update(1,'/id')})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':'wrong-secret-value'},payload:update(2,'/id')})).statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts the configured secret and leaves health available',async()=>{
    const handler=vi.fn(async(_request,reply)=>reply.status(200).send(''));
    const app=await testApp(true,handler);
    expect((await app.inject({method:'POST',url:'/api/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':SECRET},payload:update(3,'/id')})).statusCode).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect((await app.inject({method:'GET',url:'/api/health'})).json()).toEqual({status:'ok'});
  });

  it('fails closed when webhook environment is incomplete',async()=>{
    const app=await testApp(false);
    const response=await app.inject({method:'POST',url:'/api/telegram/webhook',headers:{'x-telegram-bot-api-secret-token':SECRET},payload:update(4,'/id')});
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('TELEGRAM_WEBHOOK_NOT_CONFIGURED');
    expect(unavailableTelegramWebhookDependencies(loadEnv({NODE_ENV:'test',DATA_BACKEND:'memory',DEV_EPHEMERAL_JWT:'true',SESSION_TOKEN_PEPPER:'test-pepper'}))).toEqual(['TELEGRAM_BOT_TOKEN','TELEGRAM_WEBHOOK_SECRET','MINI_APP_URL']);
  });

  it('preserves /id, /start and /school behavior in the shared bot',async()=>{
    const bot=createSchoolBot('123456789:test-token',MINI_APP_URL);
    bot.botInfo={id:123456789,is_bot:true,first_name:'AI Startup School',username:'aiss_test_bot',can_join_groups:false,can_read_all_group_messages:false,supports_inline_queries:false,can_connect_to_business:false,has_main_web_app:true};
    const calls:Array<{method:string;payload:Record<string,unknown>}>=[];
    bot.api.config.use(async(_previous,method,payload)=>{calls.push({method,payload:payload as Record<string,unknown>});return{ok:true,result:{message_id:calls.length,date:1,chat:{id:987654321,type:'private'}}} as never});
    await bot.handleUpdate(update(10,'/id'));
    await bot.handleUpdate(update(11,'/start'));
    await bot.handleUpdate(update(12,'/school'));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({method:'sendMessage',payload:{text:'987654321'}});
    expect(JSON.stringify(calls[0]!.payload)).not.toContain('test-token');
    expect(calls[1]!.payload).toMatchObject({reply_markup:{inline_keyboard:[[{web_app:{url:MINI_APP_URL}}]]}});
    expect(calls[2]!.payload).toMatchObject({text:'Відкрити школу:',reply_markup:{inline_keyboard:[[{web_app:{url:MINI_APP_URL}}]]}});
  });
});
