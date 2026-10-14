import type {
  AiAccessRule, AiAttachment, AiBalance, AiConversation, AiGeneratedFile, AiJob, AiErrorRecord, AiLedgerEntry, AiMessage, AiModelRecord, AiPluginRecord,
  AiProviderRecord, AiResourcePackage, AiSettings, AiSkill, AiUsageRecord
} from './types.js';

/**
 * Persistence for the AI assistant. Balances change only through reserve / settle / adjust / flag
 * operations, and each of them is atomic: in Redis a single Lua script, in memory a synchronous
 * block. Parallel requests therefore can never spend more than the balance or push it below zero.
 */

export const MAX_BALANCE = 100_000_000_000;
const DONE_TTL_SECONDS = 86_400;
const STUDENT_LEDGER_CAP = 300;
const GLOBAL_LEDGER_CAP = 5_000;
const USAGE_LOG_CAP = 2_000;
const ERROR_LOG_CAP = 200;
const DAY_STATS_TTL_SECONDS = 400 * 86_400;
const HOUR_STATS_TTL_SECONDS = 3 * 86_400;

export type LedgerDraft = Omit<AiLedgerEntry, 'amount' | 'balanceAfter'>;

export interface ReserveInput {
  studentId: string;
  requestId: string;
  /** Tokens wanted: input estimate plus the output cap. */
  amount: number;
  /** Smallest useful reservation: input estimate plus a minimal answer. */
  minAmount: number;
  inputEstimate: number;
  expiresAt: number;
  now: number;
  period: string;
  maxConcurrent: number;
  rateLimit: number;
  /** Current one-minute window index, used for the per-student rate limit. */
  rateWindow: number;
  renewalLedger: LedgerDraft;
  expiryLedger: Omit<LedgerDraft, 'id' | 'requestId'>;
}

export type ReserveStatus = 'ok' | 'blocked' | 'insufficient' | 'duplicate' | 'busy' | 'rate_limited';

export interface ReserveResult {
  status: ReserveStatus;
  reserved: number;
  balance: number;
  available: number;
  renewed: boolean;
  expired: Array<{ requestId: string; charged: number }>;
}

export interface SettleInput {
  studentId: string;
  requestId: string;
  actual: number;
  inputTokens: number;
  outputTokens: number;
  approximate: boolean;
  now: number;
  modelId: string;
  ledger: LedgerDraft;
}

export interface SettleResult {
  status: 'ok' | 'unknown';
  charged: number;
  balance: number;
}

export type AdjustOperation = { kind: 'add'; amount: number } | { kind: 'set'; amount: number } | { kind: 'reset' };

export interface StatsIncrement { field: string; by: number }

export interface AiStore {
  readonly kind: 'memory' | 'redis';
  // configuration
  listProviders(): Promise<AiProviderRecord[]>;
  putProvider(provider: AiProviderRecord): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  listModels(): Promise<AiModelRecord[]>;
  putModel(model: AiModelRecord): Promise<void>;
  deleteModel(id: string): Promise<void>;
  getSettings(): Promise<Partial<AiSettings> | null>;
  putSettings(settings: AiSettings): Promise<void>;
  listAccessRules(): Promise<AiAccessRule[]>;
  putAccessRule(rule: AiAccessRule): Promise<void>;
  deleteAccessRule(scope: AiAccessRule['scope'], targetId: string): Promise<void>;
  listPackages(): Promise<AiResourcePackage[]>;
  putPackage(item: AiResourcePackage): Promise<void>;
  deletePackage(id: string): Promise<void>;
  // balances
  getBalances(studentIds: string[]): Promise<Map<string, AiBalance>>;
  renewMonthly(studentId: string, period: string, ledger: LedgerDraft): Promise<boolean>;
  reserve(input: ReserveInput): Promise<ReserveResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  adjust(studentId: string, operation: AdjustOperation, ledger: LedgerDraft): Promise<{ before: number; after: number }>;
  setBlocked(studentId: string, blocked: boolean, ledger: LedgerDraft): Promise<void>;
  setMonthly(studentId: string, limit: number, period: string, ledger: LedgerDraft): Promise<{ before: number; after: number }>;
  listLedger(studentId: string | null, limit: number): Promise<AiLedgerEntry[]>;
  // usage
  recordUsage(input: { usage: AiUsageRecord | null; error: AiErrorRecord | null; day: string; hour: string; increments: StatsIncrement[] }): Promise<void>;
  listUsage(limit: number): Promise<AiUsageRecord[]>;
  listErrors(limit: number): Promise<AiErrorRecord[]>;
  getStats(days: string[], hours: string[]): Promise<{ days: Record<string, Record<string, number>>; hours: Record<string, Record<string, number>> }>;
  /** Sum of selected daily counters over the given days. */
  sumDayFields(days: string[], fields: string[]): Promise<Record<string, number>>;
  // conversations
  listConversations(studentId: string): Promise<AiConversation[]>;
  getConversation(studentId: string, conversationId: string): Promise<AiConversation | null>;
  putConversation(conversation: AiConversation): Promise<void>;
  deleteConversation(studentId: string, conversationId: string): Promise<void>;
  getMessages(conversationId: string, limit: number): Promise<AiMessage[]>;
  appendMessages(conversationId: string, messages: AiMessage[], cap: number): Promise<void>;
  // attachments: metadata per student, extracted text in its own key
  listAttachments(studentId: string): Promise<AiAttachment[]>;
  getAttachment(studentId: string, attachmentId: string): Promise<AiAttachment | null>;
  putAttachment(attachment: AiAttachment): Promise<void>;
  deleteAttachment(studentId: string, attachmentId: string): Promise<void>;
  putAttachmentText(attachmentId: string, text: string): Promise<void>;
  getAttachmentTexts(attachmentIds: string[]): Promise<Map<string, string>>;
  // Answer jobs: metadata fields, an append-only text, a request-id index, and an index of jobs that
  // still need attention (running, or finished with the Telegram notice not settled yet).
  createJob(job: AiJob): Promise<{ created: true } | { created: false; existingJobId: string }>;
  jobIdForRequest(requestId: string): Promise<string | null>;
  getJob(jobId: string): Promise<AiJob | null>;
  getJobs(jobIds: string[]): Promise<Map<string, AiJob>>;
  getJobText(jobId: string): Promise<string>;
  /** Appends generated text, records a heartbeat and reports whether a stop was requested. */
  flushJob(jobId: string, chunk: string, now: number): Promise<{ stopRequested: boolean }>;
  /** What the student's app sees: the job, the text after fromByte, and the full byte length. Marks the viewer as present. */
  viewJob(jobId: string, fromByte: number, now: number): Promise<{ job: AiJob; text: string; length: number } | null>;
  requestJobStop(jobId: string): Promise<void>;
  /** Exactly one finisher wins: the generating function, or recovery once the job went quiet. */
  claimJobFinalization(jobId: string, now: number, staleBefore: number | null): Promise<boolean>;
  finishJob(jobId: string, fields: Partial<AiJob>): Promise<void>;
  /** A lease on sending the notice: one sender at a time, a failed send may be retried later. Returns the attempt number, or 0. */
  claimJobNotification(jobId: string, now: number, leaseBefore: number): Promise<number>;
  /** notifyClaimAt "" gives the notice lease back after a failed send. */
  updateJob(jobId: string, fields: Partial<AiJob> & { notifyClaimAt?: string }): Promise<void>;
  /** Takes a job off the attention index. */
  releaseJob(jobId: string): Promise<void>;
  listActiveJobs(): Promise<Array<{ jobId: string; studentId: string }>>;
  // agent configuration: skills and installed plugins
  listSkills(): Promise<AiSkill[]>;
  putSkill(skill: AiSkill): Promise<void>;
  deleteSkill(id: string): Promise<void>;
  listPlugins(): Promise<AiPluginRecord[]>;
  putPlugin(plugin: AiPluginRecord): Promise<void>;
  deletePlugin(id: string): Promise<void>;
  // files the agent made (their source; the file is rebuilt on download)
  putGeneratedFile(file: AiGeneratedFile): Promise<void>;
  getGeneratedFile(id: string): Promise<AiGeneratedFile | null>;
  deleteGeneratedFiles(ids: string[]): Promise<void>;
}

const JOB_TTL_SECONDS = 7 * 86_400;
const JOB_REQUEST_TTL_SECONDS = 86_400;
const JSON_JOB_FIELDS = new Set(['message', 'userMessage', 'steps', 'files', 'pending', 'decision']);

/** Job fields as Redis hash strings, and back. */
export function jobToFields(job: Partial<AiJob>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(job)) {
    if (value === undefined) continue;
    if (key === 'stopRequested') fields[key] = value ? '1' : '0';
    else if (JSON_JOB_FIELDS.has(key)) fields[key] = value === null ? '' : JSON.stringify(value);
    else fields[key] = value === null ? '' : String(value);
  }
  return fields;
}

export function jobFromFields(hash: Record<string, string>): AiJob | null {
  if (!hash.id) return null;
  const num = (key: string) => Number(hash[key] ?? 0) || 0;
  const nullableNum = (key: string) => hash[key] ? Number(hash[key]) : null;
  const text = (key: string) => hash[key] ? hash[key]! : null;
  const json = <T>(key: string): T | null => { if (!hash[key]) return null; try { return JSON.parse(hash[key]!) as T; } catch { return null; } };
  return {
    id: hash.id, studentId: hash.studentId ?? '', conversationId: hash.conversationId ?? '', requestId: hash.requestId ?? '',
    userMessageId: hash.userMessageId ?? '', assistantMessageId: hash.assistantMessageId ?? '', modelId: hash.modelId ?? '', modelLabel: hash.modelLabel ?? '',
    groupId: text('groupId'), status: (hash.status ?? 'error') as AiJob['status'], createdAt: num('createdAt'), heartbeatAt: num('heartbeatAt'),
    viewerAt: num('viewerAt'), finalizingAt: nullableNum('finalizingAt'), finishedAt: nullableNum('finishedAt'), stopRequested: hash.stopRequested === '1',
    inputTokens: num('inputTokens'), errorCode: text('errorCode'), errorMessage: text('errorMessage'), notify: text('notify') as AiJob['notify'],
    notifyAttempts: num('notifyAttempts'), userMessage: json<AiMessage>('userMessage'), message: json<AiMessage>('message'),
    mode: hash.mode === 'agent' ? 'agent' : 'chat', steps: json<AiJob['steps']>('steps') ?? [], files: json<AiJob['files']>('files') ?? [],
    pending: json<AiJob['pending']>('pending'), decision: json<AiJob['decision']>('decision')
  };
}

const SETTLED_NOTICES = new Set(['sent', 'skipped', 'no_channel']);

function emptyBalance(studentId: string): AiBalance {
  return { studentId, balance: 0, reserved: 0, used: 0, approxUsed: 0, inputUsed: 0, outputUsed: 0, requests: 0, blocked: false, monthlyLimit: 0, period: null, lastActivityAt: null, lastModelId: null };
}

function balanceFromHash(studentId: string, hash: Record<string, string>): AiBalance {
  const n = (key: string) => {
    const value = Number(hash[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const lastActivity = n('lastActivity');
  return {
    studentId,
    balance: Math.max(0, n('balance')),
    reserved: Math.max(0, n('reserved')),
    used: n('used'),
    approxUsed: n('approxUsed'),
    inputUsed: n('inputUsed'),
    outputUsed: n('outputUsed'),
    requests: n('requests'),
    blocked: hash.blocked === '1',
    monthlyLimit: n('monthly'),
    period: hash.period || null,
    lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
    lastModelId: hash.lastModel || null
  };
}

function finishLedger(draft: LedgerDraft, amount: number, balanceAfter: number): AiLedgerEntry {
  return { ...draft, amount, balanceAfter };
}

// ---------------------------------------------------------------------------------------------
// In-memory store: tests and local development without Redis. Same semantics as the Lua scripts.

export class MemoryAiStore implements AiStore {
  readonly kind = 'memory' as const;
  private providers = new Map<string, AiProviderRecord>();
  private models = new Map<string, AiModelRecord>();
  private settings: AiSettings | null = null;
  private access = new Map<string, AiAccessRule>();
  private packages = new Map<string, AiResourcePackage>();
  private balances = new Map<string, AiBalance>();
  private reservations = new Map<string, Map<string, { amount: number; inputEstimate: number; expiresAt: number }>>();
  private done = new Set<string>();
  private rate = new Map<string, number>();
  private studentLedger = new Map<string, AiLedgerEntry[]>();
  private globalLedger: AiLedgerEntry[] = [];
  private usage: AiUsageRecord[] = [];
  private errors: AiErrorRecord[] = [];
  private dayStats = new Map<string, Record<string, number>>();
  private hourStats = new Map<string, Record<string, number>>();
  private conversations = new Map<string, Map<string, AiConversation>>();
  private messages = new Map<string, AiMessage[]>();
  private attachments = new Map<string, Map<string, AiAttachment>>();
  private attachmentTexts = new Map<string, string>();
  private jobs = new Map<string, { fields: Record<string, string>; text: string }>();
  private skills = new Map<string, AiSkill>();
  private plugins = new Map<string, AiPluginRecord>();
  private generated = new Map<string, AiGeneratedFile>();
  private jobRequests = new Map<string, string>();
  private activeJobs = new Map<string, string>();

  async listProviders() { return [...this.providers.values()].map(item => structuredClone(item)); }
  async putProvider(provider: AiProviderRecord) { this.providers.set(provider.id, structuredClone(provider)); }
  async deleteProvider(id: string) { this.providers.delete(id); }
  async listModels() { return [...this.models.values()].map(item => structuredClone(item)); }
  async putModel(model: AiModelRecord) { this.models.set(model.id, structuredClone(model)); }
  async deleteModel(id: string) { this.models.delete(id); }
  async getSettings() { return this.settings ? structuredClone(this.settings) : null; }
  async putSettings(settings: AiSettings) { this.settings = structuredClone(settings); }
  async listAccessRules() { return [...this.access.values()].map(item => structuredClone(item)); }
  async putAccessRule(rule: AiAccessRule) { this.access.set(`${rule.scope}:${rule.targetId}`, structuredClone(rule)); }
  async deleteAccessRule(scope: AiAccessRule['scope'], targetId: string) { this.access.delete(`${scope}:${targetId}`); }
  async listPackages() { return [...this.packages.values()].map(item => structuredClone(item)); }
  async putPackage(item: AiResourcePackage) { this.packages.set(item.id, structuredClone(item)); }
  async deletePackage(id: string) { this.packages.delete(id); }

  private balanceOf(studentId: string): AiBalance {
    let balance = this.balances.get(studentId);
    if (!balance) { balance = emptyBalance(studentId); this.balances.set(studentId, balance); }
    return balance;
  }

  private reservationsOf(studentId: string) {
    let map = this.reservations.get(studentId);
    if (!map) { map = new Map(); this.reservations.set(studentId, map); }
    return map;
  }

  private pushLedger(entry: AiLedgerEntry, global: boolean) {
    const list = this.studentLedger.get(entry.studentId) ?? [];
    list.unshift(entry);
    this.studentLedger.set(entry.studentId, list.slice(0, STUDENT_LEDGER_CAP));
    if (global) { this.globalLedger.unshift(entry); this.globalLedger = this.globalLedger.slice(0, GLOBAL_LEDGER_CAP); }
  }

  private renew(studentId: string, period: string, ledger: LedgerDraft): boolean {
    const balance = this.balanceOf(studentId);
    if (balance.monthlyLimit <= 0 || balance.period === period) return false;
    const before = balance.balance;
    balance.balance = balance.monthlyLimit;
    balance.period = period;
    this.pushLedger(finishLedger(ledger, balance.balance - before, balance.balance), true);
    return true;
  }

  async getBalances(studentIds: string[]) {
    return new Map(studentIds.map(id => [id, structuredClone(this.balances.get(id) ?? emptyBalance(id))]));
  }

  async renewMonthly(studentId: string, period: string, ledger: LedgerDraft) {
    return this.renew(studentId, period, ledger);
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const balance = this.balanceOf(input.studentId);
    const held = this.reservationsOf(input.studentId);
    const expired: ReserveResult['expired'] = [];
    for (const [requestId, item] of [...held]) {
      if (item.expiresAt >= input.now) continue;
      const charged = Math.min(item.inputEstimate, Math.max(balance.balance, 0));
      held.delete(requestId);
      balance.reserved = Math.max(0, balance.reserved - item.amount);
      balance.balance -= charged; balance.used += charged; balance.approxUsed += charged;
      this.done.add(requestId);
      this.pushLedger({ ...input.expiryLedger, id: `exp-${requestId}`, requestId, amount: -charged, balanceAfter: balance.balance }, false);
      expired.push({ requestId, charged });
    }
    const renewed = this.renew(input.studentId, input.period, input.renewalLedger);
    const result = (status: ReserveStatus, reserved = 0): ReserveResult =>
      ({ status, reserved, balance: balance.balance, available: Math.max(0, balance.balance - balance.reserved), renewed, expired });
    if (balance.blocked) return result('blocked');
    if (held.has(input.requestId) || this.done.has(input.requestId)) return result('duplicate');
    const rateKey = `${input.studentId}:${input.rateWindow}`;
    const count = (this.rate.get(rateKey) ?? 0) + 1;
    this.rate.set(rateKey, count);
    if (count > input.rateLimit) return result('rate_limited');
    if (held.size >= input.maxConcurrent) return result('busy');
    const available = balance.balance - balance.reserved;
    if (available < input.minAmount) return result('insufficient');
    const grant = Math.min(input.amount, available);
    held.set(input.requestId, { amount: grant, inputEstimate: input.inputEstimate, expiresAt: input.expiresAt });
    balance.reserved += grant;
    return result('ok', grant);
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    const balance = this.balanceOf(input.studentId);
    const held = this.reservationsOf(input.studentId);
    const item = held.get(input.requestId);
    if (!item) return { status: 'unknown', charged: 0, balance: balance.balance };
    held.delete(input.requestId);
    balance.reserved = Math.max(0, balance.reserved - item.amount);
    const charged = Math.min(input.actual, Math.max(balance.balance, 0));
    balance.balance -= charged;
    balance.used += charged;
    balance.inputUsed += input.inputTokens;
    balance.outputUsed += input.outputTokens;
    if (input.approximate) balance.approxUsed += charged;
    balance.requests += 1;
    balance.lastActivityAt = new Date(input.now).toISOString();
    balance.lastModelId = input.modelId;
    this.done.add(input.requestId);
    if (charged > 0) this.pushLedger(finishLedger(input.ledger, -charged, balance.balance), false);
    return { status: 'ok', charged, balance: balance.balance };
  }

  async adjust(studentId: string, operation: AdjustOperation, ledger: LedgerDraft) {
    const balance = this.balanceOf(studentId);
    const before = balance.balance;
    const raw = operation.kind === 'add' ? before + operation.amount : operation.kind === 'set' ? operation.amount : 0;
    balance.balance = Math.min(MAX_BALANCE, Math.max(0, raw));
    this.pushLedger(finishLedger(ledger, balance.balance - before, balance.balance), true);
    return { before, after: balance.balance };
  }

  async setBlocked(studentId: string, blocked: boolean, ledger: LedgerDraft) {
    const balance = this.balanceOf(studentId);
    balance.blocked = blocked;
    this.pushLedger(finishLedger(ledger, 0, balance.balance), true);
  }

  async setMonthly(studentId: string, limit: number, period: string, ledger: LedgerDraft) {
    const balance = this.balanceOf(studentId);
    const before = balance.balance;
    if (limit > 0) { balance.monthlyLimit = limit; balance.period = period; balance.balance = limit; }
    else { balance.monthlyLimit = 0; balance.period = null; }
    this.pushLedger(finishLedger(ledger, balance.balance - before, balance.balance), true);
    return { before, after: balance.balance };
  }

  async listLedger(studentId: string | null, limit: number) {
    const list = studentId ? this.studentLedger.get(studentId) ?? [] : this.globalLedger;
    return structuredClone(list.slice(0, limit));
  }

  async recordUsage(input: { usage: AiUsageRecord | null; error: AiErrorRecord | null; day: string; hour: string; increments: StatsIncrement[] }) {
    if (input.usage) { this.usage.unshift(structuredClone(input.usage)); this.usage = this.usage.slice(0, USAGE_LOG_CAP); }
    if (input.error) { this.errors.unshift(structuredClone(input.error)); this.errors = this.errors.slice(0, ERROR_LOG_CAP); }
    for (const [map, key] of [[this.dayStats, input.day], [this.hourStats, input.hour]] as const) {
      const hash = map.get(key) ?? {};
      for (const { field, by } of input.increments) hash[field] = (hash[field] ?? 0) + by;
      map.set(key, hash);
    }
  }

  async listUsage(limit: number) { return structuredClone(this.usage.slice(0, limit)); }
  async listErrors(limit: number) { return structuredClone(this.errors.slice(0, limit)); }

  async getStats(days: string[], hours: string[]) {
    return {
      days: Object.fromEntries(days.map(day => [day, { ...(this.dayStats.get(day) ?? {}) }])),
      hours: Object.fromEntries(hours.map(hour => [hour, { ...(this.hourStats.get(hour) ?? {}) }]))
    };
  }

  async sumDayFields(days: string[], fields: string[]) {
    const totals: Record<string, number> = Object.fromEntries(fields.map(field => [field, 0]));
    for (const day of days) {
      const hash = this.dayStats.get(day) ?? {};
      for (const field of fields) totals[field] = (totals[field] ?? 0) + (hash[field] ?? 0);
    }
    return totals;
  }

  async listConversations(studentId: string) {
    return [...(this.conversations.get(studentId)?.values() ?? [])].map(item => structuredClone(item));
  }

  async getConversation(studentId: string, conversationId: string) {
    const item = this.conversations.get(studentId)?.get(conversationId);
    return item ? structuredClone(item) : null;
  }

  async putConversation(conversation: AiConversation) {
    const map = this.conversations.get(conversation.studentId) ?? new Map<string, AiConversation>();
    map.set(conversation.id, structuredClone(conversation));
    this.conversations.set(conversation.studentId, map);
  }

  async deleteConversation(studentId: string, conversationId: string) {
    this.conversations.get(studentId)?.delete(conversationId);
    this.messages.delete(conversationId);
  }

  async getMessages(conversationId: string, limit: number) {
    return structuredClone((this.messages.get(conversationId) ?? []).slice(-limit));
  }

  async appendMessages(conversationId: string, messages: AiMessage[], cap: number) {
    const list = [...(this.messages.get(conversationId) ?? []), ...structuredClone(messages)];
    this.messages.set(conversationId, list.slice(-cap));
  }

  async listAttachments(studentId: string) {
    return [...(this.attachments.get(studentId)?.values() ?? [])].map(item => structuredClone(item));
  }

  async getAttachment(studentId: string, attachmentId: string) {
    const item = this.attachments.get(studentId)?.get(attachmentId);
    return item ? structuredClone(item) : null;
  }

  async putAttachment(attachment: AiAttachment) {
    const map = this.attachments.get(attachment.studentId) ?? new Map<string, AiAttachment>();
    map.set(attachment.id, structuredClone(attachment));
    this.attachments.set(attachment.studentId, map);
  }

  async deleteAttachment(studentId: string, attachmentId: string) {
    this.attachments.get(studentId)?.delete(attachmentId);
    this.attachmentTexts.delete(attachmentId);
  }

  async putAttachmentText(attachmentId: string, text: string) { this.attachmentTexts.set(attachmentId, text); }

  async getAttachmentTexts(attachmentIds: string[]) {
    return new Map(attachmentIds.flatMap(id => this.attachmentTexts.has(id) ? [[id, this.attachmentTexts.get(id)!] as const] : []));
  }

  async createJob(job: AiJob) {
    const existing = this.jobRequests.get(job.requestId);
    if (existing) return { created: false as const, existingJobId: existing };
    this.jobRequests.set(job.requestId, job.id);
    this.jobs.set(job.id, { fields: jobToFields(job), text: '' });
    this.activeJobs.set(job.id, job.studentId);
    return { created: true as const };
  }

  async jobIdForRequest(requestId: string) { return this.jobRequests.get(requestId) ?? null; }
  async getJob(jobId: string) { const item = this.jobs.get(jobId); return item ? jobFromFields({ ...item.fields }) : null; }
  async getJobs(jobIds: string[]) {
    const out = new Map<string, AiJob>();
    for (const id of jobIds) { const job = await this.getJob(id); if (job) out.set(id, job); }
    return out;
  }
  async getJobText(jobId: string) { return this.jobs.get(jobId)?.text ?? ''; }

  async flushJob(jobId: string, chunk: string, now: number) {
    const item = this.jobs.get(jobId);
    if (!item) return { stopRequested: false };
    item.text += chunk;
    item.fields.heartbeatAt = String(now);
    return { stopRequested: item.fields.stopRequested === '1' };
  }

  async viewJob(jobId: string, fromByte: number, now: number) {
    const item = this.jobs.get(jobId);
    if (!item) return null;
    item.fields.viewerAt = String(now);
    const bytes = Buffer.from(item.text, 'utf8');
    return { job: jobFromFields({ ...item.fields })!, text: bytes.subarray(Math.max(0, fromByte)).toString('utf8'), length: bytes.length };
  }

  async requestJobStop(jobId: string) { const item = this.jobs.get(jobId); if (item) item.fields.stopRequested = '1'; }

  async claimJobFinalization(jobId: string, now: number, staleBefore: number | null) {
    const item = this.jobs.get(jobId);
    if (!item) return false;
    const { status } = item.fields;
    const quiet = staleBefore === null || Number(item.fields.heartbeatAt) < staleBefore;
    const stuck = staleBefore !== null && status === 'finalizing' && Number(item.fields.finalizingAt) < staleBefore;
    if ((status === 'running' && quiet) || stuck) { item.fields.status = 'finalizing'; item.fields.finalizingAt = String(now); return true; }
    return false;
  }

  async finishJob(jobId: string, fields: Partial<AiJob>) {
    const item = this.jobs.get(jobId);
    if (item) Object.assign(item.fields, jobToFields(fields));
  }

  async claimJobNotification(jobId: string, now: number, leaseBefore: number) {
    const item = this.jobs.get(jobId);
    if (!item || SETTLED_NOTICES.has(item.fields.notify ?? '')) return 0;
    if (item.fields.notifyClaimAt && Number(item.fields.notifyClaimAt) >= leaseBefore) return 0;
    item.fields.notifyClaimAt = String(now);
    item.fields.notifyAttempts = String(Number(item.fields.notifyAttempts ?? 0) + 1);
    return Number(item.fields.notifyAttempts);
  }

  async updateJob(jobId: string, fields: Partial<AiJob> & { notifyClaimAt?: string }) { const item = this.jobs.get(jobId); if (item) Object.assign(item.fields, jobToFields(fields)); }
  async releaseJob(jobId: string) { this.activeJobs.delete(jobId); }
  async listSkills() { return [...this.skills.values()].map(item => structuredClone(item)); }
  async putSkill(skill: AiSkill) { this.skills.set(skill.id, structuredClone(skill)); }
  async deleteSkill(id: string) { this.skills.delete(id); }
  async listPlugins() { return [...this.plugins.values()].map(item => structuredClone(item)); }
  async putPlugin(plugin: AiPluginRecord) { this.plugins.set(plugin.id, structuredClone(plugin)); }
  async deletePlugin(id: string) { this.plugins.delete(id); }
  async putGeneratedFile(file: AiGeneratedFile) { this.generated.set(file.id, structuredClone(file)); }
  async getGeneratedFile(id: string) { const file = this.generated.get(id); return file ? structuredClone(file) : null; }
  async deleteGeneratedFiles(ids: string[]) { for (const id of ids) this.generated.delete(id); }
  async listActiveJobs() { return [...this.activeJobs].map(([jobId, studentId]) => ({ jobId, studentId })); }
}

// ---------------------------------------------------------------------------------------------
// Upstash Redis (REST). Balance changes run as Lua scripts, which Redis executes atomically.

export interface RedisCommandClient {
  command<T>(command: Array<string | number>): Promise<T>;
  pipeline<T>(commands: Array<Array<string | number>>): Promise<T[]>;
}

type RedisReply<T> = { result?: T; error?: string };

export class UpstashRestClient implements RedisCommandClient {
  constructor(private readonly url: string, private readonly token: string) {}

  async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command.map(value => String(value))),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`AI storage request failed (${response.status})`);
    const payload = await response.json() as RedisReply<T>;
    if (payload.error) throw new Error('AI storage command failed');
    return payload.result as T;
  }

  async pipeline<T>(commands: Array<Array<string | number>>): Promise<T[]> {
    if (!commands.length) return [];
    const response = await fetch(`${this.url.replace(/\/+$/, '')}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands.map(command => command.map(value => String(value)))),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`AI storage request failed (${response.status})`);
    const payload = await response.json() as Array<RedisReply<T>>;
    if (!Array.isArray(payload) || payload.some(item => item.error)) throw new Error('AI storage command failed');
    return payload.map(item => item.result as T);
  }
}

// Shared Lua helpers. Values are concatenated into JSON only when they are numbers or ids the server
// generated, so no user text ever passes through Lua string building.
const LUA_HELPERS = `
local function num(value)
  return tonumber(value) or 0
end
local function pushLedger(p, sid, entry, global)
  local key = p .. ':ledger:' .. sid
  redis.call('LPUSH', key, entry)
  redis.call('LTRIM', key, 0, ${STUDENT_LEDGER_CAP - 1})
  if global then
    redis.call('LPUSH', p .. ':ledger', entry)
    redis.call('LTRIM', p .. ':ledger', 0, ${GLOBAL_LEDGER_CAP - 1})
  end
end
local function renew(p, sid, period, prefix)
  local bal = p .. ':bal:' .. sid
  local monthly = num(redis.call('HGET', bal, 'monthly'))
  if monthly <= 0 then return false end
  if redis.call('HGET', bal, 'period') == period then return false end
  local before = num(redis.call('HGET', bal, 'balance'))
  redis.call('HSET', bal, 'balance', monthly, 'period', period)
  pushLedger(p, sid, prefix .. ',"amount":' .. (monthly - before) .. ',"balanceAfter":' .. monthly .. '}', true)
  return true
end
`;

const RESERVE_SCRIPT = `${LUA_HELPERS}
local p, sid, requestId = ARGV[1], ARGV[2], ARGV[3]
local amount, minAmount, inputEstimate = num(ARGV[4]), num(ARGV[5]), num(ARGV[6])
local expiresAt, now, period = num(ARGV[7]), num(ARGV[8]), ARGV[9]
local maxConcurrent, rateLimit, rateWindow = num(ARGV[10]), num(ARGV[11]), ARGV[12]
local renewalPrefix, expiryPrefix = ARGV[13], ARGV[14]
local bal = p .. ':bal:' .. sid
local res = p .. ':res:' .. sid
local expired = {}
local held = redis.call('HGETALL', res)
for i = 1, #held, 2 do
  local amt, est, exp = string.match(held[i + 1], '^(%d+):(%d+):(%d+)$')
  if exp and num(exp) < now then
    local current = num(redis.call('HGET', bal, 'balance'))
    local charge = math.min(num(est), math.max(current, 0))
    redis.call('HDEL', res, held[i])
    redis.call('HINCRBY', bal, 'reserved', -num(amt))
    redis.call('HINCRBY', bal, 'balance', -charge)
    redis.call('HINCRBY', bal, 'used', charge)
    redis.call('HINCRBY', bal, 'approxUsed', charge)
    redis.call('SET', p .. ':done:' .. held[i], '1', 'EX', ${DONE_TTL_SECONDS})
    pushLedger(p, sid, expiryPrefix .. ',"id":"exp-' .. held[i] .. '","requestId":"' .. held[i] .. '","amount":' .. (-charge) .. ',"balanceAfter":' .. (current - charge) .. '}', false)
    table.insert(expired, held[i])
    table.insert(expired, charge)
  end
end
if num(redis.call('HGET', bal, 'reserved')) < 0 then redis.call('HSET', bal, 'reserved', 0) end
local renewed = renew(p, sid, period, renewalPrefix) and 1 or 0
local balance = num(redis.call('HGET', bal, 'balance'))
local reserved = num(redis.call('HGET', bal, 'reserved'))
local function reply(status, grant)
  local out = { status, grant, balance, math.max(balance - reserved, 0), renewed }
  for _, value in ipairs(expired) do table.insert(out, value) end
  return out
end
if redis.call('HGET', bal, 'blocked') == '1' then return reply('blocked', 0) end
if redis.call('HEXISTS', res, requestId) == 1 or redis.call('EXISTS', p .. ':done:' .. requestId) == 1 then return reply('duplicate', 0) end
local rl = p .. ':rl:' .. sid .. ':' .. rateWindow
local count = redis.call('INCR', rl)
if count == 1 then redis.call('EXPIRE', rl, 120) end
if count > rateLimit then return reply('rate_limited', 0) end
if redis.call('HLEN', res) >= maxConcurrent then return reply('busy', 0) end
local available = balance - reserved
if available < minAmount then return reply('insufficient', 0) end
local grant = math.min(amount, available)
redis.call('HSET', res, requestId, grant .. ':' .. inputEstimate .. ':' .. expiresAt)
reserved = redis.call('HINCRBY', bal, 'reserved', grant)
return reply('ok', grant)`;

const SETTLE_SCRIPT = `${LUA_HELPERS}
local p, sid, requestId = ARGV[1], ARGV[2], ARGV[3]
local actual, inputTokens, outputTokens = num(ARGV[4]), num(ARGV[5]), num(ARGV[6])
local approximate, now, modelId, prefix = ARGV[7] == '1', ARGV[8], ARGV[9], ARGV[10]
local bal = p .. ':bal:' .. sid
local res = p .. ':res:' .. sid
local raw = redis.call('HGET', res, requestId)
local balance = num(redis.call('HGET', bal, 'balance'))
if not raw then return { 'unknown', 0, balance } end
local amt = num(string.match(raw, '^(%d+):'))
redis.call('HDEL', res, requestId)
if redis.call('HINCRBY', bal, 'reserved', -amt) < 0 then redis.call('HSET', bal, 'reserved', 0) end
local charge = math.min(actual, math.max(balance, 0))
if charge > 0 then
  redis.call('HINCRBY', bal, 'balance', -charge)
  redis.call('HINCRBY', bal, 'used', charge)
  if approximate then redis.call('HINCRBY', bal, 'approxUsed', charge) end
end
redis.call('HINCRBY', bal, 'inputUsed', inputTokens)
redis.call('HINCRBY', bal, 'outputUsed', outputTokens)
redis.call('HINCRBY', bal, 'requests', 1)
redis.call('HSET', bal, 'lastActivity', now, 'lastModel', modelId)
redis.call('SET', p .. ':done:' .. requestId, '1', 'EX', ${DONE_TTL_SECONDS})
if charge > 0 then
  pushLedger(p, sid, prefix .. ',"amount":' .. (-charge) .. ',"balanceAfter":' .. (balance - charge) .. '}', false)
end
return { 'ok', charge, balance - charge }`;

const ADJUST_SCRIPT = `${LUA_HELPERS}
local p, sid, op, amount, prefix = ARGV[1], ARGV[2], ARGV[3], num(ARGV[4]), ARGV[5]
local bal = p .. ':bal:' .. sid
local before = num(redis.call('HGET', bal, 'balance'))
local after = 0
if op == 'add' then after = before + amount elseif op == 'set' then after = amount end
if after < 0 then after = 0 end
if after > ${MAX_BALANCE} then after = ${MAX_BALANCE} end
redis.call('HSET', bal, 'balance', after)
pushLedger(p, sid, prefix .. ',"amount":' .. (after - before) .. ',"balanceAfter":' .. after .. '}', true)
return { before, after }`;

const BLOCK_SCRIPT = `${LUA_HELPERS}
local p, sid, value, prefix = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local bal = p .. ':bal:' .. sid
redis.call('HSET', bal, 'blocked', value)
pushLedger(p, sid, prefix .. ',"amount":0,"balanceAfter":' .. num(redis.call('HGET', bal, 'balance')) .. '}', true)
return 1`;

const MONTHLY_SCRIPT = `${LUA_HELPERS}
local p, sid, limit, period, prefix = ARGV[1], ARGV[2], num(ARGV[3]), ARGV[4], ARGV[5]
local bal = p .. ':bal:' .. sid
local before = num(redis.call('HGET', bal, 'balance'))
local after = before
if limit > 0 then
  after = limit
  redis.call('HSET', bal, 'monthly', limit, 'period', period, 'balance', limit)
else
  redis.call('HSET', bal, 'monthly', 0)
  redis.call('HDEL', bal, 'period')
end
pushLedger(p, sid, prefix .. ',"amount":' .. (after - before) .. ',"balanceAfter":' .. after .. '}', true)
return { before, after }`;

const RENEW_SCRIPT = `${LUA_HELPERS}
return renew(ARGV[1], ARGV[2], ARGV[3], ARGV[4]) and 1 or 0`;

const RECORD_USAGE_SCRIPT = `
local p = ARGV[1]
local day = p .. ':stats:d:' .. ARGV[2]
local hour = p .. ':stats:h:' .. ARGV[3]
if ARGV[4] ~= '' then
  redis.call('LPUSH', p .. ':usage', ARGV[4])
  redis.call('LTRIM', p .. ':usage', 0, ${USAGE_LOG_CAP - 1})
end
if ARGV[5] ~= '' then
  redis.call('LPUSH', p .. ':errors', ARGV[5])
  redis.call('LTRIM', p .. ':errors', 0, ${ERROR_LOG_CAP - 1})
end
for i = 6, #ARGV, 2 do
  redis.call('HINCRBY', day, ARGV[i], ARGV[i + 1])
  redis.call('HINCRBY', hour, ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', day, ${DAY_STATS_TTL_SECONDS})
redis.call('EXPIRE', hour, ${HOUR_STATS_TTL_SECONDS})
return 1`;

const CREATE_JOB_SCRIPT = `
local p, jobId, requestId, studentId = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local existing = redis.call('GET', p .. ':jobreq:' .. requestId)
if existing then return existing end
redis.call('SET', p .. ':jobreq:' .. requestId, jobId, 'EX', ${JOB_REQUEST_TTL_SECONDS})
for i = 5, #ARGV, 2 do redis.call('HSET', p .. ':job:' .. jobId, ARGV[i], ARGV[i + 1]) end
redis.call('HSET', p .. ':jobs:active', jobId, studentId)
return ''`;

const FLUSH_JOB_SCRIPT = `
local key = ARGV[1] .. ':job:' .. ARGV[2]
if redis.call('EXISTS', key) == 0 then return '0' end
if ARGV[3] ~= '' then redis.call('APPEND', key .. ':text', ARGV[3]) end
redis.call('HSET', key, 'heartbeatAt', ARGV[4])
if redis.call('HGET', key, 'stopRequested') == '1' then return '1' end
return '0'`;

const VIEW_JOB_SCRIPT = `
local key = ARGV[1] .. ':job:' .. ARGV[2]
if redis.call('EXISTS', key) == 0 then return false end
redis.call('HSET', key, 'viewerAt', ARGV[4])
local length = redis.call('STRLEN', key .. ':text')
local from = tonumber(ARGV[3])
local text = ''
if from < length then text = redis.call('GETRANGE', key .. ':text', from, -1) end
return { redis.call('HGETALL', key), text, length }`;

const CLAIM_JOB_SCRIPT = `
local key = ARGV[1] .. ':job:' .. ARGV[2]
local status = redis.call('HGET', key, 'status')
local staleBefore = ARGV[4]
local quiet = staleBefore == '' or tonumber(redis.call('HGET', key, 'heartbeatAt') or '0') < tonumber(staleBefore)
local stuck = staleBefore ~= '' and status == 'finalizing' and tonumber(redis.call('HGET', key, 'finalizingAt') or '0') < tonumber(staleBefore)
if (status == 'running' and quiet) or stuck then
  redis.call('HSET', key, 'status', 'finalizing', 'finalizingAt', ARGV[3])
  return 1
end
return 0`;

const CLAIM_NOTICE_SCRIPT = `
local key = ARGV[1] .. ':job:' .. ARGV[2]
if redis.call('EXISTS', key) == 0 then return 0 end
local notice = redis.call('HGET', key, 'notify')
if notice == 'sent' or notice == 'skipped' or notice == 'no_channel' then return 0 end
local claimed = redis.call('HGET', key, 'notifyClaimAt')
if claimed and claimed ~= '' and tonumber(claimed) >= tonumber(ARGV[4]) then return 0 end
redis.call('HSET', key, 'notifyClaimAt', ARGV[3])
return redis.call('HINCRBY', key, 'notifyAttempts', 1)`;

/** JSON of a ledger entry without its closing brace; the Lua script appends the computed amounts. */
function ledgerPrefix(draft: object): string {
  return JSON.stringify(draft).slice(0, -1);
}

function hashFromReply(reply: unknown): Record<string, string> {
  if (!reply) return {};
  if (Array.isArray(reply)) {
    const hash: Record<string, string> = {};
    for (let index = 0; index + 1 < reply.length; index += 2) hash[String(reply[index])] = String(reply[index + 1]);
    return hash;
  }
  return Object.fromEntries(Object.entries(reply as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

function parseJsonList<T>(values: unknown): T[] {
  if (!Array.isArray(values)) return [];
  const out: T[] = [];
  for (const value of values) {
    try { out.push(JSON.parse(String(value)) as T); } catch { /* skip a corrupt entry */ }
  }
  return out;
}

export class RedisAiStore implements AiStore {
  readonly kind = 'redis' as const;

  constructor(private readonly client: RedisCommandClient, private readonly prefix: string) {}

  private key(...parts: string[]): string { return [this.prefix, ...parts].join(':'); }

  private async hashValues<T>(key: string): Promise<T[]> {
    const hash = hashFromReply(await this.client.command<unknown>(['HGETALL', key]));
    return parseJsonList<T>(Object.values(hash));
  }

  listProviders() { return this.hashValues<AiProviderRecord>(this.key('providers')); }
  async putProvider(provider: AiProviderRecord) { await this.client.command(['HSET', this.key('providers'), provider.id, JSON.stringify(provider)]); }
  async deleteProvider(id: string) { await this.client.command(['HDEL', this.key('providers'), id]); }
  listModels() { return this.hashValues<AiModelRecord>(this.key('models')); }
  async putModel(model: AiModelRecord) { await this.client.command(['HSET', this.key('models'), model.id, JSON.stringify(model)]); }
  async deleteModel(id: string) { await this.client.command(['HDEL', this.key('models'), id]); }

  async getSettings() {
    const raw = await this.client.command<string | null>(['GET', this.key('settings')]);
    if (!raw) return null;
    try { return JSON.parse(raw) as Partial<AiSettings>; } catch { return null; }
  }

  async putSettings(settings: AiSettings) { await this.client.command(['SET', this.key('settings'), JSON.stringify(settings)]); }
  listAccessRules() { return this.hashValues<AiAccessRule>(this.key('access')); }
  async putAccessRule(rule: AiAccessRule) { await this.client.command(['HSET', this.key('access'), `${rule.scope}:${rule.targetId}`, JSON.stringify(rule)]); }
  async deleteAccessRule(scope: AiAccessRule['scope'], targetId: string) { await this.client.command(['HDEL', this.key('access'), `${scope}:${targetId}`]); }
  listPackages() { return this.hashValues<AiResourcePackage>(this.key('packages')); }
  async putPackage(item: AiResourcePackage) { await this.client.command(['HSET', this.key('packages'), item.id, JSON.stringify(item)]); }
  async deletePackage(id: string) { await this.client.command(['HDEL', this.key('packages'), id]); }

  async getBalances(studentIds: string[]) {
    const replies = await this.client.pipeline<unknown>(studentIds.map(id => ['HGETALL', this.key('bal', id)]));
    return new Map(studentIds.map((id, index) => [id, balanceFromHash(id, hashFromReply(replies[index]))]));
  }

  async renewMonthly(studentId: string, period: string, ledger: LedgerDraft) {
    return (await this.client.command<number>(['EVAL', RENEW_SCRIPT, 0, this.prefix, studentId, period, ledgerPrefix(ledger)])) === 1;
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const reply = await this.client.command<Array<string | number>>([
      'EVAL', RESERVE_SCRIPT, 0, this.prefix, input.studentId, input.requestId,
      // Times travel in seconds: they stay well inside every Lua number representation.
      Math.floor(input.amount), Math.floor(input.minAmount), Math.floor(input.inputEstimate), Math.floor(input.expiresAt / 1000), Math.floor(input.now / 1000),
      input.period, input.maxConcurrent, input.rateLimit, input.rateWindow,
      ledgerPrefix(input.renewalLedger), ledgerPrefix(input.expiryLedger)
    ]);
    const expired: ReserveResult['expired'] = [];
    for (let index = 5; index + 1 < reply.length; index += 2) expired.push({ requestId: String(reply[index]), charged: Number(reply[index + 1]) });
    return {
      status: String(reply[0]) as ReserveStatus,
      reserved: Number(reply[1]),
      balance: Number(reply[2]),
      available: Number(reply[3]),
      renewed: Number(reply[4]) === 1,
      expired
    };
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    const reply = await this.client.command<Array<string | number>>([
      'EVAL', SETTLE_SCRIPT, 0, this.prefix, input.studentId, input.requestId,
      Math.max(0, Math.floor(input.actual)), Math.max(0, Math.floor(input.inputTokens)), Math.max(0, Math.floor(input.outputTokens)),
      input.approximate ? '1' : '0', Math.floor(input.now), input.modelId, ledgerPrefix(input.ledger)
    ]);
    return { status: String(reply[0]) === 'ok' ? 'ok' : 'unknown', charged: Number(reply[1]), balance: Number(reply[2]) };
  }

  async adjust(studentId: string, operation: AdjustOperation, ledger: LedgerDraft) {
    const amount = operation.kind === 'reset' ? 0 : Math.floor(operation.amount);
    const reply = await this.client.command<number[]>(['EVAL', ADJUST_SCRIPT, 0, this.prefix, studentId, operation.kind, amount, ledgerPrefix(ledger)]);
    return { before: Number(reply[0]), after: Number(reply[1]) };
  }

  async setBlocked(studentId: string, blocked: boolean, ledger: LedgerDraft) {
    await this.client.command(['EVAL', BLOCK_SCRIPT, 0, this.prefix, studentId, blocked ? '1' : '0', ledgerPrefix(ledger)]);
  }

  async setMonthly(studentId: string, limit: number, period: string, ledger: LedgerDraft) {
    const reply = await this.client.command<number[]>(['EVAL', MONTHLY_SCRIPT, 0, this.prefix, studentId, Math.floor(limit), period, ledgerPrefix(ledger)]);
    return { before: Number(reply[0]), after: Number(reply[1]) };
  }

  async listLedger(studentId: string | null, limit: number) {
    const key = studentId ? this.key('ledger', studentId) : this.key('ledger');
    return parseJsonList<AiLedgerEntry>(await this.client.command<unknown>(['LRANGE', key, 0, limit - 1]));
  }

  async recordUsage(input: { usage: AiUsageRecord | null; error: AiErrorRecord | null; day: string; hour: string; increments: StatsIncrement[] }) {
    const pairs = input.increments.filter(item => item.by !== 0).flatMap(item => [item.field, Math.round(item.by)]);
    await this.client.command(['EVAL', RECORD_USAGE_SCRIPT, 0, this.prefix, input.day, input.hour,
      input.usage ? JSON.stringify(input.usage) : '', input.error ? JSON.stringify(input.error) : '', ...pairs]);
  }

  async listUsage(limit: number) {
    return parseJsonList<AiUsageRecord>(await this.client.command<unknown>(['LRANGE', this.key('usage'), 0, limit - 1]));
  }

  async listErrors(limit: number) {
    return parseJsonList<AiErrorRecord>(await this.client.command<unknown>(['LRANGE', this.key('errors'), 0, limit - 1]));
  }

  async getStats(days: string[], hours: string[]) {
    const replies = await this.client.pipeline<unknown>([
      ...days.map(day => ['HGETALL', this.key('stats', 'd', day)]),
      ...hours.map(hour => ['HGETALL', this.key('stats', 'h', hour)])
    ]);
    const toNumbers = (reply: unknown) => Object.fromEntries(Object.entries(hashFromReply(reply)).map(([field, value]) => [field, Number(value) || 0]));
    return {
      days: Object.fromEntries(days.map((day, index) => [day, toNumbers(replies[index])])),
      hours: Object.fromEntries(hours.map((hour, index) => [hour, toNumbers(replies[days.length + index])]))
    };
  }

  async sumDayFields(days: string[], fields: string[]) {
    const totals: Record<string, number> = Object.fromEntries(fields.map(field => [field, 0]));
    if (!days.length || !fields.length) return totals;
    const replies = await this.client.pipeline<unknown>(days.map(day => ['HMGET', this.key('stats', 'd', day), ...fields]));
    for (const reply of replies) {
      if (!Array.isArray(reply)) continue;
      fields.forEach((field, index) => { totals[field] = (totals[field] ?? 0) + (Number(reply[index]) || 0); });
    }
    return totals;
  }

  listConversations(studentId: string) { return this.hashValues<AiConversation>(this.key('conv', studentId)); }

  async getConversation(studentId: string, conversationId: string) {
    const raw = await this.client.command<string | null>(['HGET', this.key('conv', studentId), conversationId]);
    if (!raw) return null;
    try { return JSON.parse(raw) as AiConversation; } catch { return null; }
  }

  async putConversation(conversation: AiConversation) {
    await this.client.command(['HSET', this.key('conv', conversation.studentId), conversation.id, JSON.stringify(conversation)]);
  }

  async deleteConversation(studentId: string, conversationId: string) {
    await this.client.pipeline([
      ['HDEL', this.key('conv', studentId), conversationId],
      ['DEL', this.key('msgs', conversationId)]
    ]);
  }

  async getMessages(conversationId: string, limit: number) {
    return parseJsonList<AiMessage>(await this.client.command<unknown>(['LRANGE', this.key('msgs', conversationId), -limit, -1]));
  }

  async appendMessages(conversationId: string, messages: AiMessage[], cap: number) {
    if (!messages.length) return;
    const key = this.key('msgs', conversationId);
    await this.client.pipeline([
      ['RPUSH', key, ...messages.map(message => JSON.stringify(message))],
      ['LTRIM', key, -cap, -1]
    ]);
  }

  listAttachments(studentId: string) { return this.hashValues<AiAttachment>(this.key('atts', studentId)); }

  async getAttachment(studentId: string, attachmentId: string) {
    const raw = await this.client.command<string | null>(['HGET', this.key('atts', studentId), attachmentId]);
    if (!raw) return null;
    try { return JSON.parse(raw) as AiAttachment; } catch { return null; }
  }

  async putAttachment(attachment: AiAttachment) {
    await this.client.command(['HSET', this.key('atts', attachment.studentId), attachment.id, JSON.stringify(attachment)]);
  }

  async deleteAttachment(studentId: string, attachmentId: string) {
    await this.client.pipeline([
      ['HDEL', this.key('atts', studentId), attachmentId],
      ['DEL', this.key('att', attachmentId)]
    ]);
  }

  async putAttachmentText(attachmentId: string, text: string) {
    await this.client.command(['SET', this.key('att', attachmentId), text]);
  }

  async getAttachmentTexts(attachmentIds: string[]) {
    const replies = await this.client.pipeline<string | null>(attachmentIds.map(id => ['GET', this.key('att', id)]));
    return new Map(attachmentIds.flatMap((id, index) => typeof replies[index] === 'string' ? [[id, replies[index] as string] as const] : []));
  }

  async createJob(job: AiJob) {
    const fields = Object.entries(jobToFields(job)).flat();
    const existing = await this.client.command<string>(['EVAL', CREATE_JOB_SCRIPT, 0, this.prefix, job.id, job.requestId, job.studentId, ...fields]);
    return existing ? { created: false as const, existingJobId: existing } : { created: true as const };
  }

  async jobIdForRequest(requestId: string) { return (await this.client.command<string | null>(['GET', this.key('jobreq', requestId)])) || null; }
  async getJob(jobId: string) { return jobFromFields(hashFromReply(await this.client.command<unknown>(['HGETALL', this.key('job', jobId)]))); }
  async getJobs(jobIds: string[]) {
    if (!jobIds.length) return new Map<string, AiJob>();
    const replies = await this.client.pipeline<unknown>(jobIds.map(id => ['HGETALL', this.key('job', id)]));
    const out = new Map<string, AiJob>();
    replies.forEach((reply, index) => { const job = jobFromFields(hashFromReply(reply)); if (job) out.set(jobIds[index]!, job); });
    return out;
  }
  async getJobText(jobId: string) { return (await this.client.command<string | null>(['GET', this.key('job', jobId, 'text')])) ?? ''; }

  async flushJob(jobId: string, chunk: string, now: number) {
    return { stopRequested: (await this.client.command<string>(['EVAL', FLUSH_JOB_SCRIPT, 0, this.prefix, jobId, chunk, now])) === '1' };
  }

  async viewJob(jobId: string, fromByte: number, now: number) {
    const reply = await this.client.command<[unknown, string, number] | null>(['EVAL', VIEW_JOB_SCRIPT, 0, this.prefix, jobId, Math.max(0, Math.floor(fromByte)), now]);
    if (!reply) return null;
    const job = jobFromFields(hashFromReply(reply[0]));
    return job ? { job, text: reply[1] ?? '', length: Number(reply[2]) || 0 } : null;
  }

  async requestJobStop(jobId: string) { await this.client.command(['HSET', this.key('job', jobId), 'stopRequested', '1']); }

  async claimJobFinalization(jobId: string, now: number, staleBefore: number | null) {
    return (await this.client.command<number>(['EVAL', CLAIM_JOB_SCRIPT, 0, this.prefix, jobId, now, staleBefore === null ? '' : staleBefore])) === 1;
  }

  async finishJob(jobId: string, fields: Partial<AiJob>) {
    await this.client.pipeline([
      ['HSET', this.key('job', jobId), ...Object.entries(jobToFields(fields)).flat()],
      ['EXPIRE', this.key('job', jobId), JOB_TTL_SECONDS],
      ['EXPIRE', this.key('job', jobId, 'text'), JOB_TTL_SECONDS]
    ]);
  }

  async claimJobNotification(jobId: string, now: number, leaseBefore: number) {
    return Number(await this.client.command<number>(['EVAL', CLAIM_NOTICE_SCRIPT, 0, this.prefix, jobId, now, leaseBefore])) || 0;
  }

  async releaseJob(jobId: string) { await this.client.command(['HDEL', this.key('jobs', 'active'), jobId]); }

  listSkills() { return this.hashValues<AiSkill>(this.key('skills')); }
  async putSkill(skill: AiSkill) { await this.client.command(['HSET', this.key('skills'), skill.id, JSON.stringify(skill)]); }
  async deleteSkill(id: string) { await this.client.command(['HDEL', this.key('skills'), id]); }
  listPlugins() { return this.hashValues<AiPluginRecord>(this.key('plugins')); }
  async putPlugin(plugin: AiPluginRecord) { await this.client.command(['HSET', this.key('plugins'), plugin.id, JSON.stringify(plugin)]); }
  async deletePlugin(id: string) { await this.client.command(['HDEL', this.key('plugins'), id]); }
  async putGeneratedFile(file: AiGeneratedFile) { await this.client.command(['SET', this.key('gen', file.id), JSON.stringify(file)]); }
  async getGeneratedFile(id: string) {
    const raw = await this.client.command<string | null>(['GET', this.key('gen', id)]);
    if (!raw) return null;
    try { return JSON.parse(raw) as AiGeneratedFile; } catch { return null; }
  }
  async deleteGeneratedFiles(ids: string[]) { if (ids.length) await this.client.command(['DEL', ...ids.map(id => this.key('gen', id))]); }

  async updateJob(jobId: string, fields: Partial<AiJob> & { notifyClaimAt?: string }) {
    const pairs = Object.entries(jobToFields(fields)).flat();
    if (pairs.length) await this.client.command(['HSET', this.key('job', jobId), ...pairs]);
  }

  async listActiveJobs() {
    return Object.entries(hashFromReply(await this.client.command<unknown>(['HGETALL', this.key('jobs', 'active')]))).map(([jobId, studentId]) => ({ jobId, studentId }));
  }
}
