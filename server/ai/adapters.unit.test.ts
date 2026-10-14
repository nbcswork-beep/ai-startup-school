import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiProviderError, createAdapter, readSse, type ProviderConnection, type StreamEvent } from './adapters.js';
import { MockProviderServer } from './testing/mock-provider.js';
import { SecretBox } from './secret-box.js';
import { validateProviderBaseUrl } from './service.js';

const KEY = 'test-key-1234567890';
let mock: MockProviderServer;

beforeAll(async () => { mock = await new MockProviderServer(KEY).start(); });
afterAll(async () => { await mock.stop(); });

function openai(apiKey = KEY): ProviderConnection {
  return { protocol: 'openai', baseUrl: mock.baseUrl, apiKey, headers: { 'X-Title': 'AI Startup School' } };
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<{ text: string; events: StreamEvent[] }> {
  const events: StreamEvent[] = [];
  let text = '';
  for await (const event of stream) { events.push(event); if (event.type === 'text') text += event.text; }
  return { text, events };
}

describe('provider adapters over HTTP', () => {
  it('streams an OpenAI-compatible answer and reads the reported usage, reasoning and cache included', async () => {
    const { text, events } = await collect(createAdapter(openai()).stream({ model: 'echo-1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Привіт' }], maxOutputTokens: 200, signal: new AbortController().signal }));
    expect(text).toBe('Відповідь: Привіт');
    expect(events.find(event => event.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 120, outputTokens: 30, reasoningTokens: 5, cachedTokens: 20, cacheWriteTokens: 0 } });
    const request = mock.requests.at(-1)!;
    expect(request.body).toMatchObject({ model: 'echo-1', stream: true, max_tokens: 200, stream_options: { include_usage: true } });
    expect(request.headers['x-title']).toBe('AI Startup School');
  });

  it('reports no usage when the provider sends none, so the caller can estimate and flag it', async () => {
    const { text, events } = await collect(createAdapter(openai()).stream({ model: 'no-usage', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 50, signal: new AbortController().signal }));
    expect(text).toBe('Відповідь: x');
    expect(events.some(event => event.type === 'usage')).toBe(false);
  });

  it('switches to max_completion_tokens for models that require it', async () => {
    const { text } = await collect(createAdapter(openai()).stream({ model: 'needs-mct', messages: [{ role: 'user', content: 'ok' }], maxOutputTokens: 64, signal: new AbortController().signal }));
    expect(text).toBe('Відповідь: ok');
    expect(mock.requests.at(-1)!.body).toMatchObject({ max_completion_tokens: 64 });
    expect(mock.requests.at(-1)!.body.max_tokens).toBeUndefined();
  });

  it.each([
    ['fail-401', 'auth', 401], ['fail-429', 'rate_limit', 429], ['fail-500', 'server', 500], ['fail-400', 'bad_request', 400], ['missing-model', 'not_found', 404]
  ])('maps %s to a typed error', async (model, code, status) => {
    const error = await collect(createAdapter(openai()).stream({ model, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, signal: new AbortController().signal })).catch(failure => failure);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ code, status });
  });

  it('never echoes a rejected key back in an error message', async () => {
    const error = await createAdapter(openai('sk-wrongkey-abcdefghijklmnop')).listModels(new AbortController().signal).catch(failure => failure as AiProviderError);
    expect(error).toMatchObject({ code: 'auth', status: 401 });
    expect(error.message).not.toMatch(/sk-abc|xyz1234567890|wrongkey/);
  });

  it('fails a stream that breaks midway, after the text already received', async () => {
    const received: string[] = [];
    const error = await (async () => {
      for await (const event of createAdapter(openai()).stream({ model: 'mid-error', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, signal: new AbortController().signal })) {
        if (event.type === 'text') received.push(event.text);
      }
    })().catch(failure => failure);
    expect(received.join('')).toBe('Початок відповіді, ще трохи…');
    expect(error).toBeInstanceOf(AiProviderError);
  });

  it('stops promptly when the student presses stop', async () => {
    const controller = new AbortController();
    let chunks = 0;
    const error = await (async () => {
      for await (const event of createAdapter(openai()).stream({ model: 'slow', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, signal: controller.signal })) {
        if (event.type === 'text' && (chunks += 1) === 3) controller.abort();
      }
    })().catch(failure => failure);
    expect(error).toMatchObject({ code: 'aborted' });
    expect(chunks).toBe(3);
  });

  it('lists models and reads OpenRouter- and DeepSeek-style balances', async () => {
    const adapter = createAdapter(openai());
    expect((await adapter.listModels(new AbortController().signal)).map(model => model.id)).toContain('echo-1');
    expect(await adapter.balance('openrouter', new AbortController().signal)).toEqual({ amount: 37.5, currency: 'USD' });
    expect(await adapter.balance('deepseek', new AbortController().signal)).toEqual({ amount: 12.34, currency: 'USD' });
    expect(await adapter.balance('none', new AbortController().signal)).toBeNull();
  });

  it('streams an Anthropic Messages answer with input, cache and output usage', async () => {
    const adapter = createAdapter({ protocol: 'anthropic', baseUrl: mock.anthropicBaseUrl, apiKey: KEY, headers: {} });
    const { text, events } = await collect(adapter.stream({ model: 'claude-test', messages: [{ role: 'system', content: 'Будь коротким' }, { role: 'assistant', content: 'привітання' }, { role: 'user', content: 'Як справи?' }], maxOutputTokens: 100, signal: new AbortController().signal }));
    expect(text).toBe('Claude: Як справи?');
    expect(events.find(event => event.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 100, outputTokens: 25, reasoningTokens: 0, cachedTokens: 10, cacheWriteTokens: 0 } });
    const request = mock.requests.at(-1)!;
    expect(request.headers['x-api-key']).toBe(KEY);
    expect(request.body).toMatchObject({ system: 'Будь коротким', max_tokens: 100, messages: [{ role: 'user', content: [{ type: 'text', text: 'Як справи?' }] }] });
    expect((await adapter.listModels(new AbortController().signal))[0]).toMatchObject({ id: 'claude-test', label: 'Claude Test' });
  });

  it('parses server-sent events split across network chunks and CRLF line endings', async () => {
    const encoder = new TextEncoder();
    const parts = ['data: {"a"', ':1}\r\n\r\nevent: x\r\ndata: line1\r\ndata: line2\r\n', '\r\n: comment\n\ndata: [DONE]\n\n'];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); } });
    const frames = [];
    for await (const frame of readSse(body, new AbortController().signal)) frames.push(frame);
    expect(frames).toEqual([{ event: 'message', data: '{"a":1}' }, { event: 'x', data: 'line1\nline2' }, { event: 'message', data: '[DONE]' }]);
  });
});

describe('provider adapters — tool calls', () => {
  const tools = [
    { name: 'read_file', description: 'Read an attached file', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
    { name: 'create_file', description: 'Create a file', parameters: { type: 'object', properties: { format: { type: 'string' } } } }
  ];
  const fileId = '6f1c2a5e-8d4b-4f0a-9c3e-1b2d3e4f5a6b';

  it('OpenAI-compatible: sends tools, assembles streamed call arguments, and replays tool turns', async () => {
    const adapter = createAdapter(openai());
    const first = await collect(adapter.stream({ model: 'agent', messages: [{ role: 'user', content: `Зроби конспект у Word. Файли:\n- «Тема.docx» — id: ${fileId}` }], maxOutputTokens: 300, tools, signal: new AbortController().signal }));
    const call = first.events.find(event => event.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', call: { name: 'read_file', arguments: JSON.stringify({ file: fileId }) } });
    expect(mock.requests.at(-1)!.body.tools[0]).toEqual({ type: 'function', function: tools[0] });
    const id = (call as { call: { id: string } }).call.id;
    const second = await collect(adapter.stream({
      model: 'agent', tools, maxOutputTokens: 300, signal: new AbortController().signal,
      messages: [
        { role: 'user', content: `Зроби конспект у Word. Файли:\n- «Тема.docx» — id: ${fileId}` },
        { role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ file: fileId }) }] },
        { role: 'tool', toolCallId: id, toolName: 'read_file', content: '# Тема\n- Перший пункт' }
      ]
    }));
    expect(second.events.find(event => event.type === 'tool_call')).toMatchObject({ call: { name: 'create_file' } });
    const sent = mock.requests.at(-1)!.body.messages;
    expect(sent[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file: fileId }) } }] });
    expect(sent[2]).toEqual({ role: 'tool', tool_call_id: id, content: '# Тема\n- Перший пункт' });
  });

  it('Anthropic: sends tools as input_schema, assembles tool_use input, and returns results as tool_result blocks', async () => {
    const adapter = createAdapter({ protocol: 'anthropic', baseUrl: mock.anthropicBaseUrl, apiKey: KEY, headers: {} });
    const first = await collect(adapter.stream({ model: 'claude-agent', messages: [{ role: 'system', content: 'Ти агент' }, { role: 'user', content: `Підготуй PDF. id: ${fileId}` }], maxOutputTokens: 300, tools, signal: new AbortController().signal }));
    expect(first.text).toBe('Зараз зроблю це. ');
    const call = first.events.find(event => event.type === 'tool_call') as { call: { id: string; name: string; arguments: string } };
    expect(call.call).toMatchObject({ name: 'read_file', arguments: JSON.stringify({ file: fileId }) });
    expect(mock.requests.at(-1)!.body.tools[0]).toEqual({ name: 'read_file', description: 'Read an attached file', input_schema: tools[0]!.parameters });
    await collect(adapter.stream({
      model: 'claude-agent', tools, maxOutputTokens: 300, signal: new AbortController().signal,
      messages: [
        { role: 'user', content: `Підготуй PDF. id: ${fileId}` },
        { role: 'assistant', content: 'Зараз зроблю це.', toolCalls: [call.call] },
        { role: 'tool', toolCallId: call.call.id, toolName: 'read_file', content: 'текст' },
        { role: 'tool', toolCallId: 'other', toolName: 'read_file', content: 'ще' }
      ]
    }));
    const sent = mock.requests.at(-1)!.body.messages;
    expect(sent[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Зараз зроблю це.' }, { type: 'tool_use', id: call.call.id, name: 'read_file', input: { file: fileId } }] });
    // Consecutive tool results travel in one user turn, as the Messages API requires.
    expect(sent[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.call.id, content: 'текст' }, { type: 'tool_result', tool_use_id: 'other', content: 'ще' }] });
  });

  it('attaches scanned PDFs as documents for models that read them', async () => {
    const adapter = createAdapter({ protocol: 'anthropic', baseUrl: mock.anthropicBaseUrl, apiKey: KEY, headers: {} });
    await collect(adapter.stream({ model: 'claude-test', messages: [{ role: 'user', content: 'Що тут?', documents: [{ title: 'скан.pdf', data: 'JVBERi0=' }] }], maxOutputTokens: 50, signal: new AbortController().signal }));
    expect(mock.requests.at(-1)!.body.messages[0].content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'скан.pdf' });
  });
});

describe('provider configuration safety', () => {
  it('accepts only HTTPS public endpoints outside local development', () => {
    expect(validateProviderBaseUrl('https://openrouter.ai/api/v1/', false)).toBe('https://openrouter.ai/api/v1');
    for (const url of ['http://api.example.com/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://192.168.1.2', 'https://user:pass@api.example.com', 'https://api.example.com/v1?key=1', 'ftp://x']) {
      expect(() => validateProviderBaseUrl(url, false), url).toThrow();
    }
    expect(validateProviderBaseUrl('http://127.0.0.1:4010/v1', true)).toBe('http://127.0.0.1:4010/v1');
  });

  it('seals API keys so the stored value reveals nothing and tampering is detected', () => {
    const box = SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: 'pepper-for-tests', NODE_ENV: 'development' });
    const sealed = box.seal('sk-live-very-secret-key');
    expect(JSON.stringify(sealed)).not.toContain('secret');
    expect(box.open(sealed)).toBe('sk-live-very-secret-key');
    expect(() => box.open({ ...sealed, data: Buffer.from('tampered').toString('base64') })).toThrow();
    const other = SecretBox.fromEnv({ SESSION_TOKEN_PEPPER: 'another-pepper', NODE_ENV: 'development' });
    expect(() => other.open(sealed)).toThrow();
    expect(SecretBox.fromEnv({ NODE_ENV: 'production' }).available).toBe(false);
  });
});
