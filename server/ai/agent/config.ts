import { AppError } from '../../errors/app-error.js';
import type { SecretBox } from '../secret-box.js';
import type { AiStore } from '../store.js';
import type { AiPluginManifest, AiPluginRecord, AiSkill } from '../types.js';
import { BUILTIN_PLUGINS, defaultPluginRecords, pluginCatalog, PluginError, validateManifest } from './plugins.js';
import { BUILTIN_SKILLS, newSkill, parseSkillMarkdown, SkillFormatError, skillToMarkdown, validateSkill, type SkillDraft } from './skills.js';

/**
 * The agent's configuration as the school sees it: built-in skills and plugins that ship with the
 * code, merged with what the admin changed. Nothing here is written until the admin changes something.
 */

const MAX_SKILLS = 60;
const MAX_IMPORTED_PLUGINS = 20;

export async function loadSkills(store: AiStore, now: string): Promise<AiSkill[]> {
  const stored = await store.listSkills();
  const ids = new Set(stored.map(skill => skill.id));
  const defaults = BUILTIN_SKILLS.filter(skill => !ids.has(skill.id)).map(({ id, ...draft }) => newSkill(draft, now, true, id));
  const order = new Map(BUILTIN_SKILLS.map((skill, index) => [skill.id, index]));
  return [...defaults, ...stored].sort((a, b) => (order.get(a.id) ?? 1000) - (order.get(b.id) ?? 1000) || a.createdAt.localeCompare(b.createdAt));
}

export async function loadPlugins(store: AiStore, now: string): Promise<AiPluginRecord[]> {
  const stored = await store.listPlugins();
  // A school that never touched plugins gets the preinstalled ones.
  return stored.length ? stored : defaultPluginRecords(now);
}

export class AgentAdmin {
  constructor(private readonly store: AiStore, private readonly secrets: SecretBox, private readonly now: () => Date) {}

  private iso(): string { return this.now().toISOString(); }

  // -------------------------------------------------------------------------------------------
  // Skills

  async listSkills() {
    return (await loadSkills(this.store, this.iso())).map(skill => ({ ...skill, markdown: skillToMarkdown(skill) }));
  }

  private async findSkill(id: string): Promise<AiSkill> {
    const skill = (await loadSkills(this.store, this.iso())).find(item => item.id === id);
    if (!skill) throw new AppError('AI_SKILL_NOT_FOUND', 404, 'Навичку не знайдено');
    return skill;
  }

  private draftOrThrow(draft: SkillDraft): SkillDraft {
    try { return validateSkill(draft); }
    catch (error) { throw new AppError('AI_SKILL_INVALID', 400, error instanceof SkillFormatError ? error.message : 'Некоректна навичка'); }
  }

  private async assertUniqueName(name: string, exceptId: string | null): Promise<void> {
    const skills = await loadSkills(this.store, this.iso());
    if (skills.some(skill => skill.id !== exceptId && skill.name.toLowerCase() === name.toLowerCase())) throw new AppError('AI_SKILL_DUPLICATE', 409, `Навичка «${name}» уже є.`);
    if (!exceptId && skills.length >= MAX_SKILLS) throw new AppError('AI_SKILL_LIMIT', 409, `Можна мати до ${MAX_SKILLS} навичок.`);
  }

  async createSkill(draft: SkillDraft) {
    const clean = this.draftOrThrow(draft);
    await this.assertUniqueName(clean.name, null);
    const skill = newSkill(clean, this.iso());
    await this.store.putSkill(skill);
    return skill;
  }

  async updateSkill(id: string, patch: Partial<SkillDraft> & { enabled?: boolean }) {
    const skill = await this.findSkill(id);
    const clean = this.draftOrThrow({ name: patch.name ?? skill.name, description: patch.description ?? skill.description, when: patch.when ?? skill.when, instructions: patch.instructions ?? skill.instructions, tools: patch.tools ?? skill.tools });
    if (clean.name.toLowerCase() !== skill.name.toLowerCase()) await this.assertUniqueName(clean.name, id);
    const next: AiSkill = { ...skill, ...clean, enabled: patch.enabled ?? skill.enabled, updatedAt: this.iso() };
    await this.store.putSkill(next);
    return next;
  }

  /** Custom skills are deleted; built-in ones come back as shipped. */
  async deleteSkill(id: string) {
    const skill = await this.findSkill(id);
    await this.store.deleteSkill(id);
    return { reset: skill.builtin };
  }

  /** SKILL.md files; a skill with an existing name replaces it. Every file is checked before anything is saved. */
  async importSkills(files: Array<{ name: string; content: string }>) {
    if (!files.length) throw new AppError('AI_SKILL_INVALID', 400, 'Немає файлів для імпорту.');
    const drafts = files.map(file => {
      try { return parseSkillMarkdown(file.content); }
      catch (error) { throw new AppError('AI_SKILL_INVALID', 400, `«${file.name}»: ${error instanceof SkillFormatError ? error.message : 'не вдалося прочитати'}`); }
    });
    const names = drafts.map(draft => draft.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new AppError('AI_SKILL_DUPLICATE', 409, 'В імпорті є навички з однаковою назвою.');
    const existing = await loadSkills(this.store, this.iso());
    if (existing.length + drafts.filter(draft => !existing.some(skill => skill.name.toLowerCase() === draft.name.toLowerCase())).length > MAX_SKILLS) throw new AppError('AI_SKILL_LIMIT', 409, `Можна мати до ${MAX_SKILLS} навичок.`);
    const saved: AiSkill[] = [];
    for (const draft of drafts) {
      const match = existing.find(skill => skill.name.toLowerCase() === draft.name.toLowerCase());
      const skill = match ? { ...match, ...draft, updatedAt: this.iso() } : newSkill(draft, this.iso());
      await this.store.putSkill(skill);
      saved.push(skill);
    }
    return { imported: saved.length, replaced: saved.filter(skill => existing.some(item => item.id === skill.id)).length, skills: saved };
  }

  async exportSkills(id: string | null): Promise<Array<{ path: string; content: string }>> {
    const skills = id ? [await this.findSkill(id)] : await loadSkills(this.store, this.iso());
    const used = new Set<string>();
    return skills.map(skill => {
      let base = skill.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'skill';
      for (let suffix = 2; used.has(base); suffix += 1) base = `${base}-${suffix}`;
      used.add(base);
      return { path: `${base}/SKILL.md`, content: skillToMarkdown(skill) };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Plugins

  async listPlugins() {
    const records = await loadPlugins(this.store, this.iso());
    return pluginCatalog(records).map(({ manifest, core, builtin, record }) => ({
      id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description,
      permissions: manifest.permissions, settingsSchema: manifest.settings,
      secretsSchema: manifest.secrets.map(secret => ({ key: secret.key, label: secret.label })),
      tools: manifest.tools.map(tool => ({ name: tool.name, description: tool.description })),
      baseUrl: manifest.baseUrl ?? null, core, builtin,
      installed: core || Boolean(record), enabled: core || Boolean(record?.enabled),
      settings: record?.settings ?? {},
      // Which secrets are set — never their values.
      secretsSet: Object.keys(record?.secrets ?? {}),
      installedAt: record?.installedAt ?? null, updatedAt: record?.updatedAt ?? null
    }));
  }

  /** Writes the full list once, so preinstalled defaults become explicit records. */
  private async records(): Promise<AiPluginRecord[]> {
    const stored = await this.store.listPlugins();
    if (stored.length) return stored;
    const defaults = defaultPluginRecords(this.iso());
    for (const record of defaults) await this.store.putPlugin(record);
    return defaults;
  }

  async installBuiltin(id: string) {
    const plugin = BUILTIN_PLUGINS[id];
    if (!plugin) throw new AppError('AI_PLUGIN_NOT_FOUND', 404, 'Плагін не знайдено');
    if (plugin.core) throw new AppError('AI_PLUGIN_CORE', 409, 'Цей плагін вбудований і завжди увімкнений.');
    const records = await this.records();
    if (records.some(record => record.id === id)) throw new AppError('AI_PLUGIN_INSTALLED', 409, 'Плагін уже встановлено.');
    const record: AiPluginRecord = {
      id, source: 'builtin', manifest: null, enabled: true,
      settings: Object.fromEntries(plugin.manifest.settings.flatMap(setting => setting.default === undefined ? [] : [[setting.key, setting.default]])),
      secrets: {}, installedAt: this.iso(), updatedAt: this.iso()
    };
    await this.store.putPlugin(record);
    return record;
  }

  async importPlugin(raw: unknown) {
    let manifest: AiPluginManifest;
    try { manifest = validateManifest(raw); }
    catch (error) { throw new AppError('AI_PLUGIN_INVALID', 400, error instanceof PluginError ? error.message : 'Некоректний маніфест'); }
    const records = await this.records();
    const existing = records.find(record => record.id === manifest.id);
    if (existing && existing.source !== 'manifest') throw new AppError('AI_PLUGIN_INSTALLED', 409, 'Такий id уже використовує інший плагін.');
    if (!existing && records.filter(record => record.source === 'manifest').length >= MAX_IMPORTED_PLUGINS) throw new AppError('AI_PLUGIN_LIMIT', 409, `Можна підключити до ${MAX_IMPORTED_PLUGINS} плагінів.`);
    // An update keeps settings and secrets that the new version still declares.
    const record: AiPluginRecord = {
      id: manifest.id, source: 'manifest', manifest,
      enabled: existing ? existing.enabled : false,
      settings: Object.fromEntries(manifest.settings.map(setting => [setting.key, existing?.settings[setting.key] ?? setting.default ?? ''])),
      secrets: Object.fromEntries(Object.entries(existing?.secrets ?? {}).filter(([key]) => manifest.secrets.some(secret => secret.key === key))),
      secretsNext: Object.fromEntries(Object.entries(existing?.secretsNext ?? {}).filter(([key]) => manifest.secrets.some(secret => secret.key === key))),
      installedAt: existing?.installedAt ?? this.iso(), updatedAt: this.iso()
    };
    await this.store.putPlugin(record);
    return { record, updated: Boolean(existing) };
  }

  async updatePlugin(id: string, patch: { enabled?: boolean; settings?: Record<string, unknown>; secrets?: Record<string, string | null> }) {
    const plugin = BUILTIN_PLUGINS[id];
    if (plugin?.core) throw new AppError('AI_PLUGIN_CORE', 409, 'Цей плагін вбудований і завжди увімкнений.');
    const records = await this.records();
    const record = records.find(item => item.id === id);
    if (!record) throw new AppError('AI_PLUGIN_NOT_FOUND', 404, 'Плагін не встановлено');
    const manifest = record.manifest ?? plugin?.manifest;
    if (!manifest) throw new AppError('AI_PLUGIN_NOT_FOUND', 404, 'Плагін не знайдено');
    const settings = { ...record.settings };
    for (const [key, value] of Object.entries(patch.settings ?? {})) {
      const spec = manifest.settings.find(setting => setting.key === key);
      if (!spec) throw new AppError('AI_PLUGIN_SETTING', 400, `Невідоме налаштування «${key}».`);
      if (spec.type === 'number' && typeof value !== 'number') throw new AppError('AI_PLUGIN_SETTING', 400, `«${spec.label}» має бути числом.`);
      if (spec.type === 'boolean' && typeof value !== 'boolean') throw new AppError('AI_PLUGIN_SETTING', 400, `«${spec.label}» має бути так/ні.`);
      if (spec.type === 'select' && !spec.options?.includes(String(value))) throw new AppError('AI_PLUGIN_SETTING', 400, `«${spec.label}»: оберіть одне зі значень.`);
      if (spec.type === 'text' && (typeof value !== 'string' || value.length > 500)) throw new AppError('AI_PLUGIN_SETTING', 400, `«${spec.label}»: текст до 500 символів.`);
      settings[key] = value as string | number | boolean;
    }
    const secrets = { ...record.secrets };
    const secretsNext = { ...record.secretsNext };
    for (const [key, value] of Object.entries(patch.secrets ?? {})) {
      if (!manifest.secrets.some(secret => secret.key === key)) throw new AppError('AI_PLUGIN_SETTING', 400, `Невідомий секрет «${key}».`);
      if (value === null || value === '') { delete secrets[key]; delete secretsNext[key]; }
      else if (value.length > 4000) throw new AppError('AI_PLUGIN_SETTING', 400, 'Секрет задовгий.');
      else {
        secrets[key] = this.secrets.seal(value);
        const second = this.secrets.sealNext(secrets[key]!, value);
        if (second) secretsNext[key] = second; else delete secretsNext[key];
      }
    }
    const enabled = patch.enabled ?? record.enabled;
    if (enabled && manifest.secrets.length && manifest.secrets.some(secret => !secrets[secret.key])) throw new AppError('AI_PLUGIN_SECRET_MISSING', 409, 'Спершу задайте всі секрети плагіна.');
    const next: AiPluginRecord = { ...record, enabled, settings, secrets, secretsNext, updatedAt: this.iso() };
    await this.store.putPlugin(next);
    return next;
  }

  async removePlugin(id: string) {
    if (BUILTIN_PLUGINS[id]?.core) throw new AppError('AI_PLUGIN_CORE', 409, 'Цей плагін вбудований і не видаляється.');
    const records = await this.records();
    if (!records.some(record => record.id === id)) throw new AppError('AI_PLUGIN_NOT_FOUND', 404, 'Плагін не встановлено');
    await this.store.deletePlugin(id);
  }
}
