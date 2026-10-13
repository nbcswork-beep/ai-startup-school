import type { AiBalanceSource, AiProtocol } from './types.js';

/**
 * Provider adapters. Each one speaks one wire protocol over plain fetch, so any reseller or gateway
 * with its own Base URL works as long as it implements that protocol faithfully.
 */

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  | { type: 'finish'; reason: string | null };

export interface ChatStreamRequest {
  model: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  signal: AbortSignal;
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
  return new AiProviderError(errorCodeForStatus(response.status, safe), safe, response.status);
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
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
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
      const body: Record<string, unknown> = { model: request.model, messages: request.messages, stream: true };
      body[shape.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = request.maxOutputTokens;
      if (shape.streamOptions) body.stream_options = { include_usage: true };
      response = await send(`${this.base}/chat/completions`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: linkSignals(request.signal, REQUEST_TIMEOUT_MS)
      });
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
    try {
      for await (const frame of readSse(response.body, request.signal)) {
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
    // The Messages API wants strictly alternating turns that start with the user.
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      const last = turns[turns.length - 1];
      if (last && last.role === message.role) last.content += `\n\n${message.content}`;
      else turns.push({ role: message.role, content: message.content });
    }
    while (turns[0]?.role === 'assistant') turns.shift();
    const response = await send(`${this.base}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: request.model, max_tokens: request.maxOutputTokens, ...(system ? { system } : {}), messages: turns, stream: true }),
      signal: linkSignals(request.signal, REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw new AiProviderError('invalid_response', 'Провайдер не повернув потік відповіді');

    let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, sawUsage = false;
    let finish: string | null = null;
    try {
      for await (const frame of readSse(response.body, request.signal)) {
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
        } else if (type === 'content_block_delta') {
          if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string' && payload.delta.text) yield { type: 'text', text: payload.delta.text };
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
    if (sawUsage) {
      yield { type: 'usage', usage: { inputTokens: input + cacheRead + cacheWrite, outputTokens: output, reasoningTokens: 0, cachedTokens: cacheRead, cacheWriteTokens: cacheWrite } };
    }
    yield { type: 'finish', reason: finish };
  }

  async balance(): Promise<null> {
    return null;
  }
}
