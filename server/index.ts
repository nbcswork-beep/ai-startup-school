import 'dotenv/config';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { PostgresRepository } from './data/postgres-repository.js';
import { MockAiProvider } from './services/ai-provider.js';
import { buildApp } from './app.js';
import { RedisRestLoginAttemptLimiter, RedisRestSessionStore } from './auth/session-store.js';

const env = loadEnv();
const redisSessionStore = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
  ? new RedisRestSessionStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN, env.SESSION_REDIS_PREFIX)
  : undefined;
const repository = env.DATA_BACKEND === 'postgres'
  ? new PostgresRepository(env.DATABASE_URL!, env.DATABASE_SSL, env.WORKSPACE_URL, env.NODE_ENV === 'production')
  : new MemoryRepository(env.WORKSPACE_URL, {
    telegramBindingsJson: env.TELEGRAM_STUDENT_BINDINGS_JSON,
    requireSeededTelegramIdentity: env.NODE_ENV === 'production',
    ...(redisSessionStore ? { sessionStore: redisSessionStore } : {})
  });
const jwt = await createJwtService(env);
const loginLimiter = env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
  ? new RedisRestLoginAttemptLimiter(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN, env.SESSION_REDIS_PREFIX)
  : undefined;
const app = await buildApp({ env, repository, jwt, aiProvider: new MockAiProvider(), ...(loginLimiter ? { loginLimiter } : {}) });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
