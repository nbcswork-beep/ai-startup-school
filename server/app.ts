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
import { registerTeacherRoutes } from './routes/teacher.js';
import { registerGuardianRoutes } from './routes/guardian.js';
import { registerAdminRoutes } from './routes/admin.js';
import type { AiProvider } from './services/ai-provider.js';
import { AiMentorService } from './services/ai-mentor-service.js';
import { AuthService } from './services/auth-service.js';
import { WebCredentialDirectory } from './auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, type LoginAttemptLimiter } from './auth/session-store.js';
import { registerTelegramWebhookRoutes, type TelegramWebhookHandler } from './routes/telegram-webhook.js';

export async function buildApp(deps: { env: AppEnv; repository: AppRepository; jwt: JwtService; aiProvider: AiProvider; loginLimiter?: LoginAttemptLimiter; telegramWebhookHandler?: TelegramWebhookHandler }) {
  const app = Fastify({ logger: deps.env.NODE_ENV === 'test' ? false : { level: deps.env.LOG_LEVEL,redact:{paths:['req.headers.authorization','req.headers.cookie','req.headers.x-telegram-bot-api-secret-token','res.headers.set-cookie','body.initData','body.refreshToken','body.password','body.token'],censor:'[REDACTED]'} }, trustProxy: deps.env.TRUST_PROXY, bodyLimit: 32_768 });
  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || deps.env.origins.includes(origin)) callback(null, true);
      else callback(null, false);
    }
  });
  await app.register(helmet, { contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",'https://telegram.org'],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'",'data:'],connectSrc:["'self'"],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:["'none'"],formAction:["'self'"]}},crossOriginEmbedderPolicy:false,referrerPolicy:{policy:'no-referrer'} });
  app.addHook('onSend',async(request,reply,payload)=>{reply.header('Permissions-Policy','camera=(), microphone=(), geolocation=()');if(request.url.startsWith('/api/'))reply.header('Cache-Control','no-store');return payload;});
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  registerErrorHandler(app);
  app.get('/api/health', async () => { await deps.repository.ping(); return { status: 'ok' }; });
  registerTelegramWebhookRoutes(app, deps.env, deps.repository, deps.telegramWebhookHandler);
  const auth = new AuthService(deps.repository, deps.jwt, deps.env, new WebCredentialDirectory(deps.env.WEB_AUTH_ACCOUNTS_JSON), deps.loginLimiter ?? new MemoryLoginAttemptLimiter());
  registerAuthRoutes(app, auth, deps.env);
  const authenticate=createAuthenticate(deps.jwt,deps.repository);
  registerStudentRoutes(app, deps.repository, new AiMentorService(deps.repository, deps.aiProvider), authenticate);
  registerTeacherRoutes(app,deps.repository,authenticate);
  registerGuardianRoutes(app,deps.repository,authenticate);
  registerAdminRoutes(app,deps.repository,authenticate,deps.env);
  return app;
}
