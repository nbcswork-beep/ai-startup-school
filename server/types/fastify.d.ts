import type { AuthPrincipal } from '../auth/jwt-service.js';
import type { AccessContext } from './domain.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthPrincipal;
    access: AccessContext;
  }
}
