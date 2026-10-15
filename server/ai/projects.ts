import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { posix } from 'node:path';
import { AppError } from '../errors/app-error.js';
import type { AiGeneratedFile, AiJob } from './types.js';
import type { AiStore } from './store.js';
import type { ToolOutcome } from './agent/plugins.js';
import { createZip } from './zip.js';

export interface ProjectFile { path: string; content: string }
export interface ProjectSource { kind: 'website' | 'code'; files: ProjectFile[] }
const MAX_SOURCE_BYTES = 300_000;
const TEXT_EXTENSION = /\.(?:html|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|xml|svg|py|sql|ya?ml)$/i;
const SITE_EXTENSION = /\.(?:html|css|js|mjs|json|txt|xml|svg)$/i;

export function safeProjectPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 180 && /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'))
    && TEXT_EXTENSION.test(path) && !/(?:^|\/)(?:secrets?|credentials?|id_rsa)(?:[./]|$)/i.test(path);
}

export function parseProject(raw: unknown): ProjectSource {
  if (!raw || typeof raw !== 'object') throw new Error('Проєкт має містити kind та files.');
  const input = raw as Record<string, unknown>;
  if (input.kind !== 'website' && input.kind !== 'code') throw new Error('kind: website або code.');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 60) throw new Error('У проєкті має бути від 1 до 60 текстових файлів.');
  const paths = new Set<string>();
  let bytes = 0;
  const files = input.files.map((file: unknown) => {
    const item = file as Partial<ProjectFile> | null;
    if (!item || !safeProjectPath(item.path) || typeof item.content !== 'string' || item.content.includes('\0')) throw new Error('Некоректний шлях або вміст файлу. Використовуй відносні шляхи без .., прихованих файлів та секретів.');
    const lower = item.path.toLowerCase();
    if (paths.has(lower)) throw new Error(`Повторний шлях: ${item.path}`);
    paths.add(lower);
    bytes += Buffer.byteLength(item.content);
    if (bytes > MAX_SOURCE_BYTES) throw new Error('Проєкт завеликий: максимум 300 КБ тексту.');
    if (input.kind === 'website' && !SITE_EXTENSION.test(item.path)) throw new Error('Опублікований сайт підтримує HTML, CSS, JS та статичні ресурси. Для React/Node/Python обери kind=code і додай README з командами запуску.');
    return { path: item.path, content: item.content };
  });
  if (input.kind === 'website' && !paths.has('index.html')) throw new Error('Сайту потрібен index.html у корені.');
  return { kind: input.kind, files };
}

export function projectFromContent(content: string): ProjectSource { return parseProject(JSON.parse(content)); }
export function projectZip(content: string): Buffer { return createZip(projectFromContent(content).files, new Date('2026-01-01T00:00:00Z')); }

/** Structural checks only: generated programs are never executed in the school's backend. */
export function checkProject(project: ProjectSource): string[] {
  const problems: string[] = [];
  const paths = new Set(project.files.map(file => file.path));
  for (const file of project.files) {
    if (/\.html$/i.test(file.path)) {
      if (!/<title>[^<]+<\/title>/i.test(file.content)) problems.push(`${file.path}: додай title`);
      if (!/<meta\s+[^>]*name\s*=\s*["']viewport["']/i.test(file.content)) problems.push(`${file.path}: додай viewport`);
      for (const match of file.content.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
        const href = match[1]!;
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) continue;
        if (href.startsWith('/')) { problems.push(`${file.path}: посилання ${href} має бути відносним`); continue; }
        const target = href.split(/[?#]/)[0]!;
        if (!target) continue;
        let resolved = posix.normalize(posix.join(posix.dirname(file.path), target));
        if (target.endsWith('/')) resolved += '/index.html';
        if (!paths.has(resolved)) problems.push(`${file.path}: не знайдено ${target}`);
      }
      if (/<script\b[^>]*src\s*=\s*["'](?:https?:)?\/\//i.test(file.content)) problems.push(`${file.path}: зовнішні JS-бібліотеки не працюють у захищеному перегляді; додай локальний JS`);
      for (const match of file.content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\b(?:src|type)\s*=/i.test(match[1]!)) continue;
        try { new Script(match[2]!, { filename: file.path }); } catch { problems.push(`${file.path}: синтаксична помилка у script`); }
      }
    }
    if (/\.(?:js|cjs)$/i.test(file.path) && !/^\s*(?:import|export)\b/m.test(file.content)) {
      try { new Script(file.content, { filename: file.path }); } catch { problems.push(`${file.path}: синтаксична помилка JavaScript`); }
    }
  }
  return [...new Set(problems)].slice(0, 20);
}

function projectPreview(project: ProjectSource): AiGeneratedFile['preview'] {
  return { kind: 'project', projectKind: project.kind, items: project.files.map(file => file.path) };
}

export class StudentProjects {
  constructor(private store: AiStore, private now: () => Date) {}

  async owned(studentId: string, id: string): Promise<AiGeneratedFile> {
    const record = await this.store.getGeneratedFile(id);
    if (!record || record.format !== 'project' || record.studentId !== studentId) throw new AppError('AI_PROJECT_NOT_FOUND', 404, 'Проєкт не знайдено');
    return record;
  }

  async create(job: AiJob, args: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      if (job.files.length >= 6) throw new Error('За одне завдання можна створити до 6 файлів/проєктів.');
      const previous = typeof args.projectId === 'string' && args.projectId ? await this.owned(job.studentId, args.projectId) : null;
      const source = parseProject(args);
      const problems = checkProject(source);
      if (problems.length) return { status: 'error', content: `Проєкт не збережено. Виправ і повтори create_project:\n${problems.join('\n')}`, check: { ok: false, detail: problems.join('; ').slice(0, 250) } };
      const title = String(args.title || previous?.title || 'Мій проєкт').slice(0, 100);
      const content = JSON.stringify(source);
      const record: AiGeneratedFile = {
        id: previous?.id ?? randomUUID(), studentId: job.studentId, conversationId: job.conversationId,
        name: `${title.replace(/[^\p{L}\p{N}_ -]/gu, '').trim() || 'project'}.zip`, title, format: 'project',
        content, size: projectZip(content).length, preview: projectPreview(source), createdAt: this.now().toISOString(),
        ...(previous?.publishedContent ? { publishedContent: previous.publishedContent, publishedAt: previous.publishedAt } : {})
      };
      await this.store.putGeneratedFile(record);
      return {
        content: `Чернетку проєкту збережено. projectId=${record.id}. Файли: ${source.files.map(f => f.path).join(', ')}. ZIP та захищений перегляд доступні в чаті. Публікація — окрема дія publish_project; попередня опублікована версія не змінена. Перевірено структуру, локальні HTML-посилання і синтаксис звичайного JS; браузерний запуск та модульний JS не перевірялися.`,
        label: `Збережено «${title}»`, detail: `${source.files.length} файлів`,
        file: { id: record.id, name: record.name, format: record.format, size: record.size, preview: record.preview },
        check: { ok: true, detail: 'Файли та посилання перевірено; код на сервері не запускався' }
      };
    } catch (error) { return { status: 'error', content: error instanceof Error ? error.message : 'Не вдалося створити проєкт' }; }
  }

  async read(studentId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const record = await this.owned(studentId, String(args.projectId ?? ''));
    const source = projectFromContent(record.content);
    const file = source.files.find(item => item.path === args.path);
    if (!args.path) return { content: JSON.stringify({ projectId: record.id, title: record.title, kind: source.kind, files: source.files.map(f => ({ path: f.path, chars: f.content.length })), published: Boolean(record.publishedContent) }) };
    if (!file) return { status: 'error', content: 'Файл не знайдено.' };
    const from = Math.max(0, Math.floor(Number(args.from) || 0));
    return { content: `${file.path}, ${from}–${Math.min(file.content.length, from + 20000)} / ${file.content.length} символів:\n${file.content.slice(from, from + 20000)}` };
  }

  async publish(studentId: string, id: string): Promise<{ url: string }> {
    const record = await this.owned(studentId, id);
    const source = projectFromContent(record.content);
    if (source.kind !== 'website') throw new AppError('AI_PROJECT_NOT_STATIC', 400, 'Можна опублікувати статичний HTML/CSS/JS сайт. Серверні проєкти доступні як ZIP.');
    const problems = checkProject(source);
    if (problems.length) throw new AppError('AI_PROJECT_INVALID', 400, problems.join('; '));
    await this.store.putGeneratedFile({ ...record, publishedContent: record.content, publishedAt: this.now().toISOString() });
    return { url: `/api/v1/sites/${record.id}/index.html` };
  }

  async unpublish(studentId: string, id: string): Promise<{ ok: true }> {
    const record = await this.owned(studentId, id);
    const { publishedContent: _source, publishedAt: _time, ...draft } = record;
    await this.store.putGeneratedFile(draft);
    return { ok: true };
  }

  async asset(id: string, path: string): Promise<{ content: string; mime: string }> {
    const record = await this.store.getGeneratedFile(id);
    if (!record || record.format !== 'project' || !record.publishedContent) throw new AppError('AI_SITE_NOT_FOUND', 404, 'Сайт не опублікований');
    return projectAsset(record.publishedContent, path);
  }
}

export function projectAsset(content: string, path: string): { content: string; mime: string } {
  if (!safeProjectPath(path)) throw new AppError('AI_SITE_NOT_FOUND', 404, 'Сторінку не знайдено');
  const source = projectFromContent(content);
  if (source.kind !== 'website') throw new AppError('AI_PROJECT_NOT_STATIC', 400, 'Перегляд доступний для HTML/CSS/JS сайтів.');
  const file = source.files.find(item => item.path === path);
  if (!file) throw new AppError('AI_SITE_NOT_FOUND', 404, 'Сторінку не знайдено');
  const ext = path.split('.').pop()!;
  const mime = ({ html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', xml: 'application/xml', txt: 'text/plain' } as Record<string, string>)[ext.toLowerCase()] ?? 'text/plain';
  return { content: file.content, mime: `${mime}; charset=utf-8` };
}

// Opaque sandbox origin isolates student JS from school cookies/storage even on the same hostname.
export const SITE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
