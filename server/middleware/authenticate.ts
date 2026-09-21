import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtService } from '../auth/jwt-service.js';
import type { AppRepository } from '../data/repository.js';
import type { AppRole } from '../types/domain.js';
import { AppError } from '../errors/app-error.js';

export function createAuthenticate(jwt: JwtService, repository: AppRepository) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('AUTH_REQUIRED', 401, 'Потрібна авторизація');
    request.auth = await jwt.verify(header.slice(7));
    request.access = await repository.getAccessContext(request.auth.userId, request.auth.sessionId);
    if (!request.access.sessionActive || request.access.status !== 'active') {
      throw new AppError('SESSION_REVOKED', 401, 'Сесію завершено. Увійдіть ще раз.');
    }
  };
}

export function requireRole(role: AppRole) {
  return async function authorizeRole(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.access.roles.includes(role)) throw new AppError('ROLE_FORBIDDEN', 403, 'Недостатньо прав');
  };
}
