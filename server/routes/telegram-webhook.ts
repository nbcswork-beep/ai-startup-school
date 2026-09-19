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
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
}

export function registerTelegramWebhookRoutes(app: FastifyInstance, env: AppEnv, injectedHandler?: TelegramWebhookHandler): void {
  const configured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && validMiniAppUrl(env.MINI_APP_URL));
  const handler = configured
    ? injectedHandler ?? webhookCallback(createSchoolBot(env.TELEGRAM_BOT_TOKEN!, env.MINI_APP_URL!), 'fastify', { onTimeout:'throw', timeoutMilliseconds:9_000 }) as TelegramWebhookHandler
    : undefined;

  app.post('/api/telegram/webhook', async (request, reply) => {
    if (!configured || !handler) return reply.status(503).send({ error:{ code:'TELEGRAM_WEBHOOK_NOT_CONFIGURED', message:'Telegram webhook is not configured' } });
    if (!matchesSecret(request.headers['x-telegram-bot-api-secret-token'], env.TELEGRAM_WEBHOOK_SECRET!)) {
      return reply.status(401).send({ error:{ code:'TELEGRAM_WEBHOOK_UNAUTHORIZED', message:'Unauthorized' } });
    }
    return handler(request, reply);
  });
}
