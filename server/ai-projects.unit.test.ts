import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentProjects, checkProject, parseProject } from './ai/projects.js';
import { MemoryAiStore } from './ai/store.js';
import type { AiJob } from './ai/types.js';
import { DEV_IDS, PILOT_STUDENTS } from './data/seed.js';
import { aiSchool } from './ai/testing/app-harness.js';
import { readZipEntries, readZipEntry } from './ai/zip.js';
import { enabledTools } from './ai/agent/plugins.js';
import { BUILTIN_SKILLS, validateSkill } from './ai/agent/skills.js';

const owner = DEV_IDS.user;
const other = PILOT_STUDENTS[1].id;
const job = () => ({ studentId: owner, conversationId: randomUUID(), files: [] }) as unknown as AiJob;
const html = (title: string, body: string) => `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;
const files = () => [
  { path: 'index.html', content: html('Космос', '<a href="blog/stars.html">Зорі</a><link rel="stylesheet" href="style.css"><script src="app.js"></script>') },
  { path: 'style.css', content: 'body{margin:0;color:#172036}' },
  { path: 'app.js', content: 'document.body.dataset.ready="true";' },
  { path: 'blog/stars.html', content: html('Чому зорі світять', '<h1>Чому зорі світять</h1><a href="../index.html">Головна</a><link rel="stylesheet" href="../style.css">') }
];
const schools: Array<ReturnType<typeof aiSchool>> = [];
afterEach(async () => { await Promise.all(schools.splice(0).map(school => school.close())); });

describe('student projects', () => {
  it('renders returned public-site links without allowing script URLs or relative traversal', async () => {
    const modulePath = '../src/ai-markdown.js';
    const { renderMarkdown } = await import(modulePath);
    const site = `/api/v1/sites/${randomUUID()}/blog/stars.html`;
    expect(renderMarkdown(`[Сайт](${site})`)).toContain(`href="${site}"`);
    expect(renderMarkdown('[X](javascript:alert%281%29)')).not.toContain('href=');
    expect(renderMarkdown(`[X](${site}/../../admin.html)`)).not.toContain('href=');
  });
  it('rejects traversal, hidden files, duplicate paths, oversized source and broken website resources', () => {
    for (const path of ['../index.html', '.env', 'src/../index.html', 'src\\app.js', 'a//b.js', '/index.html']) {
      expect(() => parseProject({ kind: 'code', files: [{ path, content: 'x' }] })).toThrow();
    }
    expect(() => parseProject({ kind: 'code', files: [{ path: 'a.js', content: '' }, { path: 'A.js', content: '' }] })).toThrow('Повторний');
    expect(() => parseProject({ kind: 'code', files: [{ path: 'a.txt', content: 'я'.repeat(150001) }] })).toThrow('300');
    expect(checkProject(parseProject({ kind: 'website', files: [{ path: 'index.html', content: html('X', '<script src="missing.js"></script><script>const = ;</script>') }] })).join(' ')).toMatch(/missing.js.*синтаксична/);
    expect(checkProject(parseProject({ kind: 'website', files: files() }))).toEqual([]);
  });

  it('keeps public site unchanged while adding SEO pages, enforces ownership and can unpublish', async () => {
    const store = new MemoryAiStore();
    const projects = new StudentProjects(store, () => new Date('2026-10-15T10:00:00Z'));
    const made = await projects.create(job(), { kind: 'website', title: 'Космос', files: files() });
    expect(made.check?.ok).toBe(true);
    const id = made.file!.id;
    await expect(projects.asset(id, 'index.html')).rejects.toMatchObject({ statusCode: 404 });
    const published = await projects.publish(owner, id);
    expect(published.url).toContain(id);
    await expect(projects.read(other, { projectId: id })).rejects.toThrow('не знайдено');
    await expect(projects.publish(other, id)).rejects.toThrow('не знайдено');
    await expect(projects.unpublish(other, id)).rejects.toThrow('не знайдено');
    const changed = files();
    changed[0]!.content = html('Космос v2', '<a href="blog/planets.html">Планети</a>');
    changed.push({ path: 'blog/planets.html', content: html('Планети', '<h1>Планети</h1><a href="../index.html">Головна</a>') });
    const next = await projects.create(job(), { kind: 'website', projectId: id, files: changed });
    expect(next.file!.id).toBe(id);
    expect((await projects.asset(id, 'index.html')).content).toContain('<title>Космос</title>');
    await expect(projects.asset(id, 'blog/planets.html')).rejects.toThrow();
    await projects.publish(owner, id);
    expect((await projects.asset(id, 'blog/planets.html')).content).toContain('<h1>Планети</h1>');
    await projects.unpublish(owner, id);
    await expect(projects.asset(id, 'index.html')).rejects.toThrow();
    expect((await projects.read(owner, { projectId: id })).content).toContain('blog/planets.html');
  });

  it('downloads a real ZIP and serves signed drafts/public articles with sandbox headers across app instances', async () => {
    const school = aiSchool(); schools.push(school);
    const student = await school.as(owner);
    const projects = new StudentProjects(school.aiStore, () => new Date());
    const made = await projects.create(job(), { kind: 'website', title: 'Сайт', files: files() });
    const id = made.file!.id;
    const link = (await student.call('POST', `/api/v1/ai/files/${id}/link`)).json();
    const download = await student.app.inject({ method: 'GET', url: link.url });
    expect(download.statusCode).toBe(200);
    const entries = readZipEntries(download.rawPayload);
    expect(entries.map(e => e.path)).toEqual(files().map(f => f.path));
    expect(readZipEntry(download.rawPayload, entries[0]!, 300000).toString()).toContain('Космос');
    const preview = await student.app.inject({ method: 'GET', url: link.previewUrl.replace('index.html', 'blog/stars.html') });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-security-policy']).toContain('sandbox allow-scripts;');
    expect(preview.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(preview.headers['x-robots-tag']).toContain('noindex');
    const stranger = await school.as(other);
    expect((await stranger.call('POST', `/api/v1/ai/files/${id}/link`)).statusCode).toBe(404);
    expect((await stranger.call('DELETE', `/api/v1/ai/projects/${id}/publication`)).statusCode).toBe(404);
    await projects.publish(owner, id);
    const page = await stranger.app.inject({ method: 'GET', url: `/api/v1/sites/${id}/blog/stars.html` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<h1>Чому зорі світять</h1>');
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("connect-src 'none'");
    expect((await stranger.app.inject({ method: 'GET', url: `/api/v1/sites/${id}/missing.js` })).statusCode).toBe(404);
    expect((await student.call('DELETE', `/api/v1/ai/projects/${id}/publication`)).statusCode).toBe(200);
    expect((await stranger.app.inject({ method: 'GET', url: `/api/v1/sites/${id}/index.html` })).statusCode).toBe(404);
  }, 30000);

  it('ships valid skills and requires the existing confirmation mechanism for publishing', () => {
    for (const skill of BUILTIN_SKILLS) expect(validateSkill(skill)).toBeTruthy();
    const tools = enabledTools([]).map(entry => entry.tool);
    expect(tools.find(tool => tool.name === 'create_project')?.permission).toBe('files:write');
    expect(tools.find(tool => tool.name === 'publish_project')?.permission).toBe('network');
    expect(tools.find(tool => tool.name === 'publish_project')?.disclosure?.({ projectId: 'project' }, {} as never).details).toContain('доступні кожному');
  });
});
