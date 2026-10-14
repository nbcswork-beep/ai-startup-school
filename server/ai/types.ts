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
  /** Requests per minute the provider allows for all students together (free NVIDIA: about 40 per key). Null means no pacing. */
  rateLimitPerMinute?: number | null;
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
  /** The model can call tools, so students may use it in agent mode. Missing means yes. */
  agent?: boolean;
  /** The model reads images (photos of pages, boards, tasks). Missing means no. */
  vision?: boolean;
  /** What the last capability check found; null where the provider gave no clear answer. */
  capabilities?: { checkedAt: string; tools: boolean | null; vision: boolean | null; note: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiSettings {
  memoryEnabled: boolean;
  defaultModelId: string | null;
  systemPrompt: string;
  maxMessageChars: number;
  requestsPerMinute: number;
  maxConcurrentPerStudent: number;
  /** Shown to the student as "running low" below this many tokens. */
  lowBalanceTokens: number;
  /** Warn the admin when a package has less than this share left. */
  resourceWarningPercent: number;
  // The agent's profile. Its instructions are `systemPrompt`.
  agentName: string;
  agentDescription: string;
  /** 'auto' answers in the student's language. */
  agentLanguage: 'auto' | 'uk' | 'en' | 'pl' | 'de';
  agentStyle: 'friendly' | 'concise' | 'detailed' | 'academic';
  /** Students may switch on agent mode (tools, files, several steps). */
  agentEnabled: boolean;
  /** Tool calls in one agent run. */
  agentMaxSteps: number;
  /** Default model in agent mode (a stronger one, with tools); null uses the default model. */
  agentModelId: string | null;
}

/** A skill: what it is for, when it applies, how to do it, and which tools it may use. Stored and exchanged as SKILL.md. */
export interface AiSkill {
  id: string;
  name: string;
  description: string;
  when: string;
  instructions: string;
  /** Tool names the skill may use; empty means every enabled tool. */
  tools: string[];
  enabled: boolean;
  /** One of the skills that ship with the school; it can be edited but comes back on reset. */
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AiPluginPermission = 'files:read' | 'files:write' | 'network' | 'compute';

/** A tool a plugin declares. HTTP tools are run by the generic HTTP runner; built-in tools by code. */
export interface AiToolManifest {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** For HTTP plugins: the request to make. `{name}` in the path takes an argument. */
  http?: { method: 'GET' | 'POST'; path: string };
}

export interface AiPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: AiPluginPermission[];
  settings: Array<{ key: string; label: string; type: 'text' | 'number' | 'boolean' | 'select'; options?: string[]; default?: string | number | boolean }>;
  /** Secrets the plugin needs; values live sealed on the server and never reach the browser. */
  secrets: Array<{ key: string; label: string; header?: string }>;
  /** HTTP plugins: base URL of the service. */
  baseUrl?: string;
  tools: AiToolManifest[];
}

export interface AiPluginRecord {
  id: string;
  source: 'builtin' | 'manifest';
  /** Only for imported plugins; built-in manifests come from code. */
  manifest: AiPluginManifest | null;
  enabled: boolean;
  settings: Record<string, string | number | boolean>;
  secrets: Record<string, SealedSecret>;
  installedAt: string;
  updatedAt: string;
}

export type AiFilePreview =
  | { kind: 'outline'; items: string[] }
  | { kind: 'slides'; items: string[] }
  | { kind: 'table'; sheet: string; header: string[]; rows: string[][] }
  | { kind: 'text'; text: string };

export type AiOutputFormat = 'docx' | 'pdf' | 'pptx' | 'xlsx' | 'csv' | 'md' | 'txt';

/** A file the agent made: its source (Markdown or CSV) is kept and the file is rebuilt on download. */
export interface AiGeneratedFile {
  id: string;
  studentId: string;
  conversationId: string;
  name: string;
  format: AiOutputFormat;
  title: string;
  content: string;
  size: number;
  preview: AiFilePreview;
  createdAt: string;
}

export interface AiFileRef {
  id: string;
  name: string;
  format: AiOutputFormat;
  size: number;
  preview: AiFilePreview;
}

/** One visible step of an agent run. Labels describe actions, never the model's reasoning. */
export interface AiStep {
  id: string;
  kind: 'read' | 'skill' | 'create' | 'check' | 'tool' | 'confirm' | 'answer';
  label: string;
  status: 'running' | 'done' | 'error' | 'declined';
  detail?: string | null;
  fileId?: string;
}

/** An action that sends data out or cannot be undone, waiting for the student's yes. */
export interface AiPendingAction {
  stepId: string;
  tool: string;
  plugin: string;
  title: string;
  details: string;
  expiresAt: number;
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
  feedback?: Record<string, { value: 'up' | 'down'; modelId: string; skillId: string | null; at: string }>;
  context?: { type: 'lesson' | 'homework'; id: string; title: string };
  memory?: { text: string; throughId: string; updatedAt: string };

  id: string;
  studentId: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
  /** The latest answer job of this chat, running or finished; lets a reopened app reconnect. */
  lastJobId?: string | null;
}

/**
 * One answer being generated. It lives in storage, not in a browser connection: the student may
 * close the app and come back, and only an explicit stop cancels it.
 */
export type AiJobStatus = 'running' | 'finalizing' | 'complete' | 'stopped' | 'interrupted' | 'error';

export interface AiJob {
  id: string;
  studentId: string;
  conversationId: string;
  requestId: string;
  userMessageId: string;
  assistantMessageId: string;
  modelId: string;
  modelLabel: string;
  groupId: string | null;
  status: AiJobStatus;
  createdAt: number;
  /** Last sign of life from the function generating it. */
  heartbeatAt: number;
  /** Last time the student's app asked about it. */
  viewerAt: number;
  finalizingAt: number | null;
  finishedAt: number | null;
  stopRequested: boolean;
  /** Estimated prompt tokens, charged if the job has to be recovered without a usage report. */
  inputTokens: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** Telegram notice once finished: sent, skipped (the student was watching), failed, or no Telegram chat to send to. */
  notify: 'sent' | 'skipped' | 'failed' | 'no_channel' | null;
  notifyAttempts: number;
  /** The student's message. It joins the chat history together with the answer. */
  userMessage: AiMessage | null;
  /** The saved assistant message once finished. */
  message: AiMessage | null;
  mode: 'chat' | 'agent';
  /** Agent runs: the visible steps and the files made so far. */
  steps: AiStep[];
  files: AiFileRef[];
  /** An action waiting for the student's confirmation, and the answer once given. */
  pending: AiPendingAction | null;
  decision: { stepId: string; approve: boolean } | null;
  /** The provider's request limit is reached: the answer waits in line until this time. */
  queuedUntil: number | null;
}

export interface AiMessageUsage {
  input: number;
  output: number;
  total: number;
  approximate: boolean;
}

export type AiAttachmentKind = 'jpg' | 'png' | 'webp' | 'zip' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'pptx' | 'txt' | 'md';

/** A file a student attached to the chat. Its text lives in a separate key; the file in private storage. */
export interface AiAttachment {
  id: string;
  studentId: string;
  name: string;
  size: number;
  pathname: string;
  /** Missing on archives attached before documents were supported. */
  kind?: AiAttachmentKind;
  status: 'pending' | 'ready';
  createdAt: string;
  expiresAt: string;
  files: Array<{ path: string; chars: number }>;
  skipped: Array<{ path: string; reason: string }>;
  estimatedTokens: number;
  /** Conversation the archive was sent in; an archive is sent once. */
  usedIn: string | null;
  pages?: number;
  slides?: number;
  sheets?: Array<{ name: string; rows: number; columns: number }>;
  outline?: string[];
  /** A PDF without a text layer; only a model that reads PDFs as images can see it. */
  scanned?: boolean;
  warnings?: string[];
}

export interface AiMessageAttachment {
  id: string;
  name: string;
  size: number;
  fileCount: number;
  kind?: AiAttachmentKind;
  pages?: number;
}

export interface AiMessage {
  /** A successful revision supersedes a whole exchange; originals remain stored. */
  revision?: { userId: string; assistantId: string };
  feedback?: 'up' | 'down' | null;

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
  /** Agent answers: files made, the steps taken, and the skill used. */
  files?: AiFileRef[];
  steps?: AiStep[];
  mode?: 'agent';
  skill?: { id: string; name: string } | null;
}
