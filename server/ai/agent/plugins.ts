import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AiFileRef, AiPluginManifest, AiPluginPermission, AiPluginRecord, AiStep, AiToolManifest } from '../types.js';

/**
 * Plugins give the agent tools. Every tool, built-in or imported, goes through the same interface:
 * a name, a description and a JSON Schema for the model, a permission, and a run function. The agent
 * core only knows this interface, so adding a plugin never changes the core.
 *
 * Safety rules live here, not in prompts:
 * - the set of tools in a run comes from the school's configuration, never from documents or chat text;
 * - anything with the `network` permission asks the student before data leaves the school;
 * - secrets are opened on the server only for the request that needs them.
 */

export interface ToolOutcome {
  /** What the model reads back. */
  content: string;
  status?: 'done' | 'error' | 'declined';
  /** A short line under the step for the student. */
  detail?: string;
  /** A clearer step label once the tool knows more (the file's name, say). */
  label?: string;
  file?: AiFileRef;
  /** The result was checked after it was made; shown as its own step. */
  check?: { ok: boolean; detail: string };
}

export interface ToolContext {
  createProject?(args: Record<string, unknown>): Promise<ToolOutcome>;
  readProject?(args: Record<string, unknown>): Promise<ToolOutcome>;
  writeProject?(args: Record<string, unknown>): Promise<ToolOutcome>;
  appendProject?(args: Record<string, unknown>): Promise<ToolOutcome>;
  publishProject?(id: string): Promise<{ url: string }>;
  readFile(fileId: string, from: number): Promise<ToolOutcome>;
  /** Display name of an attached file, for step labels. */
  fileName(fileId: string): string | null;
  createFile(input: { name: string; format: string; title: string; content: string }): Promise<ToolOutcome>;
  useSkill(name: string): Promise<ToolOutcome>;
  /** Plugin settings and opened secrets for this tool's plugin. */
  settings: Record<string, string | number | boolean>;
  secret(key: string): string | null;
  fetch: typeof fetch;
  allowLocalUrls: boolean;
  signal: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  pluginId: string;
  pluginName: string;
  permission: AiPluginPermission;
  /** The visible step: what the student sees while this runs. */
  step(args: Record<string, unknown>, context: ToolContext): { kind: AiStep['kind']; label: string };
  /** For network tools: what will be sent where, shown before the student confirms. */
  disclosure?(args: Record<string, unknown>, context: ToolContext): { title: string; details: string };
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

const str = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';

// ---------------------------------------------------------------------------------------------
// Built-in plugins

interface BuiltinPlugin {
  manifest: AiPluginManifest;
  /** Core plugins are always on and cannot be removed. */
  core: boolean;
  /** Installed for a new school without the admin doing anything. */
  preinstalled: boolean;
  tools(manifest: AiPluginManifest): AgentTool[];
}

const documents: BuiltinPlugin = {
  core: true,
  preinstalled: true,
  manifest: {
    id: 'documents', name: 'Документи', version: '1.0.0',
    description: 'Читання прикріплених файлів (PDF, Word, Excel, CSV, PowerPoint, TXT, Markdown) і створення нових документів.',
    permissions: ['files:read', 'files:write'], settings: [], secrets: [],
    tools: [
      { name: 'read_file', description: 'Прочитати прикріплений учнем файл за його id. Повертає вміст як Markdown (заголовки, списки, таблиці). Довгі файли читай частинами через параметр from.', parameters: { type: 'object', properties: { file: { type: 'string', description: 'id файлу зі списку прикріплених' }, from: { type: 'integer', minimum: 0, description: 'з якого символу читати (для довгих файлів)' } }, required: ['file'] } },
      { name: 'create_file', description: 'Створити справжній файл для учня: docx (Word), pdf, pptx (PowerPoint), xlsx (Excel), csv, md або txt. Вміст пиши Markdown: # і ## заголовки, списки, таблиці. Для pptx кожен слайд — «## Заголовок» і пункти; для xlsx/csv — Markdown-таблиці (кожна таблиця — аркуш, назва аркуша — заголовок над таблицею). Файл зʼявиться в чаті з кнопкою завантаження.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'назва файлу без розширення' }, format: { type: 'string', enum: ['docx', 'pdf', 'pptx', 'xlsx', 'csv', 'md', 'txt'] }, title: { type: 'string', description: 'заголовок документа' }, content: { type: 'string', description: 'вміст у Markdown (або CSV для таблиць)' } }, required: ['name', 'format', 'content'] } }
    ]
  },
  tools: manifest => [
    {
      ...toolBase(manifest, 'read_file'), permission: 'files:read',
      step: (args, context) => ({ kind: 'read', label: `Читаю «${context.fileName(str(args.file, 64)) ?? 'файл'}»` }),
      run: (args, context) => context.readFile(str(args.file, 64), Math.max(0, Number(args.from) || 0))
    },
    {
      ...toolBase(manifest, 'create_file'), permission: 'files:write',
      step: args => ({ kind: 'create', label: `Створюю «${(str(args.name, 80) || 'документ').replace(/\.[a-z0-9]+$/i, '')}.${str(args.format, 8) || 'docx'}»` }),
      run: (args, context) => context.createFile({ name: str(args.name, 120), format: str(args.format, 8), title: str(args.title, 200), content: typeof args.content === 'string' ? args.content : '' })
    }
  ]
};

const skills: BuiltinPlugin = {
  core: true,
  preinstalled: true,
  manifest: {
    id: 'skills', name: 'Навички', version: '1.0.0',
    description: 'Дає агенту увімкнені навички школи: він сам обирає потрібну за умовами застосування.',
    permissions: [], settings: [], secrets: [],
    tools: [{ name: 'use_skill', description: 'Завантажити інструкції навички зі списку «Навички» в системних правилах, коли завдання відповідає її умовам застосування. Виконуй завантажені інструкції.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'назва навички' } }, required: ['name'] } }]
  },
  tools: manifest => [{
    ...toolBase(manifest, 'use_skill'), permission: 'compute',
    step: args => ({ kind: 'skill', label: `Застосовую навичку «${str(args.name, 60)}»` }),
    run: (args, context) => context.useSkill(str(args.name, 60))
  }]
};

const calculator: BuiltinPlugin = {
  core: false,
  preinstalled: true,
  manifest: {
    id: 'calculator', name: 'Калькулятор', version: '1.0.0',
    description: 'Точні обчислення: дужки, степені, корені, тригонометрія, логарифми. Працює на сервері, нічого не надсилає назовні.',
    permissions: ['compute'], settings: [], secrets: [],
    tools: [{ name: 'calculate', description: 'Обчислити математичний вираз точно. Підтримує + - * / ^ %, дужки, sqrt, sin, cos, tan (радіани), log (десятковий), ln, abs, round, floor, ceil, pi, e.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } }]
  },
  tools: manifest => [{
    ...toolBase(manifest, 'calculate'), permission: 'compute',
    step: args => ({ kind: 'tool', label: `Обчислюю ${str(args.expression, 60)}` }),
    async run(args) {
      try {
        const value = evaluate(str(args.expression, 300));
        const shown = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
        return { content: `${str(args.expression, 300)} = ${shown}`, detail: `= ${shown}` };
      } catch (error) {
        return { content: `Помилка обчислення: ${error instanceof Error ? error.message : 'невідома'}`, status: 'error', detail: 'Вираз не вдалося обчислити' };
      }
    }
  }]
};

const wikipedia: BuiltinPlugin = {
  core: false,
  preinstalled: false,
  manifest: {
    id: 'wikipedia', name: 'Вікіпедія', version: '1.0.0',
    description: 'Пошук коротких довідок у Вікіпедії. Перед кожним запитом агент питає дозволу учня, бо запит іде на зовнішній сайт.',
    permissions: ['network'], settings: [{ key: 'language', label: 'Мова Вікіпедії', type: 'select', options: ['uk', 'en', 'pl', 'de'], default: 'uk' }], secrets: [],
    tools: [{ name: 'wikipedia_search', description: 'Знайти у Вікіпедії статті за запитом і повернути короткі описи з посиланнями. Надсилає лише текст запиту.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]
  },
  tools: manifest => [{
    ...toolBase(manifest, 'wikipedia_search'), permission: 'network',
    step: args => ({ kind: 'tool', label: `Шукаю у Вікіпедії: «${str(args.query, 60)}»` }),
    disclosure: (args, context) => ({ title: 'Запит до Вікіпедії', details: `Буде надіслано текст запиту «${str(args.query, 200)}» на ${wikiHost(context)}. Більше нічого з чату не передається.` }),
    async run(args, context) {
      const query = str(args.query, 200).trim();
      if (!query) return { content: 'Порожній запит.', status: 'error' };
      const host = wikiHost(context);
      const search = await fetchJson(context, `https://${host}/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '3', format: 'json', utf8: '1' })}`);
      const titles: string[] = (search?.query?.search ?? []).map((item: { title?: string }) => String(item.title ?? '')).filter(Boolean);
      if (!titles.length) return { content: `У Вікіпедії нічого не знайдено за запитом «${query}».`, detail: 'Нічого не знайдено' };
      const summaries: string[] = [];
      for (const title of titles) {
        const page = await fetchJson(context, `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`).catch(() => null);
        if (page?.extract) summaries.push(`## ${title}\n${String(page.extract).slice(0, 1500)}\nДжерело: https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`);
      }
      return { content: summaries.join('\n\n') || titles.join(', '), detail: `Знайдено: ${titles.join(', ').slice(0, 120)}` };
    }
  }]
};

function wikiHost(context: ToolContext): string {
  const language = String(context.settings.language ?? 'uk');
  return `${['uk', 'en', 'pl', 'de'].includes(language) ? language : 'uk'}.wikipedia.org`;
}

async function fetchJson(context: ToolContext, url: string): Promise<any> {
  const response = await context.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'AI-Startup-School-Agent/1.0' }, signal: AbortSignal.any([context.signal, AbortSignal.timeout(12_000)]), redirect: 'error' });
  if (!response.ok) throw new PluginError(`Сервіс відповів помилкою ${response.status}`);
  return response.json();
}

const projects: BuiltinPlugin = {
  core: true, preinstalled: true,
  manifest: {
    id: 'projects', name: 'Сайти та код', version: '1.2.0',
    description: 'Створення проєктів ZIP, статичних HTML/CSS/JS сайтів та статей блогу. Публікація після підтвердження учня.',
    permissions: ['files:read', 'files:write', 'network'], settings: [], secrets: [],
    tools: [
      { name: 'append_project_file', description: 'Дописати короткий фрагмент у кінець файлу, не переписуючи збережений початок. Перед цим read_project: список дає chars та incomplete; прочитай кінець файлу через from=max(0,chars-2000). offset має точно дорівнювати chars. content — лише НОВИЙ текст (бажано до 4000 символів). complete=false якщо будеш ще дописувати; complete=true в останній частині, тоді файл перевіряється. Сайт з незавершеними файлами опублікувати не можна.', parameters: { type: 'object', properties: { projectId: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, content: { type: 'string', maxLength: 16000 }, complete: { type: 'boolean' } }, required: ['projectId', 'path', 'offset', 'content', 'complete'] } },
      { name: 'create_project', description: 'Створити проєкт: website — статичний сайт з index.html; code — вихідний код (ZIP, без запуску). Сайт будуй частинами, щоб кожен крок зберігся і не обірвався за лімітом часу: спочатку create_project з index.html і styles.css (до ~15 000 символів), потім додавай сторінки, скрипти й статті через write_project_files по 1–3 файли за виклик. З projectId повністю замінює файли існуючого проєкту (спочатку read_project); для часткових змін використовуй write_project_files. Всі посилання відносні. Зовнішні JS CDN, fetch, серверні API, форми та localStorage у перегляді недоступні. Статті SEO створюй як blog/slug.html з навігацією. Чернетка не публікується автоматично.', parameters: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['website', 'code'] }, projectId: { type: 'string', description: 'id існуючого власного проєкту для оновлення' }, files: { type: 'array', maxItems: 60, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }, required: ['title', 'kind', 'files'] } },
      { name: 'write_project_files', description: 'Дописати або замінити 1–3 файли в збереженій чернетці проєкту projectId; решта файлів лишається. remove — шляхи файлів, які треба видалити. Так будуй сайт частинами і додавай статті: кожен виклик одразу зберігається. У чернетці можна посилатися на сторінки, які ще допишеш, але до публікації всі файли мають існувати.', parameters: { type: 'object', properties: { projectId: { type: 'string' }, files: { type: 'array', maxItems: 5, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, remove: { type: 'array', maxItems: 20, items: { type: 'string' } } }, required: ['projectId'] } },
      { name: 'read_project', description: 'Прочитати власний збережений проєкт. Без path — список файлів; з path — текст файлу (частинами через from). Завжди читай існуючий сайт перед додаванням SEO-статей, збережи його дизайн та файли.', parameters: { type: 'object', properties: { projectId: { type: 'string' }, path: { type: 'string' }, from: { type: 'integer', minimum: 0 } }, required: ['projectId'] } },
      { name: 'publish_project', description: 'Опублікувати збережений website за стабільним публічним посиланням або оновити його опубліковану версію. Викликай лише коли учень просить публікацію. Учень окремо підтвердить відкритий доступ до ВСІХ сторінок. Не публікуй особисті дані, секрети та чужі матеріали.', parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } }
    ]
  },
  tools: manifest => [
    { ...toolBase(manifest, 'append_project_file'), permission: 'files:write', step: () => ({ kind: 'create', label: 'Дописую файл' }), run: (args, context) => context.appendProject!(args) },
    { ...toolBase(manifest, 'create_project'), permission: 'files:write', step: () => ({ kind: 'create', label: 'Збираю проєкт' }), run: (args, context) => context.createProject!(args) },
    { ...toolBase(manifest, 'write_project_files'), permission: 'files:write', step: args => ({ kind: 'create', label: `Дописую ${projectPaths(args) || 'проєкт'}` }), run: (args, context) => context.writeProject!(args) },
    { ...toolBase(manifest, 'read_project'), permission: 'files:read', step: () => ({ kind: 'read', label: 'Читаю проєкт' }), run: (args, context) => context.readProject!(args) },
    { ...toolBase(manifest, 'publish_project'), permission: 'network', step: () => ({ kind: 'tool', label: 'Публікую сайт' }),
      disclosure: () => ({ title: 'Опублікувати сайт?', details: 'Усі сторінки та файли обраного проєкту стануть доступні кожному за посиланням. Статті можуть індексуватися пошуковиками. Перевірте чернетку та відсутність особистих даних. Оновлення замінить попередню публічну версію.' }),
      run: async (args, context) => { const result = await context.publishProject!(str(args.projectId, 64)); return { content: `Сайт опубліковано: ${result.url}. Це реальне посилання, поверни його учню.`, detail: 'Сайт доступний за посиланням' }; }
    }
  ]
};

function projectPaths(args: Record<string, unknown>): string {
  const paths = Array.isArray(args.files) ? args.files.map(file => str((file as { path?: unknown } | null)?.path, 80)).filter(Boolean) : [];
  return paths.length > 3 ? `${paths.slice(0, 3).join(', ')} та ще ${paths.length - 3}` : paths.join(', ');
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = { documents, skills, projects, calculator, wikipedia };

function toolBase(manifest: AiPluginManifest, name: string): Pick<AgentTool, 'name' | 'description' | 'parameters' | 'pluginId' | 'pluginName'> {
  const tool = manifest.tools.find(item => item.name === name)!;
  return { name: tool.name, description: tool.description, parameters: tool.parameters, pluginId: manifest.id, pluginName: manifest.name };
}

// ---------------------------------------------------------------------------------------------
// Imported plugins: a manifest describes an HTTPS service and its tools. A generic runner calls it.

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{1,47}$/;
const MAX_RESPONSE_CHARS = 12_000;

export function validateManifest(input: unknown): AiPluginManifest {
  const fail = (message: string): never => { throw new PluginError(message); };
  if (!input || typeof input !== 'object') fail('Маніфест має бути обʼєктом JSON.');
  const raw = input as Record<string, any>;
  const id = String(raw.id ?? '');
  if (!PLUGIN_ID.test(id)) fail('id плагіна: латинські літери, цифри й дефіс, 2–40 символів.');
  if (BUILTIN_PLUGINS[id]) fail(`id «${id}» зайнятий вбудованим плагіном.`);
  const name = String(raw.name ?? '').trim().slice(0, 60) || fail('Вкажіть name.');
  const version = String(raw.version ?? '').trim();
  if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version)) fail('version має бути у форматі 1.0.0.');
  const description = String(raw.description ?? '').trim().slice(0, 400);
  const permissions = Array.isArray(raw.permissions) ? raw.permissions.map(String) : [];
  const allowed: AiPluginPermission[] = ['network', 'compute'];
  if (permissions.some((item: string) => !allowed.includes(item as AiPluginPermission))) fail('Імпортовані плагіни можуть мати лише дозволи network і compute.');
  if (!permissions.includes('network')) permissions.push('network');
  const baseUrl = String(raw.baseUrl ?? '').trim();
  let parsed: URL | null = null;
  try { parsed = new URL(baseUrl); } catch { fail('baseUrl має бути повною адресою https://…'); }
  if (parsed!.username || parsed!.password || parsed!.search || parsed!.hash) fail('baseUrl не може містити логін, пароль, параметри чи #.');
  if (!['https:', 'http:'].includes(parsed!.protocol)) fail('baseUrl має бути https://.');
  const settings = (Array.isArray(raw.settings) ? raw.settings : []).slice(0, 10).map((setting: any) => {
    const key = String(setting?.key ?? '');
    if (!/^[a-zA-Z][\w]{0,30}$/.test(key)) fail(`Некоректний ключ налаштування «${key}».`);
    const type = ['text', 'number', 'boolean', 'select'].includes(setting?.type) ? setting.type : 'text';
    return { key, label: String(setting?.label ?? key).slice(0, 80), type, ...(type === 'select' ? { options: (Array.isArray(setting?.options) ? setting.options : []).map(String).slice(0, 20) } : {}), ...(setting?.default !== undefined ? { default: setting.default } : {}) };
  });
  const secrets = (Array.isArray(raw.secrets) ? raw.secrets : []).slice(0, 5).map((secret: any) => {
    const key = String(secret?.key ?? '');
    if (!/^[a-zA-Z][\w]{0,30}$/.test(key)) fail(`Некоректний ключ секрету «${key}».`);
    const header = secret?.header ? String(secret.header) : 'Authorization';
    if (!/^[A-Za-z0-9-]{1,40}$/.test(header) || ['host', 'cookie', 'content-length', 'transfer-encoding', 'connection'].includes(header.toLowerCase())) fail(`Заголовок «${header}» не можна використовувати.`);
    return { key, label: String(secret?.label ?? key).slice(0, 80), header };
  });
  const tools: AiToolManifest[] = (Array.isArray(raw.tools) ? raw.tools : []).slice(0, 10).map((tool: any) => {
    const toolName = String(tool?.name ?? '');
    if (!TOOL_NAME.test(toolName)) fail(`Назва інструмента «${toolName}»: малі латинські літери, цифри й _.`);
    if (['read_file', 'create_file', 'use_skill', 'create_project', 'write_project_files', 'append_project_file', 'read_project', 'publish_project'].includes(toolName)) fail(`Назва «${toolName}» зарезервована.`);
    const method = String(tool?.http?.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) fail('http.method: GET або POST.');
    const path = String(tool?.http?.path ?? '/');
    if (!path.startsWith('/') || path.includes('..') || /[\s#?]/.test(path.replace(/\{[a-zA-Z_]\w*\}/g, ''))) fail(`Некоректний шлях «${path}».`);
    const parameters = tool?.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} };
    if (parameters.type !== 'object') fail(`Параметри «${toolName}» мають бути обʼєктом JSON Schema.`);
    if (JSON.stringify(parameters).length > 4000) fail(`Схема параметрів «${toolName}» завелика.`);
    return { name: toolName, description: String(tool?.description ?? '').trim().slice(0, 500) || fail(`Опишіть інструмент «${toolName}».`), parameters, http: { method: method as 'GET' | 'POST', path } };
  });
  if (!tools.length) fail('Плагін має містити хоча б один інструмент.');
  return { id, name, version, description, permissions: permissions as AiPluginPermission[], settings, secrets, baseUrl: parsed!.origin + parsed!.pathname.replace(/\/+$/, ''), tools };
}

function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:') && isPrivateAddress(lower.slice(7)) || lower === '::';
  }
  const [a, b] = address.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** HTTPS to a public host only; local addresses only on a developer machine. */
async function checkDestination(url: URL, allowLocal: boolean): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (allowLocal && local) return;
  if (url.protocol !== 'https:') throw new PluginError('Плагін може звертатися лише до https-адрес.');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(entry => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new PluginError('Адреса плагіна веде у внутрішню мережу — запит заблоковано.');
}

function httpTools(record: AiPluginRecord): AgentTool[] {
  const manifest = record.manifest!;
  return manifest.tools.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters, pluginId: manifest.id, pluginName: manifest.name, permission: 'network' as const,
    step: () => ({ kind: 'tool' as const, label: `${manifest.name}: ${tool.name}` }),
    disclosure: (args: Record<string, unknown>) => ({
      title: `Запит до «${manifest.name}»`,
      details: `Буде надіслано на ${new URL(manifest.baseUrl!).host}: ${JSON.stringify(args).slice(0, 400)}`
    }),
    async run(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
      const used = new Set<string>();
      const path = tool.http!.path.replace(/\{([a-zA-Z_]\w*)\}/g, (_match, key: string) => { used.add(key); return encodeURIComponent(String(args[key] ?? '')); });
      const url = new URL(`${manifest.baseUrl}${path}`);
      const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !used.has(key)));
      if (tool.http!.method === 'GET') for (const [key, value] of Object.entries(rest)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      await checkDestination(url, context.allowLocalUrls);
      const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9', 'user-agent': 'AI-Startup-School-Agent/1.0' };
      for (const secret of manifest.secrets) {
        const value = context.secret(secret.key);
        if (value) headers[(secret.header ?? 'Authorization').toLowerCase()] = value;
      }
      if (tool.http!.method === 'POST') headers['content-type'] = 'application/json';
      const response = await context.fetch(url, { method: tool.http!.method, headers, ...(tool.http!.method === 'POST' ? { body: JSON.stringify(rest) } : {}), signal: AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]), redirect: 'error' });
      const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
      if (!response.ok) return { content: `Сервіс відповів помилкою ${response.status}: ${text.slice(0, 300)}`, status: 'error', detail: `Помилка ${response.status}` };
      return { content: text || '(порожня відповідь)', detail: `Відповідь отримано (${text.length} символів)` };
    }
  }));
}

/** Plugins as the admin sees them: built-ins (installed or not) and imported ones. */
export function pluginCatalog(records: AiPluginRecord[]): Array<{ manifest: AiPluginManifest; core: boolean; builtin: boolean; record: AiPluginRecord | null }> {
  const byId = new Map(records.map(record => [record.id, record]));
  const builtins = Object.values(BUILTIN_PLUGINS).map(plugin => ({ manifest: plugin.manifest, core: plugin.core, builtin: true, record: byId.get(plugin.manifest.id) ?? null }));
  const imported = records.filter(record => record.source === 'manifest' && record.manifest).map(record => ({ manifest: record.manifest!, core: false, builtin: false, record }));
  return [...builtins, ...imported];
}

/** Built-in plugins a school has before the admin changes anything. */
export function defaultPluginRecords(now: string): AiPluginRecord[] {
  return Object.values(BUILTIN_PLUGINS).filter(plugin => plugin.preinstalled).map(plugin => ({
    id: plugin.manifest.id, source: 'builtin', manifest: null, enabled: true,
    settings: Object.fromEntries(plugin.manifest.settings.flatMap(setting => setting.default === undefined ? [] : [[setting.key, setting.default]])),
    secrets: {}, installedAt: now, updatedAt: now
  }));
}

/** The tools of every enabled plugin. Core plugins are always on. */
export function enabledTools(records: AiPluginRecord[]): Array<{ tool: AgentTool; record: AiPluginRecord }> {
  const out: Array<{ tool: AgentTool; record: AiPluginRecord }> = [];
  const byId = new Map(records.map(record => [record.id, record]));
  for (const plugin of Object.values(BUILTIN_PLUGINS)) {
    const record = byId.get(plugin.manifest.id) ?? (plugin.core ? { id: plugin.manifest.id, source: 'builtin' as const, manifest: null, enabled: true, settings: {}, secrets: {}, installedAt: '', updatedAt: '' } : null);
    if (!record || !(record.enabled || plugin.core)) continue;
    for (const tool of plugin.tools(plugin.manifest)) out.push({ tool, record });
  }
  for (const record of records) {
    if (record.source !== 'manifest' || !record.enabled || !record.manifest) continue;
    for (const tool of httpTools(record)) out.push({ tool, record });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The calculator: a small recursive-descent parser. Nothing is ever passed to eval.

export function evaluate(expression: string): number {
  const source = expression.replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '.').replace(/\s+/g, '');
  if (!source || source.length > 300) throw new Error('порожній або задовгий вираз');
  let index = 0;
  const functions: Record<string, (value: number) => number> = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, lg: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, exp: Math.exp };
  const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
  const peek = () => source[index];
  const expect = (char: string) => { if (source[index] !== char) throw new Error(`очікувалось «${char}»`); index += 1; };
  const primary = (): number => {
    const char = peek();
    if (char === '(') { index += 1; const value = sum(); expect(')'); return value; }
    if (char === '-') { index += 1; return -power(); }
    if (char === '+') { index += 1; return power(); }
    const number = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(source.slice(index));
    if (number) { index += number[0].length; return Number(number[0]); }
    const word = /^[a-z]+/i.exec(source.slice(index));
    if (word) {
      const name = word[0].toLowerCase();
      index += word[0].length;
      if (functions[name]) { expect('('); const value = sum(); expect(')'); return functions[name]!(value); }
      if (constants[name] !== undefined) return constants[name]!;
      throw new Error(`невідома функція «${word[0]}»`);
    }
    throw new Error('неочікуваний символ');
  };
  const power = (): number => {
    let value = primary();
    while (peek() === '%') { index += 1; value /= 100; }
    if (peek() === '^') { index += 1; value = value ** power(); }
    return value;
  };
  const product = (): number => {
    let value = power();
    while (peek() === '*' || peek() === '/') {
      const operator = source[index++];
      const right = power();
      if (operator === '/' && right === 0) throw new Error('ділення на нуль');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') { const operator = source[index++]; const right = product(); value = operator === '+' ? value + right : value - right; }
    return value;
  };
  const result = sum();
  if (index !== source.length) throw new Error('зайві символи у виразі');
  if (!Number.isFinite(result)) throw new Error('результат не є скінченним числом');
  return result;
}
