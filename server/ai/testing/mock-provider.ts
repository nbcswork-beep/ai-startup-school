import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local HTTP server that speaks the OpenAI Chat Completions and Anthropic Messages streaming
 * protocols, for tests and local QA. It is a test double for a third-party API, not an AI: the
 * application talks to it over real HTTP through the same adapters it uses in production.
 *
 * Behaviour is chosen by model id:
 *   echo-*        streams "Відповідь: <last user message>" and reports usage
 *   no-usage      streams text but never reports usage
 *   slow          streams 40 chunks, 40 ms apart (for stop/abort tests)
 *   long          streams 150 chunks, 40 ms apart (background-answer tests); 3 chunks for a short test request
 *   mid-error     streams a few chunks, then fails inside the stream
 *   needs-mct     rejects max_tokens and accepts max_completion_tokens
 *   fail-401 / fail-429 / fail-500 / fail-400   return that HTTP error
 *   claude-*      (Anthropic endpoint) streams with message_start / message_delta usage
 *   agent, claude-agent   a scripted agent: loads a named skill, reads every attached file, looks
 *                 something up when asked, creates the requested file, then answers — one tool per turn
 */

interface Turn { role: string; text: string; toolName?: string }
type Decision = { tool: { name: string; args: Record<string, unknown> } } | { text: string };

/** The scripted agent's next move, from the conversation so far and the tools on offer. */
export function agentDecision(turns: Turn[], tools: string[]): Decision {
  const system = turns.filter(turn => turn.role === 'system').map(turn => turn.text).join('\n');
  const user = [...turns].reverse().find(turn => turn.role === 'user' && !turn.toolName)?.text ?? '';
  const results = turns.filter(turn => turn.role === 'tool');
  const used = (name: string) => results.filter(turn => turn.toolName === name);
  const skill = /«([^»]+)»/.exec(system.split('Навички:')[1] ?? '')?.[1];
  if (tools.includes('use_skill') && skill && !used('use_skill').length && user.toLowerCase().includes(skill.toLowerCase().slice(0, 6))) return { tool: { name: 'use_skill', args: { name: skill } } };
  const ids = [...user.matchAll(/id: ([0-9a-f-]{36})/g)].map(match => match[1]);
  const read = used('read_file').length;
  if (tools.includes('read_file') && read < ids.length) return { tool: { name: 'read_file', args: { file: ids[read] } } };
  if (/вікіпеді/i.test(user) && tools.includes('wikipedia_search') && !used('wikipedia_search').length) return { tool: { name: 'wikipedia_search', args: { query: 'Фотосинтез' } } };
  const lookup = tools.find(name => name.startsWith('lookup_'));
  if (/довідник/i.test(user) && lookup && !used(lookup).length) return { tool: { name: lookup, args: { term: 'фотосинтез' } } };
  const format = /pptx|презентац/i.test(user) ? 'pptx' : /xlsx|excel|таблиц/i.test(user) ? 'xlsx' : /pdf/i.test(user) ? 'pdf' : /docx|word|ворд|доповід|документ/i.test(user) ? 'docx' : null;
  if (format && tools.includes('create_file') && !used('create_file').length) {
    const source = used('read_file').map(turn => turn.text).join('\n');
    const points = source.split('\n').map(line => line.replace(/^[#>\-*\d.\s]+/, '').trim()).filter(line => line && !line.startsWith('|') && !line.startsWith('<!--') && !line.startsWith('Файл «') && !line.startsWith('[') && !line.startsWith('---') && line.length < 120).slice(0, 6);
    const body = format === 'xlsx'
      ? '## Терміни\n\n| Термін | Пояснення |\n| --- | --- |\n' + (points.length ? points : ['Тема']).map((point, index) => `| ${index + 1} | ${point.replace(/\|/g, ' ')} |`).join('\n')
      : '## Головне\n\n' + (points.length ? points : ['Короткий виклад теми']).map(point => `- ${point}`).join('\n') + '\n\n## Висновок\n\nМатеріал опрацьовано.';
    return { tool: { name: 'create_file', args: { name: 'Конспект', format, title: 'Конспект', content: body } } };
  }
  const made = used('create_file')[0]?.text.split('\n')[0] ?? '';
  return { text: made ? `Готово. ${made}` : `Відповідь агента: ${user.slice(0, 80)}` };
}

export interface MockRequestLog {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export const MOCK_USAGE = { input: 120, output: 30, reasoning: 5, cached: 20 };

export class MockProviderServer {
  readonly requests: MockRequestLog[] = [];
  private server: Server | null = null;
  private port = 0;
  private failures: number[] = [];

  /** The next `count` chat requests fail with `status`, whatever the model. */
  failNextChats(status: number, count = 1): void {
    for (let index = 0; index < count; index += 1) this.failures.push(status);
  }

  chatRequests(): MockRequestLog[] {
    return this.requests.filter(request => request.path === '/v1/chat/completions' || request.path === '/v1/messages');
  }

  constructor(private readonly apiKey = 'test-key-1234567890') {}

  get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }
  get anthropicBaseUrl(): string { return `http://127.0.0.1:${this.port}`; }

  async start(port = 0): Promise<this> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>(resolve => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    this.requests.push({ path: url.pathname, method: request.method ?? 'GET', headers: request.headers, body });

    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const bearer = request.headers.authorization === `Bearer ${this.apiKey}`;
    const anthropicKey = request.headers['x-api-key'] === this.apiKey;

    if (url.pathname === '/v1/messages' || (url.pathname === '/v1/models' && request.headers['x-api-key'])) {
      if (!anthropicKey) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (url.pathname === '/v1/models') return json(200, { data: [{ id: 'claude-test', display_name: 'Claude Test', type: 'model' }] });
      return this.anthropic(body, response, json);
    }
    if (url.pathname === '/user/balance') {
      if (!bearer) return json(401, { error: { message: 'Authentication Fails' } });
      return json(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] });
    }
    // A third-party HTTP service for plugin tests: a dictionary behind an API key.
    if (url.pathname === '/dictionary/lookup') {
      if (request.headers['x-api-key'] !== 'dict-secret') return json(401, { error: 'invalid key' });
      return json(200, { term: url.searchParams.get('term'), definition: 'Процес утворення органічних речовин рослинами за участі світла.' });
    }
    if (!url.pathname.startsWith('/v1/')) return json(404, { error: { message: 'not found' } });
    if (!bearer) return json(401, { error: { message: 'Incorrect API key provided: sk-abc...xyz1234567890', type: 'invalid_request_error' } });
    if (url.pathname === '/v1/models') {
      return json(200, { object: 'list', data: ['echo-1', 'echo-2', 'no-usage', 'slow', 'mid-error', 'needs-mct'].map(id => ({ id, object: 'model', name: `Mock ${id}`, context_length: 32000 })) });
    }
    if (url.pathname === '/v1/credits') return json(200, { data: { total_credits: 50, total_usage: 12.5 } });
    if (url.pathname !== '/v1/chat/completions') return json(404, { error: { message: 'not found' } });
    return this.openai(body, response, json);
  }

  private lastUserText(messages: Array<{ role: string; content: unknown }> | undefined): string {
    const last = [...(messages ?? [])].reverse().find(message => message.role === 'user');
    const content = last?.content;
    const text = Array.isArray(content) ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n') : String(content ?? '');
    return text.slice(0, 200);
  }

  /** OpenAI messages as plain turns; a tool turn learns its tool name from the call it answers. */
  private openAiTurns(messages: any[]): Turn[] {
    const names = new Map<string, string>();
    return (messages ?? []).map(message => {
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function?.name);
      const text = Array.isArray(message.content) ? message.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n') : String(message.content ?? '');
      return message.role === 'tool' ? { role: 'tool', text, toolName: names.get(message.tool_call_id) ?? '' } : { role: message.role, text };
    });
  }

  private anthropicTurns(body: any): Turn[] {
    const names = new Map<string, string>();
    const turns: Turn[] = [{ role: 'system', text: String(body?.system ?? '') }];
    for (const message of body?.messages ?? []) {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
      for (const block of blocks) {
        if (block.type === 'tool_use') names.set(block.id, block.name);
        else if (block.type === 'tool_result') turns.push({ role: 'tool', text: String(block.content ?? ''), toolName: names.get(block.tool_use_id) ?? '' });
      }
      const text = blocks.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
      if (text) turns.push({ role: message.role, text });
    }
    return turns;
  }

  private async openai(body: any, response: ServerResponse, json: (status: number, payload: unknown) => void): Promise<void> {
    const model = String(body?.model ?? '');
    const forced = this.failures.shift();
    if (forced) return json(forced, { error: { message: forced === 429 ? 'Rate limit reached for requests' : 'Upstream overloaded' } });
    const failure = /^fail-(\d{3})$/.exec(model);
    if (failure) {
      const status = Number(failure[1]);
      return json(status, { error: { message: status === 429 ? 'Rate limit reached for requests' : status === 400 ? 'Invalid model parameters' : status === 401 ? 'Invalid API key' : 'Upstream overloaded' } });
    }
    if (model === 'needs-mct' && body.max_tokens !== undefined) {
      return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    }
    if (!['echo', 'no-usage', 'slow', 'long', 'mid-error', 'needs-mct', 'agent'].some(prefix => model === prefix || model.startsWith(`${prefix}-`))) {
      return json(404, { error: { message: `The model ${model} does not exist` } });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const delta = (text: string) => send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    if (model === 'agent') {
      const decision = agentDecision(this.openAiTurns(body.messages), (body.tools ?? []).map((tool: any) => tool.function?.name));
      if ('tool' in decision) {
        const args = JSON.stringify(decision.tool.args);
        send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${this.requests.length}`, type: 'function', function: { name: decision.tool.name, arguments: '' } }] }, finish_reason: null }] });
        for (const piece of args.match(/.{1,20}/gsu) ?? [args]) send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] });
        send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: MOCK_USAGE.input, completion_tokens: MOCK_USAGE.output, total_tokens: MOCK_USAGE.input + MOCK_USAGE.output } });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      for (const piece of decision.text.match(/.{1,8}/gsu) ?? [decision.text]) delta(piece);
    } else if (model === 'long') {
      const count = Number(body.max_tokens ?? body.max_completion_tokens ?? 0) <= 64 ? 3 : 150;
      for (let index = 0; index < count && !response.destroyed; index += 1) { delta(`рядок ${index} `); await sleep(40); }
    } else if (model === 'slow') {
      for (let index = 0; index < 40 && !response.destroyed; index += 1) { delta(`частина ${index} `); await sleep(40); }
    } else if (model === 'mid-error') {
      delta('Початок відповіді, ');
      delta('ще трохи…');
      await sleep(10);
      send({ error: { message: 'Upstream connection reset', code: 502 } });
      response.end();
      return;
    } else {
      const text = `Відповідь: ${this.lastUserText(body.messages)}`;
      for (const piece of text.match(/.{1,8}/gsu) ?? [text]) delta(piece);
    }
    send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (model !== 'no-usage' && body.stream_options?.include_usage) {
      send({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [],
        usage: { prompt_tokens: MOCK_USAGE.input, completion_tokens: MOCK_USAGE.output, total_tokens: MOCK_USAGE.input + MOCK_USAGE.output, prompt_tokens_details: { cached_tokens: MOCK_USAGE.cached }, completion_tokens_details: { reasoning_tokens: MOCK_USAGE.reasoning } }
      });
    }
    response.write('data: [DONE]\n\n');
    response.end();
  }

  private anthropic(body: any, response: ServerResponse, json: (status: number, payload: unknown) => void): void {
    if (!String(body?.model ?? '').startsWith('claude')) return json(404, { type: 'error', error: { type: 'not_found_error', message: `model: ${body?.model}` } });
    if (!body?.max_tokens) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: Field required' } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: string, payload: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 90, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 } } });
    if (body.model === 'claude-agent') {
      const decision = agentDecision(this.anthropicTurns(body), (body.tools ?? []).map((tool: any) => tool.name));
      if ('tool' in decision) {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Зараз зроблю це. ' } });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu_${this.requests.length}`, name: decision.tool.name, input: {} } });
        const args = JSON.stringify(decision.tool.args);
        for (const piece of args.match(/.{1,20}/gsu) ?? [args]) send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: piece } });
        send('content_block_stop', { type: 'content_block_stop', index: 1 });
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } });
        send('message_stop', { type: 'message_stop' });
        response.end();
        return;
      }
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of decision.text.match(/.{1,8}/gsu) ?? [decision.text]) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } });
      send('message_stop', { type: 'message_stop' });
      response.end();
      return;
    }
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const text = `Claude: ${this.lastUserText(body.messages)}`;
    for (const piece of text.match(/.{1,8}/gsu) ?? [text]) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } });
    send('message_stop', { type: 'message_stop' });
    response.end();
  }
}
