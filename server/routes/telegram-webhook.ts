import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { webhookCallback } from 'grammy';
import type { AppEnv } from '../config/env.js';
import { createSchoolBot } from '../telegram/school-bot.js';

export type TelegramWebhookHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function matchesSecret(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value), configured = Buffer.from(expected);
  return actual.length === configured.length && timingSafeEqual(actual, configured);
}

function validMiniAppUrl(value: string | undefined): value is string {
  if (!value) return false;
  try { const url=new URL(value);return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}

export type TelegramWebhookDependency = 'TELEGRAM_BOT_TOKEN'|'TELEGRAM_WEBHOOK_SECRET'|'MINI_APP_URL';

export function unavailableTelegramWebhookDependencies(env:AppEnv):TelegramWebhookDependency[]{
  const unavailable:TelegramWebhookDependency[]=[];
  if (!env.TELEGRAM_BOT_TOKEN) unavailable.push('TELEGRAM_BOT_TOKEN');
  if (!env.TELEGRAM_WEBHOOK_SECRET) unavailable.push('TELEGRAM_WEBHOOK_SECRET');
  if (!validMiniAppUrl(env.MINI_APP_URL)) unavailable.push('MINI_APP_URL');
  return unavailable;
}

export function registerTelegramWebhookRoutes(app: FastifyInstance, env: AppEnv, injectedHandler?: TelegramWebhookHandler): void {
  const unavailableDependencies=unavailableTelegramWebhookDependencies(env);
  const configured = unavailableDependencies.length === 0;
  const handler = configured
    ? injectedHandler ?? webhookCallback(createSchoolBot(env.TELEGRAM_BOT_TOKEN!, env.MINI_APP_URL!), 'fastify', { onTimeout:'throw', timeoutMilliseconds:9_000 }) as TelegramWebhookHandler
    : undefined;

  if (!configured) app.log.warn({code:'TELEGRAM_WEBHOOK_UNAVAILABLE',dependencies:unavailableDependencies},'Telegram webhook dependencies are unavailable');

  app.post('/api/telegram/webhook', async (request, reply) => {
    if (!configured || !handler) {
      request.log.warn({code:'TELEGRAM_WEBHOOK_UNAVAILABLE',dependencies:unavailableDependencies.length?unavailableDependencies:['TELEGRAM_WEBHOOK_HANDLER']},'Telegram webhook request rejected because dependencies are unavailable');
      return reply.status(503).send({ error:{ code:'TELEGRAM_WEBHOOK_NOT_CONFIGURED', message:'Telegram webhook is not configured' } });
    }
    if (!matchesSecret(request.headers['x-telegram-bot-api-secret-token'], env.TELEGRAM_WEBHOOK_SECRET!)) {
      return reply.status(401).send({ error:{ code:'TELEGRAM_WEBHOOK_UNAUTHORIZED', message:'Unauthorized' } });
    }
    return handler(request, reply);
  });
}
