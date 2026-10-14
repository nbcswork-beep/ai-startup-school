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
import { SecretBox } from './ai/secret-box.js';
import { AiService } from './ai/service.js';
import { AiChatService } from './ai/chat.js';
import { TelegramAnswerNotifier, type AiAnswerNotifier } from './ai/notifier.js';
import { MemoryAiStore, RedisAiStore, UpstashRestClient, type AiStore } from './ai/store.js';
import type { ProviderAdapter, ProviderConnection } from './ai/adapters.js';
import { createAiStreamHandler, registerAiRoutes } from './routes/ai.js';
import { AuthService } from './services/auth-service.js';
import { WebCredentialDirectory } from './auth/password-credentials.js';
import { MemoryLoginAttemptLimiter, type LoginAttemptLimiter } from './auth/session-store.js';
import { registerTelegramWebhookRoutes, type TelegramWebhookHandler } from './routes/telegram-webhook.js';
import { registerNotificationWorkerRoute } from './routes/notification-worker.js';
import { NotificationWorker, TelegramNotificationSender, type NotificationSender } from './services/telegram-notification-service.js';
import { createFileStorage, type FileStorage } from './storage/file-storage.js';
import { fileLinkSigner, registerHomeworkFileRoutes, uploadPolicy } from './routes/homework-files.js';

export async function buildApp(deps: { env: AppEnv; repository: AppRepository; jwt: JwtService; aiStore?: AiStore; aiAdapterFactory?: (connection: ProviderConnection) => ProviderAdapter; aiNow?: () => Date; loginLimiter?: LoginAttemptLimiter; telegramWebhookHandler?: TelegramWebhookHandler; notificationSender?:NotificationSender; fileStorage?: FileStorage | null; aiNotifier?: AiAnswerNotifier | null; aiFetcher?: typeof fetch }) {
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
  const notificationSender=deps.notificationSender??(deps.env.TELEGRAM_BOT_TOKEN?new TelegramNotificationSender(deps.env.TELEGRAM_BOT_TOKEN):undefined);
  const auth = new AuthService(deps.repository, deps.jwt, deps.env, new WebCredentialDirectory(deps.env.WEB_AUTH_ACCOUNTS_JSON), deps.loginLimiter ?? new MemoryLoginAttemptLimiter());
  registerAuthRoutes(app, auth, deps.env);
  const authenticate=createAuthenticate(deps.jwt,deps.repository);
  app.get('/api/v1/academic-revision',{preHandler:[authenticate]},request=>deps.repository.academicRevision(request.auth.userId));
  const fileStorage = deps.fileStorage !== undefined ? deps.fileStorage : createFileStorage({
    blobConfigured: Boolean(deps.env.BLOB_STORE_ID || deps.env.BLOB_READ_WRITE_TOKEN),
    nodeEnv: deps.env.NODE_ENV,
    deployEnvironment: deps.env.deployEnvironment,
    localDirectory: deps.env.LOCAL_UPLOAD_DIR ?? '.data/homework-uploads'
  });
  const fileConfig = {
    storage: fileStorage,
    maxFileBytes: deps.env.HOMEWORK_UPLOAD_MAX_FILE_MB * 1024 * 1024,
    maxFiles: deps.env.HOMEWORK_UPLOAD_MAX_FILES,
    maxTotalBytes: deps.env.HOMEWORK_UPLOAD_MAX_TOTAL_MB * 1024 * 1024,
    pathPrefix: deps.env.FILE_STORAGE_PREFIX ?? deps.env.deployEnvironment
  };
  deps.repository.setFileLinkSigner(fileStorage ? fileLinkSigner(fileStorage) : null);
  registerStudentRoutes(app, deps.repository, authenticate, uploadPolicy(fileConfig));
  // AI assistant: provider keys sealed at rest, balances and chats in their own Redis namespace.
  const aiStore = deps.aiStore ?? (deps.env.NODE_ENV !== 'test' && deps.env.UPSTASH_REDIS_REST_URL && deps.env.UPSTASH_REDIS_REST_TOKEN
    ? new RedisAiStore(new UpstashRestClient(deps.env.UPSTASH_REDIS_REST_URL, deps.env.UPSTASH_REDIS_REST_TOKEN), deps.env.aiRedisPrefix)
    : new MemoryAiStore());
  const ai = new AiService({
    store: aiStore,
    secrets: SecretBox.fromEnv(deps.env),
    roster: () => deps.repository.getAiRoster(),
    allowLocalProviderUrls: deps.env.deployEnvironment === 'local',
    fileStorage,
    storagePrefix: fileConfig.pathPrefix,
    // "Answer ready" notices go through the school bot and open the Mini App on that chat.
    notifier: deps.aiNotifier !== undefined ? deps.aiNotifier : deps.env.TELEGRAM_BOT_TOKEN && deps.env.MINI_APP_URL ? new TelegramAnswerNotifier(deps.env.TELEGRAM_BOT_TOKEN, deps.env.MINI_APP_URL) : null,
    log: (error, message) => app.log.error({ err: error }, message),
    ...(deps.aiNow ? { now: deps.aiNow } : {}),
    ...(deps.aiFetcher ? { fetcher: deps.aiFetcher } : {}),
    ...(deps.aiAdapterFactory ? { adapterFactory: deps.aiAdapterFactory } : {})
  });
  const aiChat = new AiChatService(ai);
  registerNotificationWorkerRoute(app,deps.env,notificationSender?new NotificationWorker(deps.repository,notificationSender,deps.env.PARENT_WEEKLY_REPORT_DAY,deps.env.PARENT_WEEKLY_REPORT_HOUR_KYIV):undefined,()=>aiChat.sweepJobs());
  registerAiRoutes(app, { repository: deps.repository, authenticate, ai, chat: aiChat });
  app.decorate('aiStreamHandler', createAiStreamHandler({ jwt: deps.jwt, repository: deps.repository, chat: aiChat, origins: deps.env.origins }));
  registerHomeworkFileRoutes(app, deps.repository, authenticate, fileConfig);
  registerTeacherRoutes(app,deps.repository,authenticate);
  registerGuardianRoutes(app,deps.repository,authenticate);
  registerAdminRoutes(app,deps.repository,authenticate,deps.env);
  return app;
}
