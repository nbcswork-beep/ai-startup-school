import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiChatService } from '../ai/chat.js';
import { AppError } from '../errors/app-error.js';

/**
 * Calls from Cloud Run workers to Vercel, with the shared worker secret:
 * - «send the answer-ready notice for this job» — takes only a job id and is safe to repeat (the
 *   notice has its own once-only claim);
 * - «a link to this attached file» — only for a job a worker is running now, only for that job's
 *   files, a presigned link to one object for five minutes;
 * - a ping for the worker's self-check.
 */
export function registerAiWorkerRoutes(app: FastifyInstance, deps: { chat: AiChatService; callbackSecret: string | null }): void {
  const expected = deps.callbackSecret ? Buffer.from(deps.callbackSecret) : null;
  const authorize = (authorization: string | undefined) => {
    if (!expected) throw new AppError('NOT_FOUND', 404, 'Not found');
    const header = authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AppError('UNAUTHORIZED', 401, 'Unauthorized');
  };
  const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  app.post('/api/v1/internal/ai/jobs/:id/notice', limit, async (request, reply) => {
    authorize(request.headers.authorization);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await deps.chat.deliverRelayedNotice(id);
    return reply.status(204).send();
  });
  app.post('/api/v1/internal/ai/jobs/:id/file-link', limit, async request => {
    authorize(request.headers.authorization);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { pathname } = z.object({ pathname: z.string().min(1).max(500) }).parse(request.body);
    return deps.chat.workerFileLink(id, pathname);
  });
  app.post('/api/v1/internal/ai/ping', limit, async (request, reply) => {
    authorize(request.headers.authorization);
    return reply.status(204).send();
  });
}
