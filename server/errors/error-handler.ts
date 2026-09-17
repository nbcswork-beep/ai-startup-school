import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './app-error.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Некоректні дані запиту', requestId: request.id, details: error.flatten() }
      });
    }
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error, code: error.code }, error.message);
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id, ...(error.details ? { details: error.details } : {}) }
      });
    }
    if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        error: { code: error.code || 'REQUEST_ERROR', message: error.message, requestId: request.id }
      });
    }
    request.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Внутрішня помилка сервера', requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) => reply.status(404).send({
    error: { code: 'NOT_FOUND', message: 'Маршрут не знайдено', requestId: request.id }
  }));
}
