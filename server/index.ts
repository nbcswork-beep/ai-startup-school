import 'dotenv/config';
import { createJwtService } from './auth/jwt-service.js';
import { loadEnv } from './config/env.js';
import { MemoryRepository } from './data/memory-repository.js';
import { PostgresRepository } from './data/postgres-repository.js';
import { MockAiProvider } from './services/ai-provider.js';
import { buildApp } from './app.js';

const env = loadEnv();
const repository = env.DATA_BACKEND === 'postgres'
  ? new PostgresRepository(env.DATABASE_URL!, env.DATABASE_SSL, env.WORKSPACE_URL, env.NODE_ENV === 'production')
  : new MemoryRepository(env.WORKSPACE_URL, {
    telegramBindingsJson: env.TELEGRAM_STUDENT_BINDINGS_JSON,
    requireSeededTelegramIdentity: env.NODE_ENV === 'production'
  });
const jwt = await createJwtService(env);
const app = await buildApp({ env, repository, jwt, aiProvider: new MockAiProvider() });

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
