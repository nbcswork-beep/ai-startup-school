import type { AuthPrincipal } from '../auth/jwt-service.js';
import type { AccessContext } from './domain.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal;
    access: AccessContext;
  }
  interface FastifyInstance {
    /** Streams an AI answer from a plain fetch Request; used by the dedicated Vercel function. */
    aiStreamHandler: (request: Request) => Promise<{ response: Response; done: Promise<void> | null }>;
  }
}
