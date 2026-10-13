import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import type { FileStorage } from '../storage/file-storage.js';
import { AiProviderError, createAdapter, safeProviderMessage, type ProviderAdapter, type ProviderConnection, type ProviderUsage } from './adapters.js';
import { SecretBox, secretHint } from './secret-box.js';
import { MAX_BALANCE, type AiStore, type LedgerDraft, type StatsIncrement } from './store.js';
import { daysSince, dayKey, hourKey, monthKey, recentDays, recentHours } from './time.js';
import { countChatTokens, countTokens } from './tokenizer.js';
import type {
  AiAccessRule, AiBalance, AiBalanceSource, AiErrorRecord, AiLedgerType, AiModelFamily, AiModelPricing, AiModelRecord,
  AiProtocol, AiProviderRecord, AiResourcePackage, AiResourceUnit, AiSettings, AiUsageRecord
} from './types.js';

export interface AiRosterStudent { id: string; name: string; groupId: string | null; groupName: string | null; status: string }
export interface AiRoster { students: AiRosterStudent[]; groups: Array<{ id: string; name: string; status: string }> }

export interface AiServiceDeps {
  store: AiStore;
  secrets: SecretBox;
  roster: () => Promise<AiRoster>;
  now?: () => Date;
  adapterFactory?: (connection: ProviderConnection) => ProviderAdapter;
  /** Local development and tests may point providers at http://localhost mocks. */
  allowLocalProviderUrls?: boolean;
  log?: (error: unknown, message: string) => void;
  /** Private object storage for ZIP attachments; without it attachments are reported as unavailable. */
  fileStorage?: FileStorage | null;
  /** First pathname segment, so environments sharing one store never mix objects. */
  storagePrefix?: string;
}

export const DEFAULT_SYSTEM_PROMPT = [
  'Ти — ШІ-асистент школи AI Startup School. Твої співрозмовники — учні-підлітки.',
  'Відповідай мовою учня, ясно й по суті; для структури та коду використовуй Markdown.',
  'Допомагай розібратися й навчитися: пояснюй хід думок, став навідні питання, перевіряй розуміння.',
  'Не виконуй домашні завдання повністю замість учня — показуй підхід і допомагай зробити самостійно.',
  'Не проси і не запамʼятовуй персональні дані. На небезпечні чи недоречні для підлітка запити ввічливо відмовляй.'
].join('\n');

export const DEFAULT_SETTINGS: AiSettings = {
  defaultModelId: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxMessageChars: 8000,
  requestsPerMinute: 20,
  maxConcurrentPerStudent: 2,
  lowBalanceTokens: 20_000,
  resourceWarningPercent: 15
};

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie', 'te', 'upgrade', 'keep-alive', 'proxy-authorization', 'content-type', 'accept']);

export function validateProviderBaseUrl(raw: string, allowLocal: boolean): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AppError('AI_BASE_URL_INVALID', 400, 'Вкажіть повну адресу API, наприклад https://api.example.com/v1'); }
  if (url.username || url.password || url.search || url.hash) throw new AppError('AI_BASE_URL_INVALID', 400, 'Адреса API не повинна містити логін, пароль, параметри чи #');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLocal && local)) {
    throw new AppError('AI_BASE_URL_INSECURE', 400, 'Потрібна HTTPS-адреса API');
  }
  const privateHost = local || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || host === '0.0.0.0'
    || /^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host);
  if (privateHost && !allowLocal) throw new AppError('AI_BASE_URL_PRIVATE', 400, 'Внутрішні мережеві адреси заборонені');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function validateHeaders(headers: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  const seen = new Set<string>();
  return headers.map(({ name, value }) => {
    const clean = name.trim();
    const lower = clean.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(clean) || FORBIDDEN_HEADERS.has(lower)) throw new AppError('AI_HEADER_INVALID', 400, `Заголовок «${clean.slice(0, 40)}» не можна використати`);
    if (seen.has(lower)) throw new AppError('AI_HEADER_INVALID', 400, `Заголовок «${clean}» вказано двічі`);
    if (/[\r\n]/.test(value) || value.length > 2000) throw new AppError('AI_HEADER_INVALID', 400, `Некоректне значення заголовка «${clean}»`);
    seen.add(lower);
    return { name: clean, value };
  });
}

export function providerDto(provider: AiProviderRecord) {
  return {
    id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, enabled: provider.enabled,
    balanceSource: provider.balanceSource, lastCheck: provider.lastCheck, syncedBalance: provider.syncedBalance,
    createdAt: provider.createdAt, updatedAt: provider.updatedAt,
    keys: provider.keys.map(({ secret: _secret, ...key }) => key),
    headers: provider.headers.map(({ secret: _secret, ...header }) => header)
  };
}

export function costMicros(model: AiModelRecord, usage: { inputTokens: number; outputTokens: number; cachedTokens: number }): number | null {
  const { inputPer1M, outputPer1M, cachedInputPer1M } = model.pricing;
  if (inputPer1M === null || outputPer1M === null) return null;
  const cached = Math.min(usage.cachedTokens, usage.inputTokens);
  const cachedPrice = cachedInputPer1M ?? inputPer1M;
  // price per 1M tokens × tokens / 1M = currency units; × 1M again for integer micro-units
  return Math.round((usage.inputTokens - cached) * inputPer1M + cached * cachedPrice + usage.outputTokens * outputPer1M);
}

export interface ResolvedAccess {
  models: AiModelRecord[];
  defaultModel: AiModelRecord | null;
}

export class AiService {
  private rosterCache: { at: number; value: Promise<AiRoster> } | null = null;

  constructor(readonly deps: AiServiceDeps) {}

  get store(): AiStore { return this.deps.store; }

  now(): Date { return this.deps.now?.() ?? new Date(); }

  log(error: unknown, message: string): void { this.deps.log?.(error, message); }

  async roster(fresh = false): Promise<AiRoster> {
    const now = Date.now();
    if (fresh || !this.rosterCache || now - this.rosterCache.at > 20_000) {
      const value = this.deps.roster();
      this.rosterCache = { at: now, value };
      value.catch(() => { if (this.rosterCache?.value === value) this.rosterCache = null; });
    }
    return this.rosterCache.value;
  }

  async settings(): Promise<AiSettings> {
    return { ...DEFAULT_SETTINGS, ...(await this.store.getSettings() ?? {}) };
  }

  adapter(connection: ProviderConnection): ProviderAdapter {
    return (this.deps.adapterFactory ?? createAdapter)(connection);
  }

  /** Decrypted connection for one key of a provider. Never leaves the server. */
  connection(provider: AiProviderRecord, keyId: string): ProviderConnection {
    const key = provider.keys.find(item => item.id === keyId);
    if (!key) throw new AppError('AI_KEY_NOT_FOUND', 404, 'Ключ не знайдено');
    return {
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: this.deps.secrets.open(key.secret),
      headers: Object.fromEntries(provider.headers.map(header => [header.name, this.deps.secrets.open(header.secret)]))
    };
  }

  usable(provider: AiProviderRecord | undefined): provider is AiProviderRecord {
    return Boolean(provider?.enabled && provider.keys.some(key => key.enabled));
  }

  /** Models a student may use: enabled, verified, on an enabled provider with a key, and allowed by the student or group rule. */
  resolveAccess(input: { studentId: string; groupId: string | null; models: AiModelRecord[]; providers: AiProviderRecord[]; rules: AiAccessRule[]; settings: AiSettings }): ResolvedAccess {
    const providers = new Map(input.providers.map(provider => [provider.id, provider]));
    const usable = input.models
      .filter(model => model.enabled && model.verifiedAt && this.usable(providers.get(model.providerId)))
      .sort((left, right) => left.label.localeCompare(right.label, 'uk'));
    const studentRule = input.rules.find(rule => rule.scope === 'student' && rule.targetId === input.studentId);
    const groupRule = input.groupId ? input.rules.find(rule => rule.scope === 'group' && rule.targetId === input.groupId) : undefined;
    const allowedIds = studentRule?.modelIds ?? groupRule?.modelIds ?? null;
    const models = allowedIds ? usable.filter(model => allowedIds.includes(model.id)) : usable;
    const defaultModel = [studentRule?.defaultModelId, groupRule?.defaultModelId, input.settings.defaultModelId]
      .map(id => models.find(model => model.id === id))
      .find(Boolean) ?? models[0] ?? null;
    return { models, defaultModel };
  }

  async accessFor(studentId: string, groupId: string | null): Promise<ResolvedAccess & { settings: AiSettings; providers: AiProviderRecord[]; allModels: AiModelRecord[] }> {
    const [models, providers, rules, settings] = await Promise.all([this.store.listModels(), this.store.listProviders(), this.store.listAccessRules(), this.settings()]);
    return { ...this.resolveAccess({ studentId, groupId, models, providers, rules, settings }), settings, providers, allModels: models };
  }

  ledgerDraft(studentId: string, type: AiLedgerType, actorId: string | null, note: string | null, extra: Partial<LedgerDraft> = {}): LedgerDraft {
    return { id: randomUUID(), at: this.now().toISOString(), studentId, type, actorId, note, ...extra };
  }

  async renewIfDue(balance: AiBalance): Promise<boolean> {
    const period = monthKey(this.now());
    if (balance.monthlyLimit <= 0 || balance.period === period) return false;
    return this.store.renewMonthly(balance.studentId, period, this.ledgerDraft(balance.studentId, 'monthly_renewal', null, `Місячний ліміт на ${period}`));
  }

  /** Stats counters for one finished request. Cross fields let the admin filter one dimension by another. */
  statsIncrements(input: { studentId: string | null; groupId: string | null; model: AiModelRecord; usage: ProviderUsage; charged: number; uncharged: number; approximate: boolean; error: boolean; cost: number | null; test?: boolean }): StatsIncrement[] {
    const total = input.usage.inputTokens + input.usage.outputTokens;
    const m = input.model.id, p = input.model.providerId;
    const items: StatsIncrement[] = [
      { field: 't', by: total }, { field: 'in', by: input.usage.inputTokens }, { field: 'out', by: input.usage.outputTokens },
      { field: 'rs', by: input.usage.reasoningTokens }, { field: 'ca', by: input.usage.cachedTokens },
      { field: 'req', by: 1 }, { field: 'err', by: input.error ? 1 : 0 },
      { field: 'ap', by: input.approximate ? total : 0 }, { field: 'ch', by: input.charged }, { field: 'unc', by: input.uncharged },
      { field: `m:${m}:t`, by: total }, { field: `m:${m}:req`, by: 1 }, { field: `m:${m}:err`, by: input.error ? 1 : 0 },
      { field: `p:${p}:t`, by: total }, { field: `p:${p}:req`, by: 1 }
    ];
    if (input.test) items.push({ field: 'test:t', by: total });
    const currency = input.model.pricing.currency;
    if (input.cost !== null) {
      items.push({ field: `c:${currency}`, by: input.cost }, { field: `m:${m}:c`, by: input.cost }, { field: `p:${p}:c:${currency}`, by: input.cost });
    } else if (total > 0) {
      items.push({ field: `p:${p}:unpriced`, by: total });
    }
    if (input.studentId) {
      const s = input.studentId;
      items.push({ field: `s:${s}:t`, by: total }, { field: `s:${s}:req`, by: 1 }, { field: `sm:${s}:${m}:t`, by: total }, { field: `sm:${s}:${m}:req`, by: 1 });
      if (input.cost !== null) items.push({ field: `s:${s}:c`, by: input.cost });
    }
    if (input.groupId) {
      const g = input.groupId;
      items.push({ field: `g:${g}:t`, by: total }, { field: `g:${g}:req`, by: 1 }, { field: `gm:${g}:${m}:t`, by: total }, { field: `gm:${g}:${m}:req`, by: 1 });
      if (input.cost !== null) items.push({ field: `g:${g}:c`, by: input.cost });
    }
    return items;
  }

  async recordError(input: { provider: AiProviderRecord; model: AiModelRecord | null; error: AiProviderError; studentId: string | null }): Promise<void> {
    const now = this.now();
    const record: AiErrorRecord = {
      id: randomUUID(), at: now.toISOString(), providerId: input.provider.id, modelId: input.model?.id ?? null,
      status: input.error.status, code: input.error.code, message: safeProviderMessage(input.error.message), studentId: input.studentId
    };
    await this.store.recordUsage({ usage: null, error: record, day: dayKey(now), hour: hourKey(now), increments: [] }).catch(error => this.log(error, 'AI error log write failed'));
  }

  // -------------------------------------------------------------------------------------------
  // Providers

  async listProviders() {
    const [providers, errors] = await Promise.all([this.store.listProviders(), this.store.listErrors(50)]);
    return providers
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(provider => ({ ...providerDto(provider), recentErrors: errors.filter(item => item.providerId === provider.id).slice(0, 5) }));
  }

  async requireProvider(id: string): Promise<AiProviderRecord> {
    const provider = (await this.store.listProviders()).find(item => item.id === id);
    if (!provider) throw new AppError('AI_PROVIDER_NOT_FOUND', 404, 'Провайдера не знайдено');
    return provider;
  }

  async createProvider(input: { name: string; protocol: AiProtocol; baseUrl: string; apiKey: string; keyLabel?: string | undefined; headers: Array<{ name: string; value: string }>; balanceSource: AiBalanceSource; enabled: boolean }) {
    const now = this.now().toISOString();
    const baseUrl = validateProviderBaseUrl(input.baseUrl, Boolean(this.deps.allowLocalProviderUrls));
    const headers = validateHeaders(input.headers);
    const provider: AiProviderRecord = {
      id: randomUUID(), name: input.name.trim(), protocol: input.protocol, baseUrl, enabled: input.enabled, balanceSource: input.balanceSource,
      keys: [{ id: randomUUID(), label: input.keyLabel?.trim() || 'Основний ключ', secret: this.deps.secrets.seal(input.apiKey.trim()), hint: secretHint(input.apiKey.trim()), enabled: true, createdAt: now, lastUsedAt: null, lastError: null }],
      headers: headers.map(header => ({ name: header.name, secret: this.deps.secrets.seal(header.value), hint: secretHint(header.value) })),
      lastCheck: null, syncedBalance: null, createdAt: now, updatedAt: now
    };
    await this.store.putProvider(provider);
    return providerDto(provider);
  }

  async updateProvider(id: string, patch: { name?: string | undefined; protocol?: AiProtocol | undefined; baseUrl?: string | undefined; enabled?: boolean | undefined; balanceSource?: AiBalanceSource | undefined; headers?: Array<{ name: string; value: string }> | undefined }) {
    const provider = await this.requireProvider(id);
    const next: AiProviderRecord = { ...provider, updatedAt: this.now().toISOString() };
    if (patch.name !== undefined) next.name = patch.name.trim();
    if (patch.protocol !== undefined) next.protocol = patch.protocol;
    if (patch.baseUrl !== undefined) next.baseUrl = validateProviderBaseUrl(patch.baseUrl, Boolean(this.deps.allowLocalProviderUrls));
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.balanceSource !== undefined) next.balanceSource = patch.balanceSource;
    if (patch.headers !== undefined) {
      // An empty value keeps the stored secret for that header name.
      const existing = new Map(provider.headers.map(header => [header.name.toLowerCase(), header]));
      const headers = patch.headers.filter(header => header.name.trim());
      validateHeaders(headers.map(header => ({ name: header.name, value: header.value || 'kept' })));
      next.headers = headers.map(header => {
        const kept = existing.get(header.name.trim().toLowerCase());
        if (!header.value && kept) return { ...kept, name: header.name.trim() };
        if (!header.value) throw new AppError('AI_HEADER_INVALID', 400, `Вкажіть значення заголовка «${header.name.trim()}»`);
        return { name: header.name.trim(), secret: this.deps.secrets.seal(header.value), hint: secretHint(header.value) };
      });
    }
    const connectionChanged = patch.protocol !== undefined && patch.protocol !== provider.protocol || next.baseUrl !== provider.baseUrl;
    if (connectionChanged) {
      // Models must prove themselves again on the new endpoint before students see them.
      next.lastCheck = null;
      const models = (await this.store.listModels()).filter(model => model.providerId === id);
      await Promise.all(models.map(model => this.store.putModel({ ...model, enabled: false, verifiedAt: null, updatedAt: next.updatedAt })));
    }
    await this.store.putProvider(next);
    return providerDto(next);
  }

  async deleteProvider(id: string) {
    await this.requireProvider(id);
    const models = (await this.store.listModels()).filter(model => model.providerId === id);
    for (const model of models) await this.deleteModel(model.id);
    await this.store.deleteProvider(id);
  }

  async addKey(providerId: string, input: { label?: string | undefined; apiKey: string }) {
    const provider = await this.requireProvider(providerId);
    if (provider.keys.length >= 10) throw new AppError('AI_KEY_LIMIT', 409, 'У провайдера вже 10 ключів');
    const now = this.now().toISOString();
    provider.keys.push({ id: randomUUID(), label: input.label?.trim() || `Ключ ${provider.keys.length + 1}`, secret: this.deps.secrets.seal(input.apiKey.trim()), hint: secretHint(input.apiKey.trim()), enabled: true, createdAt: now, lastUsedAt: null, lastError: null });
    provider.updatedAt = now;
    await this.store.putProvider(provider);
    return providerDto(provider);
  }

  async updateKey(providerId: string, keyId: string, patch: { label?: string | undefined; enabled?: boolean | undefined }) {
    const provider = await this.requireProvider(providerId);
    const key = provider.keys.find(item => item.id === keyId);
    if (!key) throw new AppError('AI_KEY_NOT_FOUND', 404, 'Ключ не знайдено');
    if (patch.label !== undefined) key.label = patch.label.trim() || key.label;
    if (patch.enabled !== undefined) key.enabled = patch.enabled;
    provider.updatedAt = this.now().toISOString();
    await this.store.putProvider(provider);
    return providerDto(provider);
  }

  async deleteKey(providerId: string, keyId: string) {
    const provider = await this.requireProvider(providerId);
    if (!provider.keys.some(item => item.id === keyId)) throw new AppError('AI_KEY_NOT_FOUND', 404, 'Ключ не знайдено');
    provider.keys = provider.keys.filter(item => item.id !== keyId);
    provider.updatedAt = this.now().toISOString();
    await this.store.putProvider(provider);
    return providerDto(provider);
  }

  private firstKey(provider: AiProviderRecord) {
    const key = provider.keys.find(item => item.enabled);
    if (!key) throw new AppError('AI_KEY_REQUIRED', 400, 'Додайте або увімкніть API-ключ провайдера');
    return key;
  }

  async testProvider(id: string) {
    const provider = await this.requireProvider(id);
    const key = this.firstKey(provider);
    const started = Date.now();
    let result: { ok: boolean; message: string; latencyMs: number | null; modelCount: number | null };
    try {
      const models = await this.adapter(this.connection(provider, key.id)).listModels(AbortSignal.timeout(30_000));
      result = { ok: true, message: `Зʼєднання встановлено, ключ прийнято. Моделей у списку: ${models.length}.`, latencyMs: Date.now() - started, modelCount: models.length };
    } catch (error) {
      const failure = error instanceof AiProviderError ? error : new AiProviderError('network', 'Невідома помилка зʼєднання');
      const message = failure.code === 'not_found'
        ? 'Сервер відповів, але не надає список моделей (/models). Додайте модель вручну й перевірте її тестовим запитом.'
        : `${failure.status ? `HTTP ${failure.status}: ` : ''}${failure.message}`;
      result = { ok: false, message, latencyMs: Date.now() - started, modelCount: null };
      await this.recordError({ provider, model: null, error: failure, studentId: null });
    }
    const fresh = await this.requireProvider(id);
    fresh.lastCheck = { ok: result.ok, at: this.now().toISOString(), message: result.message, latencyMs: result.latencyMs };
    await this.store.putProvider(fresh);
    return result;
  }

  async discoverModels(id: string) {
    const provider = await this.requireProvider(id);
    const key = this.firstKey(provider);
    let discovered;
    try {
      discovered = await this.adapter(this.connection(provider, key.id)).listModels(AbortSignal.timeout(30_000));
    } catch (error) {
      const failure = error instanceof AiProviderError ? error : new AiProviderError('network', 'Невідома помилка');
      if (failure.code === 'not_found') throw new AppError('AI_MODELS_NOT_LISTED', 409, 'Провайдер не надає список моделей. Додайте ID моделі вручну.');
      throw new AppError('AI_PROVIDER_ERROR', 502, `Провайдер відповів помилкою: ${failure.status ? `HTTP ${failure.status} · ` : ''}${failure.message}`);
    }
    const existing = new Set((await this.store.listModels()).filter(model => model.providerId === id).map(model => model.apiModelId));
    return discovered.slice(0, 2000).map(model => ({ ...model, added: existing.has(model.id) }));
  }

  async syncBalance(id: string) {
    const provider = await this.requireProvider(id);
    if (provider.balanceSource === 'none') throw new AppError('AI_BALANCE_UNSUPPORTED', 409, 'Для цього провайдера не вибрано метод отримання балансу');
    const key = this.firstKey(provider);
    try {
      const balance = await this.adapter(this.connection(provider, key.id)).balance(provider.balanceSource, AbortSignal.timeout(20_000));
      if (!balance) throw new AiProviderError('invalid_response', 'Провайдер не повернув баланс');
      const fresh = await this.requireProvider(id);
      fresh.syncedBalance = { ...balance, at: this.now().toISOString() };
      await this.store.putProvider(fresh);
      return fresh.syncedBalance;
    } catch (error) {
      const failure = error instanceof AiProviderError ? error : new AiProviderError('network', 'Невідома помилка');
      await this.recordError({ provider, model: null, error: failure, studentId: null });
      throw new AppError('AI_PROVIDER_ERROR', 502, `Не вдалося отримати баланс: ${failure.status ? `HTTP ${failure.status} · ` : ''}${failure.message}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Models

  async requireModel(id: string): Promise<AiModelRecord> {
    const model = (await this.store.listModels()).find(item => item.id === id);
    if (!model) throw new AppError('AI_MODEL_NOT_FOUND', 404, 'Модель не знайдено');
    return model;
  }

  async listModels() {
    return (await this.store.listModels()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createModel(input: { providerId: string; apiModelId: string; label: string; family: AiModelFamily; maxOutputTokens: number; maxInputTokens: number; pricing: AiModelPricing; fallbackModelId: string | null }) {
    await this.requireProvider(input.providerId);
    const models = await this.store.listModels();
    const apiModelId = input.apiModelId.trim();
    if (models.some(model => model.providerId === input.providerId && model.apiModelId === apiModelId)) {
      throw new AppError('AI_MODEL_EXISTS', 409, 'Ця модель уже додана для провайдера');
    }
    if (input.fallbackModelId && !models.some(model => model.id === input.fallbackModelId)) throw new AppError('AI_MODEL_NOT_FOUND', 404, 'Резервну модель не знайдено');
    const now = this.now().toISOString();
    const model: AiModelRecord = {
      id: randomUUID(), providerId: input.providerId, apiModelId, label: input.label.trim() || apiModelId, family: input.family,
      enabled: false, verifiedAt: null, lastTestError: null, maxOutputTokens: input.maxOutputTokens, maxInputTokens: input.maxInputTokens,
      pricing: { ...input.pricing, currency: input.pricing.currency.toUpperCase() }, fallbackModelId: input.fallbackModelId, createdAt: now, updatedAt: now
    };
    await this.store.putModel(model);
    return model;
  }

  async updateModel(id: string, patch: Partial<Pick<AiModelRecord, 'label' | 'family' | 'enabled' | 'maxOutputTokens' | 'maxInputTokens' | 'pricing' | 'fallbackModelId' | 'apiModelId'>>) {
    const model = await this.requireModel(id);
    const next: AiModelRecord = { ...model, updatedAt: this.now().toISOString() };
    if (patch.label !== undefined) next.label = patch.label.trim() || next.apiModelId;
    if (patch.family !== undefined) next.family = patch.family;
    if (patch.maxOutputTokens !== undefined) next.maxOutputTokens = patch.maxOutputTokens;
    if (patch.maxInputTokens !== undefined) next.maxInputTokens = patch.maxInputTokens;
    if (patch.pricing !== undefined) next.pricing = { ...patch.pricing, currency: patch.pricing.currency.toUpperCase() };
    if (patch.fallbackModelId !== undefined) {
      if (patch.fallbackModelId === id) throw new AppError('AI_FALLBACK_INVALID', 400, 'Модель не може бути резервною сама для себе');
      if (patch.fallbackModelId) await this.requireModel(patch.fallbackModelId);
      next.fallbackModelId = patch.fallbackModelId;
    }
    if (patch.apiModelId !== undefined && patch.apiModelId.trim() !== model.apiModelId) {
      next.apiModelId = patch.apiModelId.trim();
      next.verifiedAt = null; next.enabled = false;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    await this.store.putModel(next);
    if (next.enabled && !next.verifiedAt) {
      // A model reaches students only after a real request through the configured API succeeded.
      const test = await this.testModel(id);
      if (!test.ok) {
        await this.store.putModel({ ...(await this.requireModel(id)), enabled: false });
        throw new AppError('AI_MODEL_NOT_VERIFIED', 409, `Модель не відповіла на тестовий запит, тому її не увімкнено: ${test.message}`);
      }
      return this.requireModel(id);
    }
    return next;
  }

  async deleteModel(id: string) {
    await this.requireModel(id);
    await this.store.deleteModel(id);
    const [settings, rules, models] = await Promise.all([this.settings(), this.store.listAccessRules(), this.store.listModels()]);
    if (settings.defaultModelId === id) await this.store.putSettings({ ...settings, defaultModelId: null });
    for (const rule of rules) {
      if (!rule.modelIds?.includes(id) && rule.defaultModelId !== id) continue;
      await this.store.putAccessRule({ ...rule, modelIds: rule.modelIds ? rule.modelIds.filter(item => item !== id) : null, defaultModelId: rule.defaultModelId === id ? null : rule.defaultModelId });
    }
    for (const model of models) if (model.fallbackModelId === id) await this.store.putModel({ ...model, fallbackModelId: null });
  }

  /** Sends a real, tiny request through the configured API. Costs a few provider tokens, never a student's. */
  async testModel(id: string, prompt?: string) {
    const model = await this.requireModel(id);
    const provider = await this.requireProvider(model.providerId);
    const keys = provider.keys.filter(key => key.enabled);
    if (!keys.length) throw new AppError('AI_KEY_REQUIRED', 400, 'Додайте або увімкніть API-ключ провайдера');
    const messages = [{ role: 'user' as const, content: prompt?.trim() || 'Відповідай одним коротким реченням українською: ти на звʼязку?' }];
    const started = Date.now();
    let lastFailure: AiProviderError | null = null;
    for (const key of keys) {
      let text = '';
      let usage: ProviderUsage | null = null;
      try {
        for await (const event of this.adapter(this.connection(provider, key.id)).stream({
          model: model.apiModelId, messages, maxOutputTokens: Math.min(model.maxOutputTokens, prompt ? 512 : 64), signal: AbortSignal.timeout(60_000)
        })) {
          if (event.type === 'text') text += event.text;
          else if (event.type === 'usage') usage = event.usage;
        }
      } catch (error) {
        lastFailure = error instanceof AiProviderError ? error : new AiProviderError('network', 'Невідома помилка');
        await this.recordError({ provider, model, error: lastFailure, studentId: null });
        if (lastFailure.retryable) continue;
        break;
      }
      const approximate = !usage;
      const measured: ProviderUsage = usage ?? { inputTokens: await countChatTokens(messages), outputTokens: await countTokens(text), reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
      const now = this.now();
      const cost = costMicros(model, measured);
      await this.store.recordUsage({ usage: null, error: null, day: dayKey(now), hour: hourKey(now), increments: this.statsIncrements({ studentId: null, groupId: null, model, usage: measured, charged: 0, uncharged: 0, approximate, error: false, cost, test: true }) })
        .catch(error => this.log(error, 'AI test usage write failed'));
      const fresh = await this.requireModel(id);
      await this.store.putModel({ ...fresh, verifiedAt: now.toISOString(), lastTestError: null });
      return {
        ok: true as const, text: text.slice(0, 2000), latencyMs: Date.now() - started, keyLabel: key.label,
        usage: { input: measured.inputTokens, output: measured.outputTokens, reasoning: measured.reasoningTokens, cached: measured.cachedTokens, total: measured.inputTokens + measured.outputTokens, approximate }
      };
    }
    const failure = lastFailure ?? new AiProviderError('network', 'Невідома помилка');
    const message = `${failure.status ? `HTTP ${failure.status} · ` : ''}${failure.message}`;
    const fresh = await this.requireModel(id);
    await this.store.putModel({ ...fresh, lastTestError: message });
    return { ok: false as const, code: failure.code, status: failure.status, message, latencyMs: Date.now() - started };
  }

  // -------------------------------------------------------------------------------------------
  // Settings and access

  async updateSettings(patch: Partial<AiSettings>) {
    const current = await this.settings();
    if (patch.defaultModelId) await this.requireModel(patch.defaultModelId);
    const next = { ...current, ...patch };
    await this.store.putSettings(next);
    return next;
  }

  async setAccessRule(scope: AiAccessRule['scope'], targetId: string, input: { modelIds: string[] | null; defaultModelId: string | null }) {
    const roster = await this.roster(true);
    const exists = scope === 'student' ? roster.students.some(student => student.id === targetId) : roster.groups.some(group => group.id === targetId);
    if (!exists) throw new AppError(scope === 'student' ? 'STUDENT_NOT_FOUND' : 'GROUP_NOT_FOUND', 404, scope === 'student' ? 'Учня не знайдено' : 'Групу не знайдено');
    const models = new Set((await this.store.listModels()).map(model => model.id));
    const modelIds = input.modelIds ? [...new Set(input.modelIds)] : null;
    if (modelIds?.some(id => !models.has(id)) || (input.defaultModelId && !models.has(input.defaultModelId))) throw new AppError('AI_MODEL_NOT_FOUND', 404, 'Модель не знайдено');
    if (input.defaultModelId && modelIds && !modelIds.includes(input.defaultModelId)) throw new AppError('AI_DEFAULT_NOT_ALLOWED', 400, 'Модель за замовчуванням має бути серед дозволених');
    const rule: AiAccessRule = { scope, targetId, modelIds, defaultModelId: input.defaultModelId, updatedAt: this.now().toISOString() };
    await this.store.putAccessRule(rule);
    return rule;
  }

  async deleteAccessRule(scope: AiAccessRule['scope'], targetId: string) {
    await this.store.deleteAccessRule(scope, targetId);
  }

  // -------------------------------------------------------------------------------------------
  // Tokens and limits

  async requireStudent(studentId: string): Promise<AiRosterStudent> {
    const student = (await this.roster(true)).students.find(item => item.id === studentId);
    if (!student) throw new AppError('STUDENT_NOT_FOUND', 404, 'Учня не знайдено');
    return student;
  }

  async tokens() {
    const roster = await this.roster(true);
    const ids = roster.students.map(student => student.id);
    let balances = await this.store.getBalances(ids);
    const renewed = await Promise.all([...balances.values()].map(balance => this.renewIfDue(balance)));
    if (renewed.some(Boolean)) balances = await this.store.getBalances(ids);
    const [models, providers, rules, settings] = await Promise.all([this.store.listModels(), this.store.listProviders(), this.store.listAccessRules(), this.settings()]);
    const labels = new Map(models.map(model => [model.id, model.label]));
    const students = roster.students.map(student => {
      const balance = balances.get(student.id)!;
      const access = this.resolveAccess({ studentId: student.id, groupId: student.groupId, models, providers, rules, settings });
      const rule = rules.find(item => item.scope === 'student' && item.targetId === student.id) ?? null;
      return {
        studentId: student.id, name: student.name, groupId: student.groupId, groupName: student.groupName, status: student.status,
        balance: balance.balance, reserved: balance.reserved, available: Math.max(0, balance.balance - balance.reserved),
        used: balance.used, approxUsed: balance.approxUsed, allocated: balance.used + balance.balance, requests: balance.requests,
        inputUsed: balance.inputUsed, outputUsed: balance.outputUsed,
        blocked: balance.blocked, monthlyLimit: balance.monthlyLimit, lastActivityAt: balance.lastActivityAt,
        lastModel: balance.lastModelId ? labels.get(balance.lastModelId) ?? 'Видалена модель' : null,
        models: access.models.map(model => ({ id: model.id, label: model.label })), defaultModelId: access.defaultModel?.id ?? null,
        rule
      };
    });
    const totals = students.reduce((sum, row) => ({ balance: sum.balance + row.balance, used: sum.used + row.used, reserved: sum.reserved + row.reserved, requests: sum.requests + row.requests }), { balance: 0, used: 0, reserved: 0, requests: 0 });
    return {
      students,
      groups: roster.groups.map(group => ({ ...group, rule: rules.find(item => item.scope === 'group' && item.targetId === group.id) ?? null, studentCount: roster.students.filter(student => student.groupId === group.id).length })),
      models: models.map(model => ({ id: model.id, label: model.label, enabled: model.enabled, verified: Boolean(model.verifiedAt), providerId: model.providerId })),
      settings,
      totals
    };
  }

  async adjustStudent(actorId: string, studentId: string, operation: { op: 'add' | 'set' | 'reset'; amount?: number | undefined; note?: string | undefined }, batchId?: string) {
    await this.requireStudent(studentId);
    const amount = Math.floor(operation.amount ?? 0);
    if (operation.op !== 'reset' && (!Number.isFinite(amount) || amount < 0 || amount > MAX_BALANCE)) throw new AppError('AI_AMOUNT_INVALID', 400, 'Некоректна кількість токенів');
    if (operation.op === 'add' && amount < 1) throw new AppError('AI_AMOUNT_INVALID', 400, 'Вкажіть кількість токенів більше нуля');
    const type: AiLedgerType = operation.op === 'add' ? 'grant' : operation.op;
    const draft = this.ledgerDraft(studentId, type, actorId, operation.note?.trim() || null, batchId ? { batchId } : {});
    const op = operation.op === 'reset' ? { kind: 'reset' as const } : { kind: operation.op, amount };
    return this.store.adjust(studentId, op, draft);
  }

  async adjustGroup(actorId: string, groupId: string, operation: { op: 'add' | 'set'; amount: number; note?: string | undefined }) {
    const roster = await this.roster(true);
    if (!roster.groups.some(group => group.id === groupId)) throw new AppError('GROUP_NOT_FOUND', 404, 'Групу не знайдено');
    const students = roster.students.filter(student => student.groupId === groupId && student.status === 'active');
    if (!students.length) throw new AppError('GROUP_EMPTY', 409, 'У групі немає активних учнів');
    const batchId = randomUUID();
    const results: Array<{ studentId: string; before: number; after: number }> = [];
    for (const student of students) {
      results.push({ studentId: student.id, ...await this.adjustStudent(actorId, student.id, operation, batchId) });
    }
    return { batchId, count: results.length, delta: results.reduce((sum, item) => sum + item.after - item.before, 0), results };
  }

  async setBlocked(actorId: string, studentId: string, blocked: boolean, note?: string) {
    await this.requireStudent(studentId);
    await this.store.setBlocked(studentId, blocked, this.ledgerDraft(studentId, blocked ? 'block' : 'unblock', actorId, note?.trim() || null));
  }

  async setMonthly(actorId: string, studentId: string, limit: number, note?: string) {
    await this.requireStudent(studentId);
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_BALANCE) throw new AppError('AI_AMOUNT_INVALID', 400, 'Некоректний місячний ліміт');
    const period = monthKey(this.now());
    return this.store.setMonthly(studentId, limit, period, this.ledgerDraft(studentId, limit > 0 ? 'monthly_on' : 'monthly_off', actorId, note?.trim() || (limit > 0 ? `Щомісячно ${limit} токенів` : null)));
  }

  async ledger(studentId: string | null, limit: number) {
    const [entries, roster, models] = await Promise.all([this.store.listLedger(studentId, limit), this.roster(), this.store.listModels()]);
    const names = new Map(roster.students.map(student => [student.id, student.name]));
    const labels = new Map(models.map(model => [model.id, model.label]));
    return entries.map(entry => ({ ...entry, studentName: names.get(entry.studentId) ?? 'Учень', modelLabel: entry.modelId ? labels.get(entry.modelId) ?? null : null }));
  }

  // -------------------------------------------------------------------------------------------
  // Purchased provider resources

  async createPackage(input: Omit<AiResourcePackage, 'id' | 'createdAt' | 'updatedAt' | 'manualRemainingAt'>) {
    await this.requireProvider(input.providerId);
    const now = this.now().toISOString();
    const item: AiResourcePackage = { ...input, currency: input.currency.toUpperCase(), costCurrency: input.costCurrency.toUpperCase(), id: randomUUID(), manualRemainingAt: input.manualRemaining !== null ? now : null, createdAt: now, updatedAt: now };
    await this.store.putPackage(item);
    return item;
  }

  async updatePackage(id: string, patch: Partial<Omit<AiResourcePackage, 'id' | 'createdAt' | 'updatedAt' | 'manualRemainingAt'>>) {
    const item = (await this.store.listPackages()).find(entry => entry.id === id);
    if (!item) throw new AppError('AI_PACKAGE_NOT_FOUND', 404, 'Пакет не знайдено');
    if (patch.providerId) await this.requireProvider(patch.providerId);
    const now = this.now().toISOString();
    const next: AiResourcePackage = { ...item, ...patch, updatedAt: now };
    if (patch.currency) next.currency = patch.currency.toUpperCase();
    if (patch.costCurrency) next.costCurrency = patch.costCurrency.toUpperCase();
    if (patch.manualRemaining !== undefined && patch.manualRemaining !== item.manualRemaining) next.manualRemainingAt = patch.manualRemaining === null ? null : now;
    await this.store.putPackage(next);
    return next;
  }

  async deletePackage(id: string) {
    await this.store.deletePackage(id);
  }

  async resources() {
    const now = this.now();
    const [packages, providers, models, settings, roster] = await Promise.all([this.store.listPackages(), this.store.listProviders(), this.store.listModels(), this.settings(), this.roster()]);
    const balances = await this.store.getBalances(roster.students.map(student => student.id));
    const allocated = [...balances.values()].reduce((sum, balance) => sum + balance.balance, 0);
    const reserved = [...balances.values()].reduce((sum, balance) => sum + balance.reserved, 0);
    const providerNames = new Map(providers.map(provider => [provider.id, provider.name]));
    const rows = [];
    for (const item of packages.sort((left, right) => right.purchasedAt.localeCompare(left.purchasedAt))) {
      const days = daysSince(new Date(item.purchasedAt), now);
      const p = item.providerId;
      const sums = await this.store.sumDayFields(days, [`p:${p}:t`, `p:${p}:c:${item.currency}`, `p:${p}:unpriced`]);
      const usedTokens = sums[`p:${p}:t`] ?? 0;
      const unpricedTokens = sums[`p:${p}:unpriced`] ?? 0;
      const usedMoney = (sums[`p:${p}:c:${item.currency}`] ?? 0) / 1_000_000;
      const expired = Boolean(item.expiresAt && Date.parse(item.expiresAt) < now.getTime());
      let used: number | null;
      let usedBasis: 'tokens' | 'cost' | 'unknown';
      if (item.unit === 'tokens') { used = usedTokens; usedBasis = 'tokens'; }
      else if (unpricedTokens > 0 && usedMoney === 0) { used = null; usedBasis = 'unknown'; }
      else { used = Math.round(usedMoney * 100) / 100; usedBasis = 'cost'; }
      const estimatedRemaining = used === null ? null : Math.max(0, item.purchasedAmount - used);
      const provider = providers.find(entry => entry.id === p);
      const synced = provider?.syncedBalance && item.unit !== 'tokens' && provider.syncedBalance.currency.toUpperCase() === item.currency ? provider.syncedBalance : null;
      const share = estimatedRemaining === null || item.purchasedAmount <= 0 ? null : estimatedRemaining / item.purchasedAmount;
      const warnings: string[] = [];
      if (expired) warnings.push('Термін дії пакета минув');
      if (share !== null && share * 100 <= settings.resourceWarningPercent) warnings.push(`Залишилось менше ${settings.resourceWarningPercent}% ресурсу`);
      if (usedBasis === 'unknown' || (item.unit !== 'tokens' && unpricedTokens > 0)) warnings.push('Для частини моделей не задано тарифи — витрати в грошах неповні');
      rows.push({
        ...item, providerName: providerNames.get(p) ?? 'Видалений провайдер',
        usedTokens, used, usedBasis, unpricedTokens, estimatedRemaining, remainingShare: share,
        confirmedRemaining: item.manualRemaining !== null ? { amount: item.manualRemaining, at: item.manualRemainingAt, source: 'manual' as const }
          : synced ? { amount: synced.amount, at: synced.at, source: 'provider' as const } : null,
        expired, warnings
      });
    }
    const tokenPackages = rows.filter(row => row.unit === 'tokens' && !row.expired);
    const purchasedTokens = tokenPackages.reduce((sum, row) => sum + row.purchasedAmount, 0);
    const remainingTokens = tokenPackages.reduce((sum, row) => sum + (row.estimatedRemaining ?? 0), 0);
    const alerts = rows.flatMap(row => row.warnings.map(message => ({ packageId: row.id, packageName: row.name, message })));
    if (tokenPackages.length && allocated > remainingTokens) {
      alerts.unshift({ packageId: '', packageName: 'Усі пакети', message: `Учням виділено ${allocated} токенів, а розрахунковий залишок пакетів у токенах — ${remainingTokens}` });
    }
    return {
      packages: rows,
      providers: providers.map(provider => ({ id: provider.id, name: provider.name, balanceSource: provider.balanceSource, syncedBalance: provider.syncedBalance })),
      summary: { purchasedTokens, remainingTokens, allocatedToStudents: allocated, reservedNow: reserved, unallocatedTokens: tokenPackages.length ? remainingTokens - allocated : null },
      alerts,
      modelsWithoutPricing: models.filter(model => model.pricing.inputPer1M === null || model.pricing.outputPer1M === null).map(model => ({ id: model.id, label: model.label }))
    };
  }

  // -------------------------------------------------------------------------------------------
  // Analytics

  async analytics(input: { range: 'day' | 'week' | 'month'; studentId?: string | undefined; groupId?: string | undefined; modelId?: string | undefined }) {
    const now = this.now();
    const days = input.range === 'day' ? [] : recentDays(now, input.range === 'week' ? 7 : 30);
    const hours = input.range === 'day' ? recentHours(now, 24) : [];
    const stats = await this.store.getStats(days, hours);
    const buckets = input.range === 'day' ? hours.map(key => ({ key, hash: stats.hours[key] ?? {} })) : days.map(key => ({ key, hash: stats.days[key] ?? {} }));
    const { studentId, groupId, modelId } = input;
    const base = studentId && modelId ? `sm:${studentId}:${modelId}` : studentId ? `s:${studentId}` : groupId && modelId ? `gm:${groupId}:${modelId}` : groupId ? `g:${groupId}` : modelId ? `m:${modelId}` : null;
    const tokenField = base ? `${base}:t` : 't';
    const requestField = base ? `${base}:req` : 'req';
    const series = buckets.map(bucket => ({ key: bucket.key, tokens: bucket.hash[tokenField] ?? 0, requests: bucket.hash[requestField] ?? 0, errors: base ? 0 : bucket.hash.err ?? 0 }));

    const total: Record<string, number> = {};
    for (const bucket of buckets) for (const [field, value] of Object.entries(bucket.hash)) total[field] = (total[field] ?? 0) + value;

    const [roster, models, providers, errors] = await Promise.all([this.roster(), this.store.listModels(), this.store.listProviders(), this.store.listErrors(100)]);
    const studentNames = new Map(roster.students.map(student => [student.id, student]));
    const modelLabels = new Map(models.map(model => [model.id, model]));
    const pick = (pattern: RegExp) => Object.entries(total).flatMap(([field, value]) => {
      const match = pattern.exec(field);
      return match?.[1] ? [{ id: match[1], value }] : [];
    });

    // Per-student and per-model breakdowns honour the other filters through the cross counters.
    const byStudentRaw = modelId ? pick(new RegExp(`^sm:([^:]+):${modelId}:t$`)) : pick(/^s:([^:]+):t$/);
    const byStudent = byStudentRaw
      .filter(item => (!groupId || studentNames.get(item.id)?.groupId === groupId) && (!studentId || item.id === studentId))
      .map(item => ({ id: item.id, name: studentNames.get(item.id)?.name ?? 'Учень', groupName: studentNames.get(item.id)?.groupName ?? null, tokens: item.value, requests: total[modelId ? `sm:${item.id}:${modelId}:req` : `s:${item.id}:req`] ?? 0, costMicros: modelId ? null : total[`s:${item.id}:c`] ?? null }))
      .sort((left, right) => right.tokens - left.tokens);
    const byGroup = (modelId ? pick(new RegExp(`^gm:([^:]+):${modelId}:t$`)) : pick(/^g:([^:]+):t$/))
      .filter(item => !groupId || item.id === groupId)
      .map(item => ({ id: item.id, name: roster.groups.find(group => group.id === item.id)?.name ?? 'Група', tokens: item.value, requests: total[modelId ? `gm:${item.id}:${modelId}:req` : `g:${item.id}:req`] ?? 0 }))
      .sort((left, right) => right.tokens - left.tokens);
    const modelSource = studentId ? new RegExp(`^sm:${studentId}:([^:]+):t$`) : groupId ? new RegExp(`^gm:${groupId}:([^:]+):t$`) : /^m:([^:]+):t$/;
    const byModel = pick(modelSource)
      .filter(item => !modelId || item.id === modelId)
      .map(item => {
        const model = modelLabels.get(item.id);
        const requests = total[studentId ? `sm:${studentId}:${item.id}:req` : groupId ? `gm:${groupId}:${item.id}:req` : `m:${item.id}:req`] ?? 0;
        return { id: item.id, label: model?.label ?? 'Видалена модель', family: model?.family ?? 'other', tokens: item.value, requests, errors: studentId || groupId ? null : total[`m:${item.id}:err`] ?? 0, costMicros: studentId || groupId ? null : total[`m:${item.id}:c`] ?? null, currency: model?.pricing.currency ?? null };
      })
      .sort((left, right) => right.tokens - left.tokens);
    const costs = Object.entries(total).filter(([field]) => /^c:[A-Z]{3}$/.test(field)).map(([field, value]) => ({ currency: field.slice(2), amount: value / 1_000_000 }));

    const periodStart = buckets[0]?.key ?? dayKey(now);
    const recentErrors = errors
      .filter(item => (input.range === 'day' ? hourKey(new Date(item.at)) >= periodStart : dayKey(new Date(item.at)) >= periodStart) && (!modelId || item.modelId === modelId) && (!studentId || item.studentId === studentId))
      .slice(0, 50)
      .map(item => ({ ...item, providerName: providers.find(provider => provider.id === item.providerId)?.name ?? 'Провайдер', modelLabel: item.modelId ? modelLabels.get(item.modelId)?.label ?? null : null }));

    const filtered = Boolean(base);
    return {
      range: input.range,
      series,
      totals: filtered
        ? { tokens: series.reduce((sum, item) => sum + item.tokens, 0), requests: series.reduce((sum, item) => sum + item.requests, 0), errors: null, input: null, output: null, reasoning: null, cached: null, approximate: null, charged: null, uncharged: null, adminTests: null }
        : { tokens: total.t ?? 0, requests: total.req ?? 0, errors: total.err ?? 0, input: total.in ?? 0, output: total.out ?? 0, reasoning: total.rs ?? 0, cached: total.ca ?? 0, approximate: total.ap ?? 0, charged: total.ch ?? 0, uncharged: total.unc ?? 0, adminTests: total['test:t'] ?? 0 },
      costs: filtered ? [] : costs,
      byStudent, byGroup, byModel,
      errors: recentErrors,
      filters: {
        students: roster.students.map(student => ({ id: student.id, name: student.name, groupId: student.groupId })),
        groups: roster.groups.map(group => ({ id: group.id, name: group.name })),
        models: models.map(model => ({ id: model.id, label: model.label }))
      }
    };
  }

  /** Builds the usage record the analytics and the admin usage log share. */
  usageRecord(input: Omit<AiUsageRecord, 'id' | 'at'>): AiUsageRecord {
    return { id: randomUUID(), at: this.now().toISOString(), ...input };
  }

  /** Units used by a resource package, for validation. */
  static readonly resourceUnits: AiResourceUnit[] = ['tokens', 'credits', 'money'];
}
