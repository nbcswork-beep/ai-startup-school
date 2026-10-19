import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiChatService } from '../ai/chat.js';
import { AppError } from '../errors/app-error.js';

/**
 * Calls from Cloud Run workers to Vercel. The only one: «send the answer-ready notice for this
 * job». It needs the shared secret, takes nothing but a job id, and is safe to repeat (the notice
 * has its own once-only claim), so a stolen request can at most send the fixed notice again.
 */
export function registerAiWorkerRoutes(app: FastifyInstance, deps: { chat: AiChatService; callbackSecret: string | null }): void {
  const expected = deps.callbackSecret ? Buffer.from(deps.callbackSecret) : null;
  app.post('/api/v1/internal/ai/jobs/:id/notice', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!expected) throw new AppError('NOT_FOUND', 404, 'Not found');
    const header = request.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AppError('UNAUTHORIZED', 401, 'Unauthorized');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await deps.chat.deliverRelayedNotice(id);
    return reply.status(204).send();
  });
}
