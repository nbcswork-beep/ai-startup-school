import { randomUUID } from 'node:crypto';
import type { AiSkill } from '../types.js';

/**
 * Skills in the SKILL.md format: metadata in a front matter block, instructions in Markdown below.
 *
 * ---
 * name: Конспект
 * description: Стислий структурований конспект матеріалу
 * when: Учень просить конспект, тези або стислий виклад
 * tools: read_file, create_file
 * ---
 * Інструкції…
 */

export const SKILL_LIMITS = { name: 60, description: 300, when: 500, instructions: 8000, tools: 12 };
const TOOL_NAME = /^[a-z][a-z0-9_]{1,47}$/;

export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFormatError';
  }
}

export interface SkillDraft { name: string; description: string; when: string; instructions: string; tools: string[] }

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** Checks lengths and tool names; returns a clean draft or throws with a message for the admin. */
export function validateSkill(draft: SkillDraft): SkillDraft {
  const name = draft.name.trim();
  const description = draft.description.trim();
  const when = draft.when.trim();
  const instructions = draft.instructions.replace(/\r\n?/g, '\n').trim();
  if (!name) throw new SkillFormatError('Вкажіть назву навички (name).');
  if (!instructions) throw new SkillFormatError(`Навичка «${name}»: немає інструкцій.`);
  if (name.length > SKILL_LIMITS.name) throw new SkillFormatError(`Назва довша за ${SKILL_LIMITS.name} символів.`);
  if (description.length > SKILL_LIMITS.description) throw new SkillFormatError(`Опис довший за ${SKILL_LIMITS.description} символів.`);
  if (when.length > SKILL_LIMITS.when) throw new SkillFormatError(`Умови застосування довші за ${SKILL_LIMITS.when} символів.`);
  if (instructions.length > SKILL_LIMITS.instructions) throw new SkillFormatError(`Інструкції довші за ${SKILL_LIMITS.instructions} символів.`);
  const tools = [...new Set(draft.tools.map(tool => tool.trim()).filter(Boolean))];
  if (tools.length > SKILL_LIMITS.tools) throw new SkillFormatError(`Забагато інструментів: до ${SKILL_LIMITS.tools}.`);
  const bad = tools.find(tool => !TOOL_NAME.test(tool));
  if (bad) throw new SkillFormatError(`Некоректна назва інструмента: «${bad}».`);
  return { name, description, when, instructions, tools };
}

export function parseSkillMarkdown(source: string): SkillDraft {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new SkillFormatError('Файл має починатися з блоку метаданих між рядками «---».');
  const meta: Record<string, string> = {};
  let listKey: string | null = null;
  const lists: Record<string, string[]> = {};
  for (const line of match[1]!.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { (lists[listKey] ??= []).push(unquote(item[1]!)); continue; }
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) throw new SkillFormatError(`Не вдалося прочитати рядок метаданих: «${line.trim().slice(0, 60)}».`);
    const key = pair[1]!.toLowerCase().replace(/-/g, '_');
    const value = pair[2]!.trim();
    listKey = value ? null : key;
    meta[key] = unquote(value);
  }
  const listOr = (key: string) => lists[key] ?? (meta[key] ? meta[key]!.replace(/^\[|\]$/g, '').split(',').map(unquote) : []);
  return validateSkill({
    name: meta.name ?? '',
    description: meta.description ?? '',
    when: meta.when ?? meta.when_to_use ?? meta.applies_when ?? '',
    instructions: match[2] ?? '',
    tools: listOr(meta.tools !== undefined || lists.tools ? 'tools' : 'allowed_tools')
  });
}

export function skillToMarkdown(skill: Pick<AiSkill, 'name' | 'description' | 'when' | 'instructions' | 'tools'>): string {
  const line = (value: string) => value.replace(/\s*\n\s*/g, ' ').trim();
  return [
    '---',
    `name: ${line(skill.name)}`,
    `description: ${line(skill.description)}`,
    `when: ${line(skill.when)}`,
    `tools: ${skill.tools.join(', ')}`,
    '---',
    '',
    skill.instructions.trim(),
    ''
  ].join('\n');
}

export function newSkill(draft: SkillDraft, now: string, builtin = false, id: string = randomUUID()): AiSkill {
  return { id, ...validateSkill(draft), enabled: true, builtin, createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------------------------
// Skills that ship with the school. Ids are fixed so a reset finds them again.

export const BUILTIN_SKILLS: Array<SkillDraft & { id: string }> = [
  {
    id: 'skill-summary',
    name: 'Конспект',
    description: 'Стислий структурований конспект теми або документа.',
    when: 'Учень просить конспект, тези, стислий виклад, підсумок теми чи прикріпленого файлу.',
    tools: ['read_file', 'create_file'],
    instructions: [
      'Склади конспект, з яким зручно повторювати матеріал.',
      '',
      '1. Якщо прикріплено файли — спершу прочитай їх (read_file) і спирайся лише на їхній зміст. Нічого не вигадуй; якщо чогось бракує, так і скажи.',
      '2. Структура: заголовок теми; «Головна ідея» (2–3 речення); «Ключові тези» (5–8 пунктів); «Терміни» (термін — коротке визначення); якщо є що порівнювати — таблиця; «Перевір себе» (3 питання без відповідей).',
      '3. Пиши коротко: один пункт — одна думка. Зберігай терміни з джерела, біля важливих тез вказуй сторінку чи розділ, якщо вони відомі.',
      '4. Якщо учень просить файл, створи його через create_file у потрібному форматі (без уточнення — Word, docx). Вміст пиши Markdown-заголовками (#, ##), списками й таблицями.',
      '5. У відповіді в чаті коротко скажи, що увійшло в конспект.'
    ].join('\n')
  },
  {
    id: 'skill-explain',
    name: 'Пояснення теми',
    description: 'Пояснює тему простими словами, з прикладом і перевіркою розуміння.',
    when: 'Учень не розуміє тему, просить пояснити, розібрати приклад або «простими словами».',
    tools: ['read_file'],
    instructions: [
      'Поясни тему так, щоб її зрозумів підліток, який бачить її вперше.',
      '',
      '1. Почни з суті в одному-двох реченнях.',
      '2. Дай аналогію з повсякденного життя.',
      '3. Розбери один приклад крок за кроком.',
      '4. Назви 1–2 типові помилки.',
      '5. Заверши двома короткими питаннями для перевірки і запитай, що лишилося незрозумілим.',
      'Не розвʼязуй за учня домашнє завдання повністю — показуй підхід. Якщо прикріплено матеріал уроку, пояснюй за ним.'
    ].join('\n')
  },
  {
    id: 'skill-exam',
    name: 'Підготовка до іспиту',
    description: 'План повторення і питання для самоперевірки за матеріалами.',
    when: 'Учень готується до контрольної, заліку чи іспиту, просить питання, тест або план повторення.',
    tools: ['read_file', 'create_file'],
    instructions: [
      'Допоможи підготуватися до перевірки знань.',
      '',
      '1. Визнач теми з прикріплених матеріалів (прочитай їх) або зі слів учня.',
      '2. Склади план повторення по днях (до 7 днів) з конкретними діями.',
      '3. Підготуй 10 питань від простих до складних. Відповіді давай окремим розділом «Відповіді» після всіх питань, щоб учень спершу спробував сам.',
      '4. Якщо учень просить картки — створи таблицю Excel (xlsx) зі стовпцями «Питання» і «Відповідь». Якщо просить шпаргалку чи план у файлі — створи Word або PDF.',
      '5. Підбадьор, але без води.'
    ].join('\n')
  },
  {
    id: 'skill-report',
    name: 'Оформлення доповіді',
    description: 'Доповідь або реферат у Word зі звичною шкільною структурою.',
    when: 'Учень просить доповідь, реферат, есе, звіт або оформити роботу у Word чи PDF.',
    tools: ['read_file', 'create_file'],
    instructions: [
      'Підготуй доповідь, яку можна здати після власного доопрацювання учнем.',
      '',
      '1. Якщо є прикріплені матеріали — прочитай їх і спирайся на них.',
      '2. Структура: # Тема; рядок «Підготував(-ла): [імʼя учня]» — залиш заповнювач, не питай персональних даних; ## Зміст (перелік розділів); ## Вступ (актуальність і мета); 2–4 розділи основної частини з підзаголовками ##; ## Висновки; ## Джерела.',
      '3. У «Джерелах» наводь лише реальні джерела: прикріплені файли та загальновідомі підручники. Не вигадуй посилань.',
      '4. Таблиці використовуй для порівнянь і даних.',
      '5. Створи файл через create_file: за замовчуванням Word (docx), PDF — якщо учень просить. Обсяг — 2–4 сторінки.',
      '6. У чаті коротко опиши структуру і порадь, що учню варто дописати своїми словами.'
    ].join('\n')
  },
  {
    id: 'skill-slides',
    name: 'Презентація',
    description: 'Слайди PowerPoint за темою або матеріалом.',
    when: 'Учень просить презентацію, слайди або виступ із презентацією.',
    tools: ['read_file', 'create_file'],
    instructions: [
      'Зроби презентацію PowerPoint (pptx) через create_file.',
      '',
      '1. Якщо є матеріали — прочитай їх і бери факти звідти.',
      '2. Формат вмісту: перший рядок «# Назва презентації», під ним одне речення-підзаголовок. Далі кожен слайд — «## Заголовок слайда» і 3–5 коротких пунктів (до 12 слів кожен).',
      '3. 8–12 слайдів: вступ, основні частини, приклад або порівняння (таблицею), «Висновки», «Питання».',
      '4. Нотатки доповідача пиши рядком «> …» під пунктами слайда.',
      '5. У чаті перелічи слайди й порадь, як їх представити за 3–5 хвилин.'
    ].join('\n')
  },
{ id: 'skill-homework-hints', name: 'Підказки до домашнього', description: 'Допомагає виконати завдання самостійно.', when: 'Учень просить допомоги з домашнім завданням.', tools: ['read_file', 'calculate'], instructions: 'Спитай, що учень уже спробував. Давай одну підказку за раз, пояснюй на іншому прикладі й перевіряй розуміння. Не підмінюй роботу учня готовим розвʼязанням або файлом для здачі.' }
];
