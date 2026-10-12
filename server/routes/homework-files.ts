import { randomUUID } from 'node:crypto';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { AppRepository } from '../data/repository.js';
import { AppError } from '../errors/app-error.js';
import { requireRole } from '../middleware/authenticate.js';
import { LocalDevFileStorage, type FileStorage } from '../storage/file-storage.js';
import {
  HOMEWORK_FILE_EXTENSIONS, HOMEWORK_FILE_TYPES, SIGNATURE_SAMPLE_BYTES,
  cleanDisplayName, fileExtension, isHomeworkFileExtension, matchesSignature, storageSafeName
} from '../storage/file-types.js';
import type { FileUploadPolicyDto } from '../types/domain.js';

export interface HomeworkFileConfig {
  storage: FileStorage | null;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  /** First pathname segment, so environments sharing one store never mix objects. */
  pathPrefix: string;
}

const UPLOAD_URL_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_URL_TTL_MS = 30 * 60 * 1000;
const uuid = z.string().uuid();
const uploadInput = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0) }).strict();
const supportedLabel = HOMEWORK_FILE_EXTENSIONS.filter(extension => extension !== 'jpeg').map(extension => HOMEWORK_FILE_TYPES[extension].label).join(', ');
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} МБ`;

export function uploadPolicy(config: HomeworkFileConfig): FileUploadPolicyDto {
  return {
    enabled: Boolean(config.storage),
    reason: config.storage ? null : 'Завантаження файлів ще не підключено. Надішли роботу текстом або посиланням.',
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    maxTotalBytes: config.maxTotalBytes,
    extensions: [...HOMEWORK_FILE_EXTENSIONS]
  };
}

/** Signed links for file DTOs; the repository calls this when it lists attachments. */
export function fileLinkSigner(storage: FileStorage) {
  return async (pathname: string) => {
    const expiresAt = Date.now() + DOWNLOAD_URL_TTL_MS;
    return { url: await storage.createDownloadUrl(pathname, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
  };
}

export function registerHomeworkFileRoutes(app: FastifyInstance, repository: AppRepository, authenticate: preHandlerHookHandler, config: HomeworkFileConfig): void {
  const secured = { preHandler: [authenticate, requireRole('student')] };
  const storage = () => {
    if (!config.storage) throw new AppError('FILE_STORAGE_UNAVAILABLE', 503, 'Завантаження файлів ще не підключено. Надішли роботу текстом або посиланням.');
    return config.storage;
  };
  const removeObjects = (pathnames: string[]) => {
    if (!pathnames.length || !config.storage) return Promise.resolve();
    return config.storage.delete(pathnames).catch(error => app.log.warn({ err: error, count: pathnames.length }, 'Homework file cleanup failed'));
  };

  app.get('/api/v1/homework/upload-policy', secured, async () => uploadPolicy(config));

  // Step 1: validate the declared file and reserve a private pathname; the browser then sends the
  // bytes directly to storage with the returned one-object URL.
  app.post('/api/v1/homework/:homeworkId/uploads', { ...secured, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { homeworkId } = z.object({ homeworkId: uuid }).parse(request.params);
    const body = uploadInput.parse(request.body);
    const target = storage();
    const name = cleanDisplayName(body.name);
    const extension = fileExtension(name);
    if (!name || !isHomeworkFileExtension(extension)) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415, `Цей формат не підтримується. Можна: ${supportedLabel}.`);
    if (body.size === 0) throw new AppError('FILE_EMPTY', 400, 'Файл порожній. Обери інший файл.');
    if (body.size > config.maxFileBytes) throw new AppError('FILE_TOO_LARGE', 413, `Файл завеликий. Максимум — ${megabytes(config.maxFileBytes)}.`);
    const id = randomUUID();
    const mimeType = HOMEWORK_FILE_TYPES[extension].mimeType;
    const pathname = `${config.pathPrefix}/homework/${homeworkId}/${request.auth.userId}/${id}/${storageSafeName(name, extension)}`;
    const now = new Date();
    const expiresAt = now.getTime() + UPLOAD_URL_TTL_MS;
    const { file, expiredPathnames } = await repository.reserveHomeworkUpload(request.auth.userId, homeworkId, {
      id, originalName: name, extension, mimeType, size: body.size, pathname, expiresAt: new Date(expiresAt).toISOString()
    }, { maxFiles: config.maxFiles, maxTotalBytes: config.maxTotalBytes }, now);
    void removeObjects(expiredPathnames);
    let upload;
    try {
      upload = await target.createUploadTarget({ pathname, contentType: mimeType, size: body.size, expiresAt });
    } catch (error) {
      request.log.error({ err: error }, 'Homework upload URL could not be issued');
      await repository.discardHomeworkUpload(request.auth.userId, homeworkId, id).catch(() => undefined);
      throw new AppError('FILE_STORAGE_FAILED', 502, 'Сховище файлів тимчасово недоступне. Спробуй ще раз за хвилину.');
    }
    return reply.status(201).send({ file, upload, expiresAt: new Date(expiresAt).toISOString() });
  });

  // Step 2: the server checks what actually arrived — size and file signature — before the file can
  // be attached. A mismatch removes the object; nothing unverified is ever shown as uploaded.
  app.post('/api/v1/homework/:homeworkId/uploads/:uploadId/complete', { ...secured, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const { homeworkId, uploadId } = z.object({ homeworkId: uuid, uploadId: uuid }).parse(request.params);
    const target = storage();
    const userId = request.auth.userId;
    const record = await repository.getHomeworkUpload(userId, homeworkId, uploadId);
    if (record.status === 'ready') return repository.completeHomeworkUpload(userId, homeworkId, uploadId);
    if (!isHomeworkFileExtension(record.extension)) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415, 'Цей формат не підтримується.');
    let stored;
    try { stored = await target.head(record.pathname); }
    catch (error) {
      request.log.error({ err: error }, 'Homework upload could not be verified');
      throw new AppError('FILE_STORAGE_FAILED', 502, 'Не вдалося перевірити файл. Спробуй ще раз.');
    }
    if (!stored) throw new AppError('UPLOAD_INCOMPLETE', 409, 'Файл ще не завантажився повністю. Спробуй ще раз.');
    const reject = async (code: string, status: number, message: string): Promise<never> => {
      await repository.discardHomeworkUpload(userId, homeworkId, uploadId).catch(() => undefined);
      await removeObjects([record.pathname]);
      throw new AppError(code, status, message);
    };
    if (stored.size !== record.size) await reject('FILE_SIZE_MISMATCH', 422, 'Файл завантажився не повністю. Прикріпи його ще раз.');
    const sample = await target.readStart(record.pathname, SIGNATURE_SAMPLE_BYTES);
    if (!matchesSignature(record.extension, sample)) {
      await reject('FILE_CONTENT_MISMATCH', 415, `Вміст файлу не відповідає формату .${record.extension}. Перевір файл і прикріпи його ще раз.`);
    }
    return repository.completeHomeworkUpload(userId, homeworkId, uploadId);
  });

  app.delete('/api/v1/homework/:homeworkId/uploads/:uploadId', secured, async (request, reply) => {
    const { homeworkId, uploadId } = z.object({ homeworkId: uuid, uploadId: uuid }).parse(request.params);
    const { pathname } = await repository.discardHomeworkUpload(request.auth.userId, homeworkId, uploadId);
    if (pathname) await removeObjects([pathname]);
    return reply.status(204).send();
  });

  if (config.storage instanceof LocalDevFileStorage) registerDevStorageRoutes(app, config.storage, config.maxFileBytes);
}

/**
 * Serves the signed URLs of LocalDevFileStorage. Registered only for a local developer machine or
 * a test run — never on Vercel, whose filesystem is temporary.
 */
function registerDevStorageRoutes(app: FastifyInstance, storage: LocalDevFileStorage, maxFileBytes: number): void {
  void app.register(async scope => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: maxFileBytes + 1 }, (_request, body, done) => done(null, body));
    const tokenQuery = z.object({ token: z.string().min(10).max(4096) });
    scope.put('/api/v1/dev-storage/objects', { bodyLimit: maxFileBytes + 1 }, async (request, reply) => {
      const grant = storage.verify(tokenQuery.parse(request.query).token);
      if (!grant || grant.op !== 'put') throw new AppError('UPLOAD_URL_INVALID', 403, 'Посилання для завантаження недійсне або прострочене');
      const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (request.headers['content-type']?.split(';')[0]?.trim() !== grant.contentType) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415, 'Тип файлу не збігається з дозволеним');
      if (grant.size !== undefined && bytes.length > grant.size) throw new AppError('FILE_TOO_LARGE', 413, 'Файл більший за заявлений розмір');
      try { await storage.write(grant, bytes); }
      catch (error) {
        if ((error as { code?: string }).code === 'EXISTS') throw new AppError('UPLOAD_EXISTS', 409, 'Файл уже завантажено');
        throw error;
      }
      return reply.status(200).send({ pathname: grant.pathname });
    });
    scope.get('/api/v1/dev-storage/objects', async (request, reply) => {
      const grant = storage.verify(tokenQuery.parse(request.query).token);
      if (!grant || grant.op !== 'get') throw new AppError('DOWNLOAD_URL_INVALID', 403, 'Посилання на файл недійсне або прострочене');
      const object = await storage.read(grant.pathname);
      if (!object) throw new AppError('FILE_NOT_FOUND', 404, 'Файл не знайдено');
      const fileName = grant.pathname.split('/').pop() ?? 'file';
      return reply
        .header('content-type', object.contentType)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "sandbox; default-src 'none'")
        .send(Buffer.from(object.bytes));
    });
  });
}
