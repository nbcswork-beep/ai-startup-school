import type { AiBalanceSource, AiProtocol } from './types.js';

/**
 * Provider adapters. Each one speaks one wire protocol over plain fetch, so any reseller or gateway
 * with its own Base URL works as long as it implements that protocol faithfully.
 */

export interface ToolCall { id: string; name: string; arguments: string }
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turns: the tools the model called. */
  toolCalls?: ToolCall[];
  /** Tool turns: the call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** User turns: PDFs the model reads page by page as images (scans without a text layer). */
  documents?: Array<{ title: string; data: string }>;
  /** User turns: photos for models that see images (base64, JPEG/PNG/WebP). */
  images?: Array<{ mime: string; data: string }>;
}

export interface ProviderConnection {
  protocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface ProviderUsage {
  /** All prompt tokens the provider billed, cached ones included. */
  inputTokens: number;
  /** All generated tokens, reasoning included. */
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: ProviderUsage }
  | { type: 'finish'; reason: string | null }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_delta'; call: ToolCall };

export interface ChatStreamRequest {
  model: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  signal: AbortSignal;
  /** Tools the model may call; the caller runs them and continues the conversation. */
  tools?: ToolSpec[];
  /** Longest the whole request may take (default 280 s, under Vercel's 300 s). */
  timeoutMs?: number;
  /** Longest silence while streaming; off by default (some models think quietly). */
  idleTimeoutMs?: number;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  contextWindow: number | null;
}

export type ProviderErrorCode = 'auth' | 'rate_limit' | 'quota' | 'not_found' | 'bad_request' | 'server' | 'network' | 'timeout' | 'invalid_response' | 'aborted';

export class AiProviderError extends Error {
  /** Input tokens the provider already reported before the stream failed, when it did. */
  partialInputTokens: number | null = null;
  /** How long the provider asked to wait (Retry-After), for rate limits. */
  retryAfterMs: number | null = null;
  /** The request ended while it waited in line, before the provider was asked: nothing to charge. */
  unsent = false;

  constructor(readonly code: ProviderErrorCode, message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'AiProviderError';
  }

  /** Worth trying another key or the fallback model: the provider did not reject the request itself. */
  get retryable(): boolean {
    return ['rate_limit', 'server', 'network', 'timeout', 'auth', 'quota'].includes(this.code);
  }
}

export interface ProviderAdapter {
  listModels(signal: AbortSignal): Promise<DiscoveredModel[]>;
  stream(request: ChatStreamRequest): AsyncGenerator<StreamEvent>;
  balance(source: AiBalanceSource, signal: AbortSignal): Promise<{ amount: number; currency: string } | null>;
}

const CONNECT_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 280_000;

export function createAdapter(connection: ProviderConnection): ProviderAdapter {
  return connection.protocol === 'anthropic' ? new AnthropicAdapter(connection) : new OpenAiCompatibleAdapter(connection);
}

/** Strips anything that looks like a credential and bounds the length before a message is stored or shown. */
export function safeProviderMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return text
    // Providers quote keys whole or masked ("sk-abc...xyz1234"); drop the whole token either way.
    .replace(/\b(sk|rk|pk|ak|key)-[^\s"',;)]{3,}/gi, '[ключ приховано]')
    .replace(/Bearer\s+[^\s"',;)]{8,}/gi, 'Bearer [приховано]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[приховано]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function errorCodeForStatus(status: number, message: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 429) return /quota|credit|balance|billing|insufficient/i.test(message) ? 'quota' : 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

async function errorFromResponse(response: Response): Promise<AiProviderError> {
  const raw = await response.text().catch(() => '');
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    message = typeof parsed.error === 'string' ? parsed.error : String(parsed.error?.message ?? parsed.message ?? raw);
  } catch { /* plain text body */ }
  const safe = safeProviderMessage(message) || `HTTP ${response.status}`;
  const error = new AiProviderError(errorCodeForStatus(response.status, safe), safe, response.status);
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const at = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(at) && at > 0) error.retryAfterMs = at;
  }
  return error;
}

/** How long to wait for the response to start: the usual limit, or the stream's idle limit when that is shorter. */
function firstByteTimeout(request: ChatStreamRequest): number {
  return Math.min(CONNECT_TIMEOUT_MS, request.idleTimeoutMs ?? CONNECT_TIMEOUT_MS);
}

function linkSignals(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function send(url: string, init: RequestInit & { signal: AbortSignal }, connectTimeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
  // The connect timeout covers waiting for response headers; the stream itself has the request timeout.
  const connect = new AbortController();
  const timer = setTimeout(() => connect.abort(new DOMException('connect timeout', 'TimeoutError')), connectTimeoutMs);
  const onAbort = () => connect.abort(init.signal.reason);
  init.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([connect.signal, init.signal]), redirect: 'error' });
  } catch (error) {
    throw toProviderError(error, init.signal);
  } finally {
    clearTimeout(timer);
    init.signal.removeEventListener('abort', onAbort);
  }
}

function toProviderError(error: unknown, signal: AbortSignal): AiProviderError {
  if (error instanceof AiProviderError) return error;
  if (signal.aborted && !(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) {
    return new AiProviderError('aborted', 'Генерацію зупинено');
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')) {
    return new AiProviderError('timeout', 'Провайдер не відповів вчасно');
  }
  return new AiProviderError('network', 'Не вдалося зʼєднатися з провайдером');
}

interface SseEvent { event: string; data: string }

/** Server-sent events from a fetch body. Handles CRLF, multi-line data and frames split across chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleTimeoutMs?: number): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // A stream that stops sending without closing would hold a worker until the request timeout.
  const read = () => {
    if (!idleTimeoutMs) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DOMException('idle stream', 'TimeoutError')), idleTimeoutMs); });
    return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
  };
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : frames.pop() ?? '';
      for (const frame of frames) {
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const fieldValue = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = fieldValue;
          else if (field === 'data') data.push(fieldValue);
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible Chat Completions: OpenAI, OpenRouter, DeepSeek, Qwen (DashScope compatible mode),
// Groq, Together, Mistral, most resellers and gateways.

/** Remembers per base URL + model which request shape the provider accepted. */
const compatibility = new Map<string, { maxCompletionTokens: boolean; streamOptions: boolean }>();

class OpenAiCompatibleAdapter implements ProviderAdapter {
  private readonly base: string;

  constructor(private readonly connection: ProviderConnection) {
    this.base = trimSlash(connection.baseUrl);
  }

  private headers(json = false): Record<string, string> {
    return {
      ...this.connection.headers,
      authorization: `Bearer ${this.connection.apiKey}`,
      accept: json ? 'application/json' : 'text/event-stream',
      ...(json ? {} : { 'content-type': 'application/json' })
    };
  }

  async listModels(signal: AbortSignal): Promise<DiscoveredModel[]> {
    const response = await send(`${this.base}/models`, { method: 'GET', headers: this.headers(true), signal: linkSignals(signal, 30_000) });
    if (!response.ok) throw await errorFromResponse(response);
    const payload = await response.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
    if (!payload || !Array.isArray(payload.data)) throw new AiProviderError('invalid_response', 'Провайдер не повернув список моделей');
    return payload.data
      .filter(item => typeof item.id === 'string' && item.id)
      .map(item => ({
        id: String(item.id),
        label: typeof item.name === 'string' && item.name ? item.name : String(item.id),
        contextWindow: numberOr(item.context_length ?? item.context_window, 0) || null
      }));
  }

  async *stream(request: ChatStreamRequest): AsyncGenerator<StreamEvent> {
    const key = `${this.base}|${request.model}`;
    const known = compatibility.get(key) ?? { maxCompletionTokens: false, streamOptions: true };
    let shape = { ...known };
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const body: Record<string, unknown> = { model: request.model, messages: request.messages.map(openAiMessage), stream: true };
      if (request.tools?.length) { body.tools = request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })); body.tool_choice = 'auto'; }
      body[shape.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = request.maxOutputTokens;
      if (shape.streamOptions) body.stream_options = { include_usage: true };
      response = await send(`${this.base}/chat/completions`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: linkSignals(request.signal, request.timeoutMs ?? REQUEST_TIMEOUT_MS)
      }, firstByteTimeout(request));
      if (response.ok) break;
      const error = await errorFromResponse(response);
      // Some models only accept max_completion_tokens; some older gateways reject stream_options.
      if (response.status === 400 && /max_completion_tokens|max_tokens.*not supported|unsupported.*max_tokens/i.test(error.message) && !shape.maxCompletionTokens) {
        shape = { ...shape, maxCompletionTokens: true }; continue;
      }
      if (response.status === 400 && /stream_options|include_usage/i.test(error.message) && shape.streamOptions) {
        shape = { ...shape, streamOptions: false }; continue;
      }
      throw error;
    }
    if (!response?.ok || !response.body) throw new AiProviderError('invalid_response', 'Провайдер не повернув потік відповіді');
    compatibility.set(key, shape);

    let usage: ProviderUsage | null = null;
    let finish: string | null = null;
    const calls = new Map<number, ToolCall>();
    try {
      for await (const frame of readSse(response.body, request.signal, request.idleTimeoutMs)) {
        if (frame.data === '[DONE]') break;
        let chunk: Record<string, any>;
        try { chunk = JSON.parse(frame.data); } catch { continue; }
        if (chunk.error) {
          const message = safeProviderMessage(chunk.error?.message ?? chunk.error);
          throw new AiProviderError(errorCodeForStatus(numberOr(chunk.error?.code, 500) || 500, message), message || 'Помилка провайдера під час генерації', null);
        }
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        const text = choice?.delta?.content;
        if (typeof text === 'string' && text) yield { type: 'text', text };
        for (const delta of Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : []) {
          const index = numberOr(delta?.index, calls.size);
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
          // Once a delta is exposed, its identity must remain stable even for gateways that send id late.
          if (!call.id) call.id = typeof delta?.id === 'string' && delta.id ? delta.id : `call_${index}`;
          if (typeof delta?.function?.name === 'string') call.name += delta.function.name;
          if (typeof delta?.function?.arguments === 'string') call.arguments += delta.function.arguments;
          calls.set(index, call);
          if (call.name && call.arguments) yield { type: 'tool_call_delta', call: { ...call, id: call.id || `call_${index}` } };
        }
        if (choice?.finish_reason) finish = String(choice.finish_reason);
        if (chunk.usage && typeof chunk.usage === 'object') {
          const reported = chunk.usage as Record<string, any>;
          const input = numberOr(reported.prompt_tokens);
          const output = numberOr(reported.completion_tokens);
          if (input || output) {
            usage = {
              inputTokens: input,
              outputTokens: output,
              reasoningTokens: numberOr(reported.completion_tokens_details?.reasoning_tokens ?? reported.reasoning_tokens),
              cachedTokens: numberOr(reported.prompt_tokens_details?.cached_tokens ?? reported.prompt_cache_hit_tokens),
              cacheWriteTokens: 0
            };
          }
        }
      }
    } catch (error) {
      throw toProviderError(error, request.signal);
    }
    for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
      if (call.name) yield { type: 'tool_call', call: { id: call.id || `call_${index}`, name: call.name, arguments: call.arguments || '{}' } };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: finish };
  }

  async balance(source: AiBalanceSource, signal: AbortSignal): Promise<{ amount: number; currency: string } | null> {
    if (source === 'openrouter') {
      const response = await send(`${this.base}/credits`, { method: 'GET', headers: this.headers(true), signal: linkSignals(signal, 20_000) });
      if (!response.ok) throw await errorFromResponse(response);
      const payload = await response.json().catch(() => null) as { data?: { total_credits?: number; total_usage?: number } } | null;
      if (typeof payload?.data?.total_credits !== 'number' || typeof payload.data.total_usage !== 'number') {
        throw new AiProviderError('invalid_response', 'Провайдер не повернув баланс');
      }
      return { amount: Math.round((payload.data.total_credits - payload.data.total_usage) * 100) / 100, currency: 'USD' };
    }
    if (source === 'deepseek') {
      const root = this.base.replace(/\/v1$/, '');
      const response = await send(`${root}/user/balance`, { method: 'GET', headers: this.headers(true), signal: linkSignals(signal, 20_000) });
      if (!response.ok) throw await errorFromResponse(response);
      const payload = await response.json().catch(() => null) as { balance_infos?: Array<{ currency?: string; total_balance?: string }> } | null;
      const info = payload?.balance_infos?.[0];
      const amount = Number(info?.total_balance);
      if (!info || !Number.isFinite(amount)) throw new AiProviderError('invalid_response', 'Провайдер не повернув баланс');
      return { amount, currency: info.currency ?? 'USD' };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages API (and gateways that mirror it).

class AnthropicAdapter implements ProviderAdapter {
  private readonly base: string;

  constructor(private readonly connection: ProviderConnection) {
    const trimmed = trimSlash(connection.baseUrl);
    this.base = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }

  private headers(): Record<string, string> {
    return {
      ...this.connection.headers,
      'x-api-key': this.connection.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    };
  }

  async listModels(signal: AbortSignal): Promise<DiscoveredModel[]> {
    const response = await send(`${this.base}/models?limit=1000`, { method: 'GET', headers: this.headers(), signal: linkSignals(signal, 30_000) });
    if (!response.ok) throw await errorFromResponse(response);
    const payload = await response.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
    if (!payload || !Array.isArray(payload.data)) throw new AiProviderError('invalid_response', 'Провайдер не повернув список моделей');
    return payload.data
      .filter(item => typeof item.id === 'string' && item.id)
      .map(item => ({ id: String(item.id), label: typeof item.display_name === 'string' ? item.display_name : String(item.id), contextWindow: null }));
  }

  async *stream(request: ChatStreamRequest): AsyncGenerator<StreamEvent> {
    const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const turns = anthropicTurns(request.messages);
    const tools = request.tools?.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {};
    const response = await send(`${this.base}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: request.model, max_tokens: request.maxOutputTokens, ...(system ? { system } : {}), messages: turns, ...tools, stream: true }),
      signal: linkSignals(request.signal, request.timeoutMs ?? REQUEST_TIMEOUT_MS)
    }, firstByteTimeout(request));
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw new AiProviderError('invalid_response', 'Провайдер не повернув потік відповіді');

    let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, sawUsage = false;
    let finish: string | null = null;
    const calls = new Map<number, ToolCall>();
    const finished: ToolCall[] = [];
    try {
      for await (const frame of readSse(response.body, request.signal, request.idleTimeoutMs)) {
        let payload: Record<string, any>;
        try { payload = JSON.parse(frame.data); } catch { continue; }
        const type = payload.type ?? frame.event;
        if (type === 'error') {
          const message = safeProviderMessage(payload.error?.message);
          const code: ProviderErrorCode = payload.error?.type === 'overloaded_error' ? 'server' : payload.error?.type === 'rate_limit_error' ? 'rate_limit' : 'server';
          throw new AiProviderError(code, message || 'Помилка провайдера під час генерації');
        }
        if (type === 'message_start') {
          const usage = payload.message?.usage ?? {};
          input = numberOr(usage.input_tokens); cacheRead = numberOr(usage.cache_read_input_tokens); cacheWrite = numberOr(usage.cache_creation_input_tokens);
          output = numberOr(usage.output_tokens); sawUsage = true;
        } else if (type === 'content_block_start') {
          if (payload.content_block?.type === 'tool_use') calls.set(numberOr(payload.index), { id: String(payload.content_block.id ?? ''), name: String(payload.content_block.name ?? ''), arguments: '' });
        } else if (type === 'content_block_stop') {
          const call = calls.get(numberOr(payload.index));
          if (call) { finished.push({ ...call, arguments: call.arguments || '{}' }); calls.delete(numberOr(payload.index)); }
        } else if (type === 'content_block_delta') {
          if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string' && payload.delta.text) yield { type: 'text', text: payload.delta.text };
          if (payload.delta?.type === 'input_json_delta' && typeof payload.delta.partial_json === 'string') {
            const call = calls.get(numberOr(payload.index));
            if (call) {
              call.arguments += payload.delta.partial_json;
              yield { type: 'tool_call_delta', call: { ...call } };
            }
          }
        } else if (type === 'message_delta') {
          if (payload.usage) { output = numberOr(payload.usage.output_tokens, output); sawUsage = true; }
          if (payload.delta?.stop_reason) finish = String(payload.delta.stop_reason);
        } else if (type === 'message_stop') {
          break;
        }
      }
    } catch (error) {
      const failure = toProviderError(error, request.signal);
      // message_start already told us the billed input; the service charges it instead of an estimate.
      if (sawUsage) failure.partialInputTokens = input + cacheRead + cacheWrite;
      throw failure;
    }
    for (const call of [...finished, ...calls.values()]) if (call.name) yield { type: 'tool_call', call: { ...call, arguments: call.arguments || '{}' } };
    if (sawUsage) {
      yield { type: 'usage', usage: { inputTokens: input + cacheRead + cacheWrite, outputTokens: output, reasoningTokens: 0, cachedTokens: cacheRead, cacheWriteTokens: cacheWrite } };
    }
    yield { type: 'finish', reason: finish };
  }

  async balance(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Turn shapes per protocol.

function openAiMessage(turn: ChatTurn): Record<string, unknown> {
  if (turn.role === 'tool') return { role: 'tool', tool_call_id: turn.toolCallId ?? '', content: turn.content };
  if (turn.role === 'assistant' && turn.toolCalls?.length) {
    return { role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: jsonArguments(call.arguments) } })) };
  }
  if (turn.role === 'user' && (turn.documents?.length || turn.images?.length)) {
    // Images go before the text: NVIDIA's vision models expect that order, and the others accept it.
    return {
      role: 'user',
      content: [
        ...(turn.images ?? []).map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } })),
        { type: 'text', text: turn.content },
        ...(turn.documents ?? []).map(document => ({ type: 'file', file: { filename: document.title, file_data: `data:application/pdf;base64,${document.data}` } }))
      ]
    };
  }
  return { role: turn.role, content: turn.content };
}

/**
 * A call cut off mid-stream (output limit, timeout) keeps broken JSON, and providers refuse the
 * whole history over it. Its tool result already says it failed; the call goes out as `{}`.
 */
function jsonArguments(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? raw : '{}';
  } catch {
    return '{}';
  }
}

type AnthropicBlock = Record<string, unknown>;

/** The Messages API wants alternating user/assistant turns that start with the user; tool results are user turns. */
function anthropicTurns(messages: ChatTurn[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks: AnthropicBlock[] = [];
    if (message.role === 'tool') {
      blocks.push({ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content || '(порожньо)' });
    } else {
      for (const image of message.images ?? []) blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } });
      for (const document of message.documents ?? []) blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: document.data }, title: document.title });
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(call.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: input && typeof input === 'object' ? input : {} });
      }
    }
    if (!blocks.length) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return turns;
}
