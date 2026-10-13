import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { AiProviderError, type ChatTurn, type ProviderUsage } from './adapters.js';
import { costMicros, type AiService } from './service.js';
import { dayKey, hourKey, monthKey } from './time.js';
import { countChatTokens, countTokens, withSafetyMargin } from './tokenizer.js';
import type { AiAttachment, AiConversation, AiMessage, AiModelRecord, AiProviderRecord, AiUsageStatus } from './types.js';
import { ATTACHMENT_MAX_BYTES, extractArchiveText, parseAnswerFiles, renderAttachment } from './files.js';
import { createZip, ZipFormatError } from './zip.js';
import { cleanDisplayName, fileExtension, storageSafeName } from '../storage/file-types.js';

const MESSAGE_CAP = 400;
const HISTORY_LOAD = 80;
const CONVERSATION_LIMIT = 200;
const MIN_ANSWER_TOKENS = 256;
const RESERVATION_TTL_MS = 6 * 60_000;
const HEARTBEAT_MS = 15_000;
const ATTACHMENT_UPLOAD_TTL_MS = 15 * 60_000;
const UNUSED_ATTACHMENT_TTL_MS = 24 * 60 * 60_000;
const MAX_UNUSED_ATTACHMENTS = 10;
const MAX_ATTACHMENTS_PER_MESSAGE = 3;
const ARCHIVE_LINK_TTL_MS = 10 * 60_000;

// Interface rules appended to the admin's system prompt: how archives arrive and how files go back.
const FILE_RULES = [
  'Правила інтерфейсу чату:',
  '- Учень може прикріпити ZIP-архів. Його текстові файли приходять у повідомленні між рядками «--- файл: шлях ---» і «--- кінець файлу ---».',
  '- Коли учень просить файли, проєкт або архів, пиши кожен файл окремим блоком коду, а після трьох зворотних апострофів вказуй мову і шлях, наприклад: ```js src/app.js',
  '- Інтерфейс сам збере такі блоки в ZIP-архів із кнопкою «Завантажити ZIP» після завершення відповіді. Не вигадуй посилань на завантаження і не кажи, що не можеш надіслати файли.',
  '- Для сайту використовуй заголовки блоків ```html index.html, ```css style.css та ```js script.js. Назва лише над блоком не замінює шлях у його заголовку. Кожен блок має містити повний вміст файлу та закриватися трьома зворотними апострофами.',
  '- Створення ZIP виконує цей застосунок: тобі достатньо надати файли у вказаному форматі. Не пропонуй учневі вручну копіювати файли й пакувати архів; поясни, що готовий ZIP можна завантажити кнопкою під відповіддю.'
].join('\n');

export interface ChatInput {
  content: string;
  modelId?: string | undefined;
  clientRequestId: string;
  attachmentIds?: string[] | undefined;
}

export interface ChatSession {
  stream: ReadableStream<Uint8Array>;
  /** Resolves after the final charge and the messages are stored, even if the client went away. */
  done: Promise<void>;
}

function titleFrom(text: string): string {
  // A title is plain words: drop Markdown markers, code fences and list bullets from the first message.
  const line = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'Новий чат';
}

function studentMessage(error: AiProviderError): { code: string; message: string } {
  switch (error.code) {
    case 'rate_limit': return { code: 'AI_PROVIDER_BUSY', message: 'ШІ-сервіс зараз перевантажений. Спробуйте за хвилину.' };
    case 'auth':
    case 'quota': return { code: 'AI_PROVIDER_UNAVAILABLE', message: 'ШІ-сервіс тимчасово недоступний. Повідомте викладача, якщо це повторюється.' };
    case 'bad_request':
    case 'not_found': return { code: 'AI_PROVIDER_REJECTED', message: 'Модель не змогла обробити запит. Спробуйте іншу модель або коротше повідомлення.' };
    case 'timeout': return { code: 'AI_PROVIDER_TIMEOUT', message: 'ШІ-сервіс не відповів вчасно. Спробуйте ще раз.' };
    default: return { code: 'AI_PROVIDER_ERROR', message: 'Не вдалося отримати відповідь. Спробуйте ще раз.' };
  }
}

export class AiChatService {
  constructor(private readonly ai: AiService) {}

  private async studentGroup(studentId: string): Promise<string | null> {
    return (await this.ai.roster()).students.find(student => student.id === studentId)?.groupId ?? null;
  }

  async me(studentId: string) {
    const groupId = await this.studentGroup(studentId);
    let balance = (await this.ai.store.getBalances([studentId])).get(studentId)!;
    if (await this.ai.renewIfDue(balance)) balance = (await this.ai.store.getBalances([studentId])).get(studentId)!;
    const access = await this.ai.accessFor(studentId, groupId);
    const available = Math.max(0, balance.balance - balance.reserved);
    return {
      configured: access.models.length > 0,
      balance: {
        available,
        used: balance.used,
        approximateUsed: balance.approxUsed,
        blocked: balance.blocked,
        monthlyLimit: balance.monthlyLimit,
        low: available > 0 && available <= access.settings.lowBalanceTokens,
        exhausted: available <= 0
      },
      models: access.models.map(model => ({ id: model.id, label: model.label, family: model.family })),
      defaultModelId: access.defaultModel?.id ?? null,
      limits: { maxMessageChars: access.settings.maxMessageChars, attachments: { enabled: Boolean(this.ai.deps.fileStorage), maxBytes: ATTACHMENT_MAX_BYTES } }
    };
  }

  async listConversations(studentId: string) {
    return (await this.ai.store.listConversations(studentId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async requireConversation(studentId: string, conversationId: string): Promise<AiConversation> {
    const conversation = await this.ai.store.getConversation(studentId, conversationId);
    // Another student's id looks exactly like a missing one.
    if (!conversation || conversation.studentId !== studentId) throw new AppError('AI_CONVERSATION_NOT_FOUND', 404, 'Чат не знайдено');
    return conversation;
  }

  async createConversation(studentId: string, title?: string) {
    const existing = await this.ai.store.listConversations(studentId);
    if (existing.length >= CONVERSATION_LIMIT) throw new AppError('AI_CONVERSATION_LIMIT', 409, 'Забагато чатів. Видаліть старі, щоб створити новий.');
    const now = this.ai.now().toISOString();
    const conversation: AiConversation = { id: randomUUID(), studentId, title: title?.trim() || 'Новий чат', modelId: null, createdAt: now, updatedAt: now, messageCount: 0, preview: '' };
    await this.ai.store.putConversation(conversation);
    return conversation;
  }

  async getConversation(studentId: string, conversationId: string) {
    const conversation = await this.requireConversation(studentId, conversationId);
    const messages = (await this.ai.store.getMessages(conversationId, MESSAGE_CAP)).map(message => {
      if (message.role !== 'assistant') return message;
      // Recompute for older replies too, without rewriting history or generating another answer.
      const { archive: _archive, ...rest } = message;
      const files = parseAnswerFiles(message.content);
      return { ...rest, ...(files.length ? { archive: { fileCount: files.length, paths: files.slice(0, 30).map(file => file.path) } } : {}) };
    });
    return { conversation, messages };
  }

  async renameConversation(studentId: string, conversationId: string, title: string) {
    const conversation = await this.requireConversation(studentId, conversationId);
    const next = { ...conversation, title: title.trim() || conversation.title };
    await this.ai.store.putConversation(next);
    return next;
  }

  async deleteConversation(studentId: string, conversationId: string) {
    await this.requireConversation(studentId, conversationId);
    const messages = await this.ai.store.getMessages(conversationId, MESSAGE_CAP);
    await this.ai.store.deleteConversation(studentId, conversationId);
    // Archives sent in this chat go with it.
    const attachmentIds = messages.flatMap(message => message.attachments?.map(item => item.id) ?? []);
    for (const id of attachmentIds) await this.removeAttachment(studentId, id);
  }

  // -------------------------------------------------------------------------------------------
  // Attachments: the browser uploads the ZIP straight to private storage, the server unpacks it.

  private storage() {
    const storage = this.ai.deps.fileStorage;
    if (!storage) throw new AppError('AI_ATTACHMENTS_UNAVAILABLE', 503, 'Прикріплення файлів ще не підключено.');
    return storage;
  }

  private attachmentDto(attachment: AiAttachment) {
    const { pathname: _pathname, studentId: _studentId, ...dto } = attachment;
    return dto;
  }

  private async removeAttachment(studentId: string, attachmentId: string): Promise<void> {
    const attachment = await this.ai.store.getAttachment(studentId, attachmentId);
    if (!attachment) return;
    await this.ai.store.deleteAttachment(studentId, attachmentId);
    await this.ai.deps.fileStorage?.delete([attachment.pathname]).catch(error => this.ai.log(error, 'AI attachment cleanup failed'));
  }

  /** Drops uploads that never finished and archives that were never sent. */
  private async sweepAttachments(studentId: string, now: number): Promise<AiAttachment[]> {
    const kept: AiAttachment[] = [];
    for (const attachment of await this.ai.store.listAttachments(studentId)) {
      const stale = attachment.status === 'pending' ? Date.parse(attachment.expiresAt) < now : !attachment.usedIn && Date.parse(attachment.createdAt) + UNUSED_ATTACHMENT_TTL_MS < now;
      if (stale) await this.removeAttachment(studentId, attachment.id);
      else kept.push(attachment);
    }
    return kept;
  }

  async reserveAttachment(studentId: string, input: { name: string; size: number }) {
    const storage = this.storage();
    const name = cleanDisplayName(input.name);
    if (!name || fileExtension(name) !== 'zip') throw new AppError('AI_ATTACHMENT_TYPE', 415, 'Можна прикріпити лише ZIP-архів.');
    if (input.size <= 0) throw new AppError('AI_ATTACHMENT_EMPTY', 400, 'Архів порожній.');
    if (input.size > ATTACHMENT_MAX_BYTES) throw new AppError('AI_ATTACHMENT_TOO_LARGE', 413, `Архів завеликий: максимум ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)} МБ.`);
    const now = this.ai.now().getTime();
    const current = await this.sweepAttachments(studentId, now);
    if (current.filter(item => !item.usedIn).length >= MAX_UNUSED_ATTACHMENTS) throw new AppError('AI_ATTACHMENT_LIMIT', 409, 'Забагато ненадісланих архівів. Надішліть або видаліть попередні.');
    const id = randomUUID();
    const expiresAt = now + ATTACHMENT_UPLOAD_TTL_MS;
    const attachment: AiAttachment = {
      id, studentId, name, size: input.size,
      pathname: `${this.ai.deps.storagePrefix ?? 'local'}/ai/${studentId}/${id}/${storageSafeName(name, 'zip')}`,
      status: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      files: [], skipped: [], estimatedTokens: 0, usedIn: null
    };
    await this.ai.store.putAttachment(attachment);
    try {
      const upload = await storage.createUploadTarget({ pathname: attachment.pathname, contentType: 'application/zip', size: input.size, expiresAt });
      return { attachment: this.attachmentDto(attachment), upload, expiresAt: attachment.expiresAt };
    } catch (error) {
      this.ai.log(error, 'AI attachment upload URL could not be issued');
      await this.ai.store.deleteAttachment(studentId, id);
      throw new AppError('FILE_STORAGE_FAILED', 502, 'Сховище файлів тимчасово недоступне. Спробуйте ще раз за хвилину.');
    }
  }

  /** Checks what arrived, unpacks the text files and keeps them for the model. */
  async completeAttachment(studentId: string, attachmentId: string) {
    const storage = this.storage();
    const attachment = await this.ai.store.getAttachment(studentId, attachmentId);
    if (!attachment) throw new AppError('AI_ATTACHMENT_NOT_FOUND', 404, 'Архів не знайдено');
    if (attachment.status === 'ready') return this.attachmentDto(attachment);
    const stored = await storage.head(attachment.pathname);
    if (!stored) throw new AppError('UPLOAD_INCOMPLETE', 409, 'Архів ще не завантажено. Спробуйте ще раз.');
    const reject = async (code: string, status: number, message: string) => {
      await this.removeAttachment(studentId, attachmentId);
      throw new AppError(code, status, message);
    };
    if (stored.size !== attachment.size) return reject('FILE_SIZE_MISMATCH', 422, 'Розмір архіву не збігається. Завантажте його ще раз.');
    const bytes = Buffer.from(await storage.readStart(attachment.pathname, attachment.size));
    if (bytes.length !== attachment.size) throw new AppError('FILE_STORAGE_FAILED', 502, 'Не вдалося прочитати архів. Спробуйте ще раз.');
    let extracted: ReturnType<typeof extractArchiveText>;
    try { extracted = extractArchiveText(bytes); }
    catch (error) {
      return reject('AI_ATTACHMENT_INVALID', 415, error instanceof ZipFormatError ? `Архів не відкрився: ${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}.` : 'Архів пошкоджений або це не ZIP.');
    }
    if (!extracted.files.length) return reject('AI_ATTACHMENT_NO_TEXT', 422, 'В архіві немає текстових файлів, які може прочитати ШІ.');
    const rendered = renderAttachment(attachment.name, extracted.files, extracted.skipped);
    await this.ai.store.putAttachmentText(attachmentId, rendered);
    const ready: AiAttachment = {
      ...attachment, status: 'ready',
      files: extracted.files.map(file => ({ path: file.path, chars: file.text.length })),
      skipped: extracted.skipped.slice(0, 200),
      estimatedTokens: await countTokens(rendered)
    };
    await this.ai.store.putAttachment(ready);
    return this.attachmentDto(ready);
  }

  async deleteAttachment(studentId: string, attachmentId: string) {
    const attachment = await this.ai.store.getAttachment(studentId, attachmentId);
    if (!attachment) throw new AppError('AI_ATTACHMENT_NOT_FOUND', 404, 'Архів не знайдено');
    if (attachment.usedIn) throw new AppError('AI_ATTACHMENT_SENT', 409, 'Архів уже надіслано в чат. Видаліть чат, щоб прибрати його.');
    await this.removeAttachment(studentId, attachmentId);
  }

  // -------------------------------------------------------------------------------------------
  // ZIP from an answer. The link carries a signature instead of a session, so Telegram's own
  // downloader can fetch it; it names one message of one student and expires in minutes.

  async archiveLink(studentId: string, conversationId: string, messageId: string) {
    await this.requireConversation(studentId, conversationId);
    const message = (await this.ai.store.getMessages(conversationId, MESSAGE_CAP)).find(item => item.id === messageId && item.role === 'assistant');
    const files = message ? parseAnswerFiles(message.content) : [];
    if (!files.length) throw new AppError('AI_ARCHIVE_EMPTY', 404, 'У цій відповіді немає файлів для архіву');
    const expiresAt = this.ai.now().getTime() + ARCHIVE_LINK_TTL_MS;
    const payload = Buffer.from(JSON.stringify({ s: studentId, c: conversationId, m: messageId, e: expiresAt })).toString('base64url');
    const token = `${payload}.${this.ai.deps.secrets.sign(payload)}`;
    return { url: `/api/v1/ai/archives?token=${encodeURIComponent(token)}`, fileName: await this.archiveName(studentId, conversationId), fileCount: files.length, expiresAt: new Date(expiresAt).toISOString() };
  }

  private async archiveName(studentId: string, conversationId: string): Promise<string> {
    const conversation = await this.ai.store.getConversation(studentId, conversationId);
    return storageSafeName(`${conversation?.title ?? 'project'}.zip`, 'zip');
  }

  async archiveDownload(token: string): Promise<{ fileName: string; bytes: Buffer }> {
    const [payload, signature] = token.split('.');
    const invalid = () => new AppError('AI_ARCHIVE_LINK_INVALID', 403, 'Посилання на архів недійсне або застаріло. Натисніть «Завантажити ZIP» ще раз.');
    if (!payload || !signature || !this.ai.deps.secrets.verify(payload, signature)) throw invalid();
    let claims: { s?: unknown; c?: unknown; m?: unknown; e?: unknown };
    try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
    if (typeof claims.s !== 'string' || typeof claims.c !== 'string' || typeof claims.m !== 'string' || typeof claims.e !== 'number') throw invalid();
    if (claims.e < this.ai.now().getTime()) throw invalid();
    const conversation = await this.ai.store.getConversation(claims.s, claims.c);
    if (!conversation || conversation.studentId !== claims.s) throw invalid();
    const message = (await this.ai.store.getMessages(claims.c, MESSAGE_CAP)).find(item => item.id === claims.m && item.role === 'assistant');
    const files = message ? parseAnswerFiles(message.content) : [];
    if (!files.length) throw invalid();
    return { fileName: await this.archiveName(claims.s, claims.c), bytes: createZip(files, this.ai.now()) };
  }

  /** Fits the system prompt, as much recent history as the model's input budget allows, and the new message. */
  private async context(systemPrompt: string, history: ChatTurn[], content: string, maxInputTokens: number, withAttachments: boolean): Promise<{ turns: ChatTurn[]; inputTokens: number }> {
    const system: ChatTurn = { role: 'system', content: `${systemPrompt}\n\n${FILE_RULES}` };
    const latest: ChatTurn = { role: 'user', content };
    const fixed = await countChatTokens([system, latest]);
    if (withSafetyMargin(fixed) > maxInputTokens) {
      throw new AppError('AI_MESSAGE_TOO_LONG', 400, withAttachments
        ? `Архів завеликий для цієї моделі: близько ${fixed} токенів при ліміті ${maxInputTokens}. Надішліть менше файлів або попросіть викладача збільшити ліміт контексту моделі.`
        : 'Повідомлення задовге для цієї моделі. Скоротіть його.');
    }
    const kept: ChatTurn[] = [];
    let total = fixed;
    for (const turn of [...history].reverse()) {
      const cost = 4 + await countTokens(turn.content);
      if (withSafetyMargin(total + cost) > maxInputTokens) break;
      kept.unshift(turn);
      total += cost;
    }
    // A history that starts with an assistant turn confuses some providers.
    while (kept[0]?.role === 'assistant') { total -= 4 + await countTokens(kept[0].content); kept.shift(); }
    return { turns: [system, ...kept, latest], inputTokens: total };
  }

  async start(studentId: string, conversationId: string | 'new', input: ChatInput, clientSignal: AbortSignal): Promise<ChatSession> {
    const content = input.content.replace(/\r\n/g, '\n').trim();
    const groupId = await this.studentGroup(studentId);
    const access = await this.ai.accessFor(studentId, groupId);
    const { settings } = access;
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (!content && !attachmentIds.length) throw new AppError('AI_MESSAGE_EMPTY', 400, 'Напишіть повідомлення');
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AppError('AI_ATTACHMENT_LIMIT', 400, `Можна прикріпити до ${MAX_ATTACHMENTS_PER_MESSAGE} архівів до одного повідомлення`);
    if (content.length > settings.maxMessageChars) throw new AppError('AI_MESSAGE_TOO_LONG', 400, `Повідомлення задовге: максимум ${settings.maxMessageChars} символів`);
    if (!access.models.length) throw new AppError('AI_NOT_CONFIGURED', 503, 'ШІ-асистент ще не налаштований. Зверніться до викладача.');

    const existing = conversationId === 'new' ? null : await this.requireConversation(studentId, conversationId);
    if (!existing && (await this.ai.store.listConversations(studentId)).length >= CONVERSATION_LIMIT) {
      throw new AppError('AI_CONVERSATION_LIMIT', 409, 'Забагато чатів. Видаліть старі, щоб створити новий.');
    }
    let model: AiModelRecord | undefined;
    if (input.modelId) {
      model = access.models.find(item => item.id === input.modelId);
      if (!model) throw new AppError('AI_MODEL_FORBIDDEN', 403, 'Ця модель вам недоступна');
    } else {
      model = access.models.find(item => item.id === existing?.modelId) ?? access.defaultModel ?? undefined;
    }
    if (!model) throw new AppError('AI_NOT_CONFIGURED', 503, 'ШІ-асистент ще не налаштований. Зверніться до викладача.');
    const provider = access.providers.find(item => item.id === model.providerId)!;

    const history = existing ? await this.ai.store.getMessages(existing.id, HISTORY_LOAD) : [];
    // Archives from earlier messages go back to the model with them; new ones must be the student's, ready and unsent.
    const texts = await this.ai.store.getAttachmentTexts([...history.flatMap(message => message.attachments?.map(item => item.id) ?? []), ...attachmentIds]);
    const attachments: AiAttachment[] = [];
    for (const id of attachmentIds) {
      const attachment = await this.ai.store.getAttachment(studentId, id);
      if (!attachment || attachment.status !== 'ready' || !texts.has(id)) throw new AppError('AI_ATTACHMENT_NOT_FOUND', 404, 'Архів не знайдено або він ще обробляється');
      if (attachment.usedIn) throw new AppError('AI_ATTACHMENT_SENT', 409, 'Цей архів уже надіслано. Прикріпіть його ще раз.');
      attachments.push(attachment);
    }
    const expand = (text: string, items: AiMessage['attachments']) => items?.length
      ? [text, ...items.map(item => texts.get(item.id) ?? `[Архів «${item.name}» більше недоступний]`)].join('\n\n')
      : text;
    const text = content || 'Переглянь вкладений архів.';
    const messageAttachments = attachments.map(item => ({ id: item.id, name: item.name, size: item.size, fileCount: item.files.length }));
    const historyTurns: ChatTurn[] = history
      .filter(message => message.content.trim() || message.attachments?.length)
      .map(message => ({ role: message.role, content: expand(message.content, message.attachments) }));
    const { turns, inputTokens } = await this.context(settings.systemPrompt, historyTurns, expand(text, messageAttachments), model.maxInputTokens, attachments.length > 0);
    const inputEstimate = withSafetyMargin(inputTokens);
    const now = this.ai.now();
    // The id is derived on the server, so a client cannot collide with another student's request.
    const requestId = createHash('sha256').update(`${studentId}:${input.clientRequestId}`).digest('hex').slice(0, 32);
    const reservation = await this.ai.store.reserve({
      studentId, requestId,
      amount: inputEstimate + model.maxOutputTokens,
      minAmount: inputEstimate + Math.min(MIN_ANSWER_TOKENS, model.maxOutputTokens),
      inputEstimate, expiresAt: now.getTime() + RESERVATION_TTL_MS, now: now.getTime(), period: monthKey(now),
      maxConcurrent: settings.maxConcurrentPerStudent, rateLimit: settings.requestsPerMinute, rateWindow: Math.floor(now.getTime() / 60_000),
      renewalLedger: this.ai.ledgerDraft(studentId, 'monthly_renewal', null, `Місячний ліміт на ${monthKey(now)}`),
      expiryLedger: { at: now.toISOString(), studentId, type: 'expired_reservation', actorId: null, note: 'Запит не завершився: списано оцінку вхідних токенів' }
    });
    switch (reservation.status) {
      case 'ok': break;
      case 'blocked': throw new AppError('AI_ACCESS_BLOCKED', 403, 'Доступ до ШІ тимчасово призупинено. Зверніться до викладача.');
      case 'duplicate': throw new AppError('AI_DUPLICATE_REQUEST', 409, 'Це повідомлення вже надіслано.');
      case 'busy': throw new AppError('AI_BUSY', 429, 'Дочекайтеся завершення попередньої відповіді.');
      case 'rate_limited': throw new AppError('AI_RATE_LIMITED', 429, 'Забагато запитів. Спробуйте за хвилину.');
      case 'insufficient':
        if (reservation.available <= 0) throw new AppError('AI_LIMIT_EXHAUSTED', 402, 'Ваш ліміт ШІ-токенів вичерпано. Зверніться до викладача.');
        throw new AppError('AI_LIMIT_TOO_LOW', 402, `Залишку токенів (${reservation.available}) не вистачає на це повідомлення. Скоротіть його або почніть новий чат.`);
    }

    const conversationIdFinal = existing?.id ?? randomUUID();
    const userMessage: AiMessage = { id: randomUUID(), role: 'user', content: text, createdAt: now.toISOString(), ...(messageAttachments.length ? { attachments: messageAttachments } : {}) };
    const assistantId = randomUUID();
    const encoder = new TextEncoder();
    const upstream = new AbortController();
    const onClientAbort = () => upstream.abort(new DOMException('client stopped', 'AbortError'));
    if (clientSignal.aborted) onClientAbort(); else clientSignal.addEventListener('abort', onClientAbort, { once: true });
    let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
    let open = true;
    const write = (chunk: string) => {
      if (!open || !sink) return;
      try { sink.enqueue(encoder.encode(chunk)); } catch { open = false; }
    };
    const event = (name: string, data: unknown) => write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { sink = controller; },
      cancel() { open = false; onClientAbort(); }
    });
    const done = this.run({
      studentId, groupId, conversationId: conversationIdFinal, existing, model, provider, access, turns, inputTokens, inputEstimate,
      reserved: reservation.reserved, requestId, userMessage, assistantId, upstream, event, write, attachments
    }).catch(error => {
      this.ai.log(error, 'AI chat run failed');
      event('error', { code: 'AI_INTERNAL', message: 'Сталася помилка. Спробуйте ще раз.' });
    }).finally(() => {
      clientSignal.removeEventListener('abort', onClientAbort);
      open = false;
      try { sink?.close(); } catch { /* already closed */ }
    });
    return { stream, done };
  }

  private async run(ctx: {
    studentId: string; groupId: string | null; conversationId: string; existing: AiConversation | null;
    model: AiModelRecord; provider: AiProviderRecord; access: Awaited<ReturnType<AiService['accessFor']>>;
    turns: ChatTurn[]; inputTokens: number; inputEstimate: number; reserved: number; requestId: string;
    userMessage: AiMessage; assistantId: string; upstream: AbortController;
    event: (name: string, data: unknown) => void; write: (chunk: string) => void;
    attachments: AiAttachment[];
  }): Promise<void> {
    const started = Date.now();
    ctx.event('start', {
      conversationId: ctx.conversationId, userMessageId: ctx.userMessage.id, assistantMessageId: ctx.assistantId,
      model: { id: ctx.model.id, label: ctx.model.label }
    });
    const heartbeat = setInterval(() => ctx.write(': ping\n\n'), HEARTBEAT_MS);

    // Attempts: every enabled key of the chosen model's provider, then the fallback model once — only
    // while nothing has been streamed yet, and only to a model this student is allowed to use.
    const attempts: Array<{ model: AiModelRecord; provider: AiProviderRecord; keyId: string }> = [];
    for (const key of ctx.provider.keys.filter(item => item.enabled)) attempts.push({ model: ctx.model, provider: ctx.provider, keyId: key.id });
    const fallback = ctx.model.fallbackModelId ? ctx.access.models.find(item => item.id === ctx.model.fallbackModelId) : undefined;
    const fallbackProvider = fallback ? ctx.access.providers.find(item => item.id === fallback.providerId) : undefined;
    if (fallback && fallbackProvider) {
      for (const key of fallbackProvider.keys.filter(item => item.enabled)) attempts.push({ model: fallback, provider: fallbackProvider, keyId: key.id });
    }

    let text = '';
    let usage: ProviderUsage | null = null;
    let status: AiUsageStatus = 'error';
    let failure: AiProviderError | null = null;
    let partialInput: number | null = null;
    let usedModel = ctx.model;
    let usedProvider = ctx.provider;
    let finishReason: string | null = null;
    const answerBudget = Math.max(1, ctx.reserved - ctx.inputEstimate);

    try {
      for (const [index, attempt] of attempts.entries()) {
        usedModel = attempt.model; usedProvider = attempt.provider;
        failure = null;
        try {
          const adapter = this.ai.adapter(this.ai.connection(attempt.provider, attempt.keyId));
          for await (const item of adapter.stream({
            model: attempt.model.apiModelId, messages: ctx.turns,
            maxOutputTokens: Math.max(1, Math.min(attempt.model.maxOutputTokens, answerBudget)), signal: ctx.upstream.signal
          })) {
            if (item.type === 'text') { text += item.text; ctx.event('delta', { text: item.text }); }
            else if (item.type === 'usage') usage = item.usage;
            else finishReason = item.reason;
          }
          status = 'complete';
          break;
        } catch (error) {
          failure = error instanceof AiProviderError ? error : new AiProviderError('network', error instanceof Error ? error.message : 'Невідома помилка');
          partialInput = failure.partialInputTokens;
          if (failure.code === 'aborted') { status = text ? 'stopped' : 'error'; break; }
          await this.ai.recordError({ provider: attempt.provider, model: attempt.model, error: failure, studentId: ctx.studentId });
          const next = attempts[index + 1];
          if (!text && failure.retryable && next) {
            if (next.model.id !== attempt.model.id) ctx.event('model', { id: next.model.id, label: next.model.label, reason: 'fallback' });
            continue;
          }
          status = text ? 'interrupted' : 'error';
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
    }

    // Final accounting. Exact usage when the provider reported it; otherwise an estimate, flagged.
    const providerSentNothing = status === 'error' && !text;
    let measured: ProviderUsage;
    let approximate = false;
    if (usage && status === 'complete') {
      measured = usage;
    } else if (providerSentNothing && failure?.code !== 'aborted' && partialInput === null) {
      // The provider refused before generating: nothing to charge.
      measured = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    } else {
      // Stopped, cut off, or finished without a usage report: the provider did process the prompt.
      approximate = true;
      measured = { inputTokens: partialInput ?? ctx.inputTokens, outputTokens: text ? await countTokens(text) : 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    }
    const actual = measured.inputTokens + measured.outputTokens;
    const now = this.ai.now();
    const settlement = await this.ai.store.settle({
      studentId: ctx.studentId, requestId: ctx.requestId, actual, inputTokens: measured.inputTokens, outputTokens: measured.outputTokens,
      approximate, now: now.getTime(), modelId: usedModel.id,
      ledger: this.ai.ledgerDraft(ctx.studentId, 'charge', null, approximate ? 'Оцінка: провайдер не повідомив точне використання' : null, { requestId: ctx.requestId, modelId: usedModel.id, approximate })
    });
    const charged = settlement.status === 'ok' ? settlement.charged : 0;
    const uncharged = settlement.status === 'ok' ? Math.max(0, actual - charged) : 0;

    let assistantMessage: AiMessage | null = null;
    if (text) {
      const answerFiles = parseAnswerFiles(text);
      assistantMessage = {
        id: ctx.assistantId, role: 'assistant', content: text, createdAt: now.toISOString(), modelId: usedModel.id, modelLabel: usedModel.label,
        usage: { input: measured.inputTokens, output: measured.outputTokens, total: actual, approximate },
        status: status === 'complete' ? 'complete' : status === 'stopped' ? 'stopped' : 'interrupted',
        ...(answerFiles.length ? { archive: { fileCount: answerFiles.length, paths: answerFiles.slice(0, 30).map(file => file.path) } } : {})
      };
      // Re-read: the student may have deleted this chat while the answer was streaming.
      const current = ctx.existing ? await this.ai.store.getConversation(ctx.studentId, ctx.conversationId) : null;
      if (!ctx.existing || current) {
        await this.ai.store.appendMessages(ctx.conversationId, [ctx.userMessage, assistantMessage], MESSAGE_CAP);
        // An archive belongs to the chat it was sent in from now on.
        for (const attachment of ctx.attachments) await this.ai.store.putAttachment({ ...attachment, usedIn: ctx.conversationId });
        const base = current ?? { id: ctx.conversationId, studentId: ctx.studentId, title: titleFrom(ctx.userMessage.content), createdAt: ctx.userMessage.createdAt, messageCount: 0, preview: '', modelId: null, updatedAt: '' };
        await this.ai.store.putConversation({ ...base, modelId: usedModel.id, updatedAt: now.toISOString(), messageCount: Math.min(MESSAGE_CAP, base.messageCount + 2), preview: text.replace(/\s+/g, ' ').slice(0, 140) });
      }
    }

    const cost = costMicros(usedModel, measured);
    const usageRecord = this.ai.usageRecord({
      requestId: ctx.requestId, studentId: ctx.studentId, groupId: ctx.groupId, conversationId: ctx.conversationId,
      providerId: usedProvider.id, modelId: usedModel.id, apiModelId: usedModel.apiModelId,
      inputTokens: measured.inputTokens, outputTokens: measured.outputTokens, reasoningTokens: measured.reasoningTokens, cachedTokens: measured.cachedTokens,
      totalTokens: actual, charged, uncharged, approximate, status, errorCode: failure?.code ?? null,
      costMicros: cost, currency: cost === null ? null : usedModel.pricing.currency, latencyMs: Date.now() - started
    });
    await this.ai.store.recordUsage({
      usage: usageRecord, error: null, day: dayKey(now), hour: hourKey(now),
      increments: this.ai.statsIncrements({ studentId: ctx.studentId, groupId: ctx.groupId, model: usedModel, usage: measured, charged, uncharged, approximate, error: status === 'error' || status === 'interrupted', cost })
    }).catch(error => this.ai.log(error, 'AI usage write failed'));

    const after = (await this.ai.store.getBalances([ctx.studentId])).get(ctx.studentId)!;
    const balance = { available: Math.max(0, after.balance - after.reserved), exhausted: after.balance - after.reserved <= 0 };
    const usageOut = { input: measured.inputTokens, output: measured.outputTokens, total: actual, charged, approximate };
    if (assistantMessage) {
      const interruption = status === 'interrupted' && failure ? studentMessage(failure) : null;
      ctx.event('done', { status, finishReason, conversationId: ctx.conversationId, userMessage: ctx.userMessage, message: assistantMessage, usage: usageOut, balance, ...(interruption ? { error: interruption } : {}) });
    } else if (failure?.code === 'aborted') {
      ctx.event('done', { status: 'stopped', conversationId: ctx.conversationId, userMessage: null, message: null, usage: usageOut, balance });
    } else if (status === 'complete') {
      ctx.event('error', { code: 'AI_EMPTY_ANSWER', message: 'Модель повернула порожню відповідь. Спробуйте переформулювати.', usage: usageOut, balance });
    } else {
      ctx.event('error', { ...studentMessage(failure ?? new AiProviderError('network', '')), usage: usageOut, balance });
    }
  }
}
