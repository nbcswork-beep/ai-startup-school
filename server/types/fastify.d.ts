import type { AuthPrincipal } from '../auth/jwt-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal;
  }
}
