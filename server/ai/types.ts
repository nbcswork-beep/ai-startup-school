/**
 * AI assistant domain. Two kinds of "balance" live here and are never mixed:
 * - provider resources the school bought (tokens or money), tracked in AiResourcePackage;
 * - internal student allowances in tokens, tracked in AiBalance and changed only by the server.
 */

export type AiProtocol = 'openai' | 'anthropic';
export type AiBalanceSource = 'none' | 'openrouter' | 'deepseek';
export type AiModelFamily = 'gpt' | 'claude' | 'gemini' | 'deepseek' | 'qwen' | 'llama' | 'mistral' | 'other';

/** AES-256-GCM sealed value. Only the server can open it. */
export interface SealedSecret {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export interface AiProviderKey {
  id: string;
  label: string;
  secret: SealedSecret;
  /** Last four characters, for recognising a key in the admin UI. */
  hint: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
}

export interface AiProviderHeader {
  name: string;
  secret: SealedSecret;
  hint: string;
}

export interface AiProviderRecord {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  keys: AiProviderKey[];
  headers: AiProviderHeader[];
  enabled: boolean;
  balanceSource: AiBalanceSource;
  lastCheck: { ok: boolean; at: string; message: string; latencyMs: number | null } | null;
  syncedBalance: { amount: number; currency: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelPricing {
  currency: string;
  /** Price per one million tokens; null when the admin did not enter a real tariff. */
  inputPer1M: number | null;
  outputPer1M: number | null;
  cachedInputPer1M: number | null;
}

export interface AiModelRecord {
  id: string;
  providerId: string;
  /** Exact model id accepted by the provider API. Never invented: entered or discovered, then tested. */
  apiModelId: string;
  label: string;
  family: AiModelFamily;
  enabled: boolean;
  verifiedAt: string | null;
  lastTestError: string | null;
  maxOutputTokens: number;
  maxInputTokens: number;
  pricing: AiModelPricing;
  /** Used once, only before any text arrived, when this model's provider fails with a retryable error. */
  fallbackModelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiSettings {
  defaultModelId: string | null;
  systemPrompt: string;
  maxMessageChars: number;
  requestsPerMinute: number;
  maxConcurrentPerStudent: number;
  /** Shown to the student as "running low" below this many tokens. */
  lowBalanceTokens: number;
  /** Warn the admin when a package has less than this share left. */
  resourceWarningPercent: number;
}

export interface AiAccessRule {
  scope: 'student' | 'group';
  targetId: string;
  /** null keeps every enabled model available. */
  modelIds: string[] | null;
  defaultModelId: string | null;
  updatedAt: string;
}

export interface AiBalance {
  studentId: string;
  /** Tokens the student may still spend, before in-flight reservations. */
  balance: number;
  reserved: number;
  used: number;
  /** Part of `used` that was charged from an estimate because the provider sent no usage. */
  approxUsed: number;
  inputUsed: number;
  outputUsed: number;
  requests: number;
  blocked: boolean;
  monthlyLimit: number;
  period: string | null;
  lastActivityAt: string | null;
  lastModelId: string | null;
}

export type AiLedgerType = 'grant' | 'set' | 'reset' | 'charge' | 'block' | 'unblock' | 'monthly_on' | 'monthly_off' | 'monthly_renewal' | 'expired_reservation';

export interface AiLedgerEntry {
  id: string;
  at: string;
  studentId: string;
  type: AiLedgerType;
  /** Change of `balance`; negative for charges. */
  amount: number;
  balanceAfter: number;
  actorId: string | null;
  note: string | null;
  requestId?: string;
  modelId?: string;
  approximate?: boolean;
  batchId?: string;
}

export type AiUsageStatus = 'complete' | 'stopped' | 'interrupted' | 'error';

export interface AiUsageRecord {
  id: string;
  at: string;
  requestId: string;
  studentId: string;
  groupId: string | null;
  conversationId: string;
  providerId: string;
  modelId: string;
  apiModelId: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  charged: number;
  /** Usage above what the balance could cover; recorded, never turned into a negative balance. */
  uncharged: number;
  approximate: boolean;
  status: AiUsageStatus;
  errorCode: string | null;
  costMicros: number | null;
  currency: string | null;
  latencyMs: number;
}

export interface AiErrorRecord {
  id: string;
  at: string;
  providerId: string;
  modelId: string | null;
  status: number | null;
  code: string;
  message: string;
  studentId: string | null;
}

export type AiResourceUnit = 'tokens' | 'credits' | 'money';

export interface AiResourcePackage {
  id: string;
  name: string;
  providerId: string;
  unit: AiResourceUnit;
  /** Currency for `money` packages and for cost. */
  currency: string;
  purchasedAmount: number;
  cost: number | null;
  costCurrency: string;
  purchasedAt: string;
  expiresAt: string | null;
  /** A remaining figure the admin read from the provider's dashboard, with when it was entered. */
  manualRemaining: number | null;
  manualRemainingAt: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversation {
  id: string;
  studentId: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface AiMessageUsage {
  input: number;
  output: number;
  total: number;
  approximate: boolean;
}

/** A ZIP a student attached to the chat. Its text lives in a separate key; the archive in private storage. */
export interface AiAttachment {
  id: string;
  studentId: string;
  name: string;
  size: number;
  pathname: string;
  status: 'pending' | 'ready';
  createdAt: string;
  expiresAt: string;
  files: Array<{ path: string; chars: number }>;
  skipped: Array<{ path: string; reason: string }>;
  estimatedTokens: number;
  /** Conversation the archive was sent in; an archive is sent once. */
  usedIn: string | null;
}

export interface AiMessageAttachment {
  id: string;
  name: string;
  size: number;
  fileCount: number;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  modelId?: string;
  modelLabel?: string;
  usage?: AiMessageUsage;
  status?: 'complete' | 'stopped' | 'interrupted';
  attachments?: AiMessageAttachment[];
  /** Files the answer wrote as named code blocks; downloadable as one ZIP. */
  archive?: { fileCount: number; paths: string[] };
}
