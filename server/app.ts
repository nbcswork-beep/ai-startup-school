import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { JwtService } from './auth/jwt-service.js';
import type { AppEnv } from './config/env.js';
import type { AppRepository } from './data/repository.js';
import { registerErrorHandler } from './errors/error-handler.js';
import { createAuthenticate } from './middleware/authenticate.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerStudentRoutes } from './routes/student.js';
import type { AiProvider } from './services/ai-provider.js';
import { AiMentorService } from './services/ai-mentor-service.js';
import { AuthService } from './services/auth-service.js';

export async function buildApp(deps: { env: AppEnv; repository: AppRepository; jwt: JwtService; aiProvider: AiProvider }) {
  const app = Fastify({ logger: deps.env.NODE_ENV === 'test' ? false : { level: deps.env.LOG_LEVEL }, trustProxy: true, bodyLimit: 32_768 });
  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || deps.env.origins.includes(origin)) callback(null, true);
      else callback(null, false);
    }
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  registerErrorHandler(app);
  app.get('/api/health', async () => { await deps.repository.ping(); return { status: 'ok' }; });
  const auth = new AuthService(deps.repository, deps.jwt, deps.env);
  registerAuthRoutes(app, auth, deps.env);
  registerStudentRoutes(app, deps.repository, new AiMentorService(deps.repository, deps.aiProvider), createAuthenticate(deps.jwt));
  return app;
}
