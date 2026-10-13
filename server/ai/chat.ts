import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { AiProviderError, type ChatTurn, type ProviderUsage } from './adapters.js';
import { costMicros, type AiService } from './service.js';
import { dayKey, hourKey, monthKey } from './time.js';
import { countChatTokens, countTokens, withSafetyMargin } from './tokenizer.js';
import type { AiConversation, AiMessage, AiModelRecord, AiProviderRecord, AiUsageStatus } from './types.js';

const MESSAGE_CAP = 400;
const HISTORY_LOAD = 80;
const CONVERSATION_LIMIT = 200;
const MIN_ANSWER_TOKENS = 256;
const RESERVATION_TTL_MS = 6 * 60_000;
const HEARTBEAT_MS = 15_000;

export interface ChatInput {
  content: string;
  modelId?: string | undefined;
  clientRequestId: string;
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
      limits: { maxMessageChars: access.settings.maxMessageChars }
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
    return { conversation, messages: await this.ai.store.getMessages(conversationId, MESSAGE_CAP) };
  }

  async renameConversation(studentId: string, conversationId: string, title: string) {
    const conversation = await this.requireConversation(studentId, conversationId);
    const next = { ...conversation, title: title.trim() || conversation.title };
    await this.ai.store.putConversation(next);
    return next;
  }

  async deleteConversation(studentId: string, conversationId: string) {
    await this.requireConversation(studentId, conversationId);
    await this.ai.store.deleteConversation(studentId, conversationId);
  }

  /** Fits the system prompt, as much recent history as the model's input budget allows, and the new message. */
  private async context(systemPrompt: string, history: AiMessage[], content: string, maxInputTokens: number): Promise<{ turns: ChatTurn[]; inputTokens: number }> {
    const system: ChatTurn = { role: 'system', content: systemPrompt };
    const latest: ChatTurn = { role: 'user', content };
    const fixed = await countChatTokens([system, latest]);
    if (withSafetyMargin(fixed) > maxInputTokens) throw new AppError('AI_MESSAGE_TOO_LONG', 400, 'Повідомлення задовге для цієї моделі. Скоротіть його.');
    const kept: ChatTurn[] = [];
    let total = fixed;
    for (const message of [...history].reverse()) {
      if (!message.content.trim()) continue;
      const cost = 4 + await countTokens(message.content);
      if (withSafetyMargin(total + cost) > maxInputTokens) break;
      kept.unshift({ role: message.role, content: message.content });
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
    if (!content) throw new AppError('AI_MESSAGE_EMPTY', 400, 'Напишіть повідомлення');
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
    const { turns, inputTokens } = await this.context(settings.systemPrompt, history, content, model.maxInputTokens);
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
    const userMessage: AiMessage = { id: randomUUID(), role: 'user', content, createdAt: now.toISOString() };
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
      reserved: reservation.reserved, requestId, userMessage, assistantId, upstream, event, write
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
      assistantMessage = {
        id: ctx.assistantId, role: 'assistant', content: text, createdAt: now.toISOString(), modelId: usedModel.id, modelLabel: usedModel.label,
        usage: { input: measured.inputTokens, output: measured.outputTokens, total: actual, approximate },
        status: status === 'complete' ? 'complete' : status === 'stopped' ? 'stopped' : 'interrupted'
      };
      // Re-read: the student may have deleted this chat while the answer was streaming.
      const current = ctx.existing ? await this.ai.store.getConversation(ctx.studentId, ctx.conversationId) : null;
      if (!ctx.existing || current) {
        await this.ai.store.appendMessages(ctx.conversationId, [ctx.userMessage, assistantMessage], MESSAGE_CAP);
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
