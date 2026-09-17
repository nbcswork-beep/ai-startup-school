import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtService } from '../auth/jwt-service.js';
import { AppError } from '../errors/app-error.js';

export function createAuthenticate(jwt: JwtService) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('AUTH_REQUIRED', 401, 'Потрібна авторизація');
    request.auth = await jwt.verify(header.slice(7));
  };
}
