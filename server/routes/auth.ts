import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '../config/env.js';
import type { AuthService } from '../services/auth-service.js';

const telegramBody = z.object({ initData: z.string().min(1).max(16_384) });
const webBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
  target: z.enum(['teacher', 'admin'])
}).strict();

function setRefreshCookie(reply: Parameters<FastifyInstance['post']>[1] extends never ? never : any, token: string, env: AppEnv) {
  const secure = env.NODE_ENV === 'production' || (env.origins.length > 0 && env.origins.every(origin => origin.startsWith('https://')));
  reply.setCookie('aiss_refresh', token, {
    path: '/api/v1/auth', httpOnly: true, secure, sameSite: 'strict',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400
  });
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, env: AppEnv): void {
  app.post('/api/v1/auth/telegram', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { initData } = telegramBody.parse(request.body);
    const result = await auth.loginWithTelegram(initData);
    setRefreshCookie(reply, result.refreshToken, env);
    return reply.send({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  });

  app.post('/api/v1/auth/development', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (_request, reply) => {
    const result = await auth.loginDevelopmentUser();
    setRefreshCookie(reply, result.refreshToken, env);
    return reply.send({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  });

  app.post('/api/v1/auth/web', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const { email, password, target } = webBody.parse(request.body);
    const result = await auth.loginWithPassword(email, password, target, request.ip);
    setRefreshCookie(reply, result.refreshToken, env);
    return reply.send({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  });

  app.post('/api/v1/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = await auth.refresh(request.cookies.aiss_refresh ?? '');
    setRefreshCookie(reply, result.refreshToken, env);
    return reply.send({ accessToken: result.accessToken, expiresIn: result.expiresIn, user: result.user });
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies.aiss_refresh);
    const secure = env.NODE_ENV === 'production' || (env.origins.length > 0 && env.origins.every(origin => origin.startsWith('https://')));
    reply.clearCookie('aiss_refresh', { path: '/api/v1/auth', httpOnly: true, secure, sameSite: 'strict' });
    return reply.status(204).send();
  });
}
