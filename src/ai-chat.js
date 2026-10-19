// Student OS · ШІ-асистент. A chat screen over the server's AI: several chats, model choice, files
// in (PDF, Word, Excel, CSV, PowerPoint, text, ZIP) and out, an agent mode that works in steps, and
// skills. Answers are generated on the server as jobs: the app watches a job and can come back to it
// after it was closed; only «Стоп» ends one early. The balance always comes from the server.
import { preparePhoto } from './ai-photos.js';
import { escapeText, renderMarkdown } from './ai-markdown.js';
import { formatFileSize, sendFile } from './homework-uploads.js';

const CURRENT_KEY = 'aiss:ai:current';
const DRAFT_KEY = 'aiss:ai:draft';
const AGENT_KEY = 'aiss:ai:agent';
const ACK_KEY = 'aiss:ai:ack';
const numberFormat = new Intl.NumberFormat('uk-UA');
const ACTIVE = new Set(['running', 'finalizing']);
const FALLBACK_KINDS = [{ extension: 'zip', label: 'ZIP', maxBytes: 5 * 1024 * 1024 }];

const state = {
  me: null,
  conversations: [],
  loaded: false,
  loading: false,
  loadError: '',
  currentId: readStorage(CURRENT_KEY),
  messages: [],
  messagesFor: null,
  messagesLoading: false,
  modelId: null,
  /** The student chose the model themself; otherwise agent mode uses the school's agent model. */
  modelPicked: false,
  /** The answer being generated: { jobId, conversationId, user, text, offset, modelLabel, mode, steps, files, action, viewing, ... } */
  pending: null,
  error: null,
  drawer: false,
  /** 'model' | 'skill' | false */
  sheet: false,
  renaming: null,
  confirmDelete: null,
  stick: true,
  /** Files for the next message: { key, file, name, size, kind, status, progress, id, upload, ... } */
  attachments: [],
  agent: readLocal(AGENT_KEY) === '1',
  skillId: null,
  reviseMessageId: null,
  context: null
};

let root = null;
let deps = null;
let frame = 0;
let appHidden = false;

function readStorage(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function writeStorage(key, value) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch {} }
function readLocal(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeLocal(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bytesOf = text => new TextEncoder().encode(text).length;

const icon = (path, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
const icons = {
  back: icon('<path d="M15 18 9 12l6-6"/>'),
  chats: icon('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  send: icon('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
  copy: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  check: icon('<path d="m5 12 4.5 4.5L19 7"/>'),
  chevron: icon('<path d="m7 10 5 5 5-5"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  trash: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  down: icon('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  spark: icon('<path d="M12 2.7 14.1 8l5.2 2.1-5.2 2.1L12 17.5l-2.1-5.3-5.2-2.1L9.9 8z"/>'),
  clip: icon('<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>'),
  archive: icon('<rect x="3.5" y="4" width="17" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>'),
  doc: icon('<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/>'),
  download: icon('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  retry: icon('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>'),
  cross: icon('<path d="M7 7l10 10M17 7 7 17"/>'),
  minus: icon('<path d="M6 12h12"/>'),
  photo: icon('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 4 3.5 2.5-2 4.5 3.5"/>'),
  up: icon('<path d="M7 11v9H4.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zM7 11l4-7.5a2 2 0 0 1 2.6 2.2L13 9.5h5.3a2 2 0 0 1 2 2.4l-1.4 6.5a2 2 0 0 1-2 1.6H7"/>'),
  down: icon('<path d="M17 13V4h2.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1zM17 13l-4 7.5a2 2 0 0 1-2.6-2.2l.6-3.8H5.7a2 2 0 0 1-2-2.4l1.4-6.5a2 2 0 0 1 2-1.6H17"/>'),
  agent: icon('<path d="M12 3v3M5.6 5.6l2.1 2.1M3 12h3M18.4 5.6l-2.1 2.1M21 12h-3"/><circle cx="12" cy="14" r="5"/><path d="M10.5 14h3"/>')
};

const fileWord = count => plural(count, 'файл', 'файли', 'файлів');
const KIND_LABEL = { jpg: 'Фото', png: 'Фото', webp: 'Фото', pdf: 'PDF', docx: 'Word', xlsx: 'Excel', csv: 'CSV', pptx: 'PowerPoint', txt: 'Текст', md: 'Markdown', zip: 'ZIP' };

const SUGGESTIONS = [
  ['Поясни простіше', 'Поясни простими словами, що таке MVP і навіщо він стартапу.'],
  ['Перевір ідею', 'Допоможи перевірити мою ідею: які питання поставити першим користувачам?'],
  ['Допоможи з кодом', 'Поясни, як працює цикл for у JavaScript, на короткому прикладі.'],
  ['Склади план', 'Склади план роботи над шкільним проєктом на тиждень.']
];
const AGENT_SUGGESTIONS = [
  ['Конспект у Word', 'Зроби конспект прикріпленого матеріалу у Word.'],
  ['Презентація', 'Створи презентацію на 8 слайдів за прикріпленим матеріалом.'],
  ['PDF для повторення', 'Підготуй PDF з питаннями для самоперевірки за цією темою.'],
  ['Таблиця Excel', 'Витягни всі таблиці з документа в Excel.']
];

const LESSON_SUGGESTIONS = [
  ['Головна ідея', 'Поясни головну ідею цього уроку простими словами.'],
  ['Ще приклад', 'Наведи ще один приклад до цього уроку з життя.'],
  ['Перевір мене', 'Постав мені 3 запитання, щоб перевірити, чи я зрозумів урок.'],
  ['Для мого проєкту', 'Як застосувати цей урок у моєму проєкті?']
];
const HOMEWORK_SUGGESTIONS = [
  ['З чого почати', 'Допоможи розібратися із завданням. З чого почати?'],
  ['Поясни умову', 'Поясни умову завдання простішими словами.'],
  ['Я застряг', 'Я застряг. Дай одну підказку, але не готову відповідь.'],
  ['Як перевірити себе', 'Як мені перевірити, що я виконав завдання правильно?']
];

function plural(count, one, few, many) {
  const mod10 = count % 10, mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function formatTokens(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return `${numberFormat.format(count)} ${plural(count, 'токен', 'токени', 'токенів')}`;
}

function shortTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(date);
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчора';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' }).format(date);
}

function currentConversation() { return state.conversations.find(item => item.id === state.currentId) ?? null; }
function models() { return state.me?.models ?? []; }
function skills() { return state.me?.skills ?? []; }
function chosenModel() {
  return models().find(model => model.id === state.modelId) ?? models().find(model => model.id === state.me?.defaultModelId) ?? models()[0] ?? null;
}
/** The model the next message goes to. Agent mode needs a model with tools: the school's agent model unless the student picked one. */
function selectedModel() {
  const chosen = chosenModel();
  let model = chosen;
  if (agentOn()) {
    const agentDefault = models().find(item => item.id === state.me?.agent?.defaultModelId) ?? null;
    if (!state.modelPicked && agentDefault) model = agentDefault;
    else model = chosen?.agent !== false ? chosen : agentDefault ?? models().find(item => item.agent !== false) ?? chosen;
  }
  if (hasPhotos() && !model?.vision && !state.modelPicked) {
    model = models().find(item => item.vision && (!agentOn() || item.agent !== false)) ?? model;
  }
  return model;
}
function selectedSkill() { return skills().find(skill => skill.id === state.skillId) ?? null; }
const PHOTO_KINDS = new Set(['jpg', 'png', 'webp']);
/** A photo is resized on the phone before upload, so the original may be much larger than the stored copy. */
const MAX_PHOTO_SOURCE_BYTES = 20 * 1024 * 1024;
function visionAvailable() { return models().some(model => model.vision); }
function attachmentKinds() {
  const kinds = state.me?.limits?.attachments?.kinds ?? FALLBACK_KINDS;
  return visionAvailable() ? kinds : kinds.filter(kind => !PHOTO_KINDS.has(kind.extension));
}
function pickerAccept() {
  const kinds = attachmentKinds();
  const photos = kinds.some(kind => PHOTO_KINDS.has(kind.extension)) ? ['.jpeg', 'image/jpeg', 'image/png', 'image/webp'] : [];
  return [...kinds.map(kind => `.${kind.extension}`), ...photos].join(',');
}
function hasPhotos() { return state.attachments.some(item => PHOTO_KINDS.has(item.kind) && item.status !== 'error'); }
/** Agent mode is on only where the school allows it and some model can call tools. */
function agentAvailable() { return Boolean(state.me?.agent?.enabled) && models().some(model => model.agent !== false); }
function agentOn() { return state.agent && agentAvailable(); }

/** Why the student cannot send right now, or null. */
function blocker() {
  if (!state.me) return null;
  if (!state.me.configured) return { tone: 'muted', text: 'ШІ-асистент ще не налаштований. Зверніться до викладача.' };
  if (state.me.balance.blocked) return { tone: 'danger', text: 'Доступ до ШІ тимчасово призупинено. Зверніться до викладача.' };
  if (state.me.balance.exhausted) return { tone: 'danger', text: 'Ваш ліміт ШІ-токенів вичерпано. Зверніться до викладача.' };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Markup

export function aiScreenMarkup() {
  return `<section class="ai-screen" id="aiScreen" aria-labelledby="aiTitle">
    <header class="ai-bar">
      <button type="button" class="btn btn--icon btn--ghost" data-ai="back" aria-label="Назад">${icons.back}</button>
      <div class="ai-bar-title">
        <h1 id="aiTitle">ШІ-асистент</h1>
        <button type="button" class="ai-model-chip" data-ai="model" aria-haspopup="dialog" aria-expanded="false" hidden></button>
      </div>
      <button type="button" class="btn btn--icon btn--secondary" data-ai="chats" aria-label="Мої чати" aria-expanded="false" aria-controls="aiDrawer">${icons.chats}</button>
      <button type="button" class="btn btn--icon btn--secondary" data-ai="new" aria-label="Новий чат">${icons.plus}</button>
    </header>
    <div class="ai-balance" id="aiBalance" role="status"></div>
    <div class="ai-thread" id="aiThread" role="log" aria-live="polite" aria-relevant="additions" tabindex="-1"></div>
    <button type="button" class="ai-to-bottom" data-ai="to-bottom" aria-label="До останнього повідомлення" hidden>${icons.down}</button>
    <form class="ai-composer" id="aiComposer" novalidate>
      <div id="aiContextNote" class="ai-context-note" hidden></div>
      <div class="ai-tools" id="aiTools" hidden>
        <button type="button" class="ai-tool-chip" data-ai="agent" aria-pressed="false">${icons.agent}<span>Агент</span></button>
        <button type="button" class="ai-tool-chip" data-ai="skills" aria-haspopup="dialog" aria-expanded="false"><span>Навичка: авто</span>${icons.chevron}</button>
      </div>
      <div class="ai-attachment-row" id="aiAttachment" hidden></div>
      <button type="button" class="btn btn--icon btn--ghost ai-attach" data-ai="attach" aria-label="Прикріпити файли" hidden>${icons.clip}</button>
      <input type="file" id="aiFile" multiple hidden>
      <label class="visually-hidden" for="aiInput">Повідомлення ШІ-асистенту</label>
      <textarea id="aiInput" rows="1" placeholder="Напишіть питання…" autocomplete="off" enterkeyhint="send"></textarea>
      <button type="submit" class="btn btn--icon btn--primary ai-send" id="aiSend" aria-label="Надіслати">${icons.send}</button>
      <p class="ai-composer-hint" id="aiHint" aria-live="polite"></p>
    </form>
    <div class="ai-scrim" data-ai="close-layer" hidden></div>
    <aside class="ai-drawer" id="aiDrawer" role="dialog" aria-modal="true" aria-labelledby="aiDrawerTitle" hidden>
      <header><h2 id="aiDrawerTitle">Мої чати</h2><button type="button" class="btn btn--icon btn--ghost" data-ai="close-layer" aria-label="Закрити">${icons.close}</button></header>
      <button type="button" class="btn btn--secondary btn--block ai-drawer-new" data-ai="new">${icons.plus}<span>Новий чат</span></button>
      <div class="ai-drawer-list" id="aiDrawerList"></div>
    </aside>
    <div class="ai-sheet" id="aiSheet" role="dialog" aria-modal="true" aria-labelledby="aiSheetTitle" hidden>
      <header><h2 id="aiSheetTitle">Модель</h2><button type="button" class="btn btn--icon btn--ghost" data-ai="close-layer" aria-label="Закрити">${icons.close}</button></header>
      <div class="ai-sheet-list" id="aiSheetList"></div>
    </div>
  </section>`;
}

function attachmentChip(item) {
  const kind = item.kind ?? 'zip';
  const facts = [KIND_LABEL[kind] ?? kind.toUpperCase(), item.pages ? `${item.pages} стор.` : '', kind === 'zip' && item.fileCount ? `${item.fileCount} ${fileWord(item.fileCount)}` : '', formatFileSize(item.size)].filter(Boolean).join(' · ');
  return `<span class="ai-file-chip">${kind === 'zip' ? icons.archive : PHOTO_KINDS.has(kind) ? icons.photo : icons.doc}<span><strong>${escapeText(item.name)}</strong><small>${escapeText(facts)}</small></span></span>`;
}

const STEP_ICON = { running: '<span class="ai-step-spinner" aria-hidden="true"></span>', done: icons.check, error: icons.cross, declined: icons.minus };
const STEP_STATUS = { running: 'виконується', done: 'готово', error: 'помилка', declined: 'не дозволено' };

function stepsMarkup(steps, { live = false } = {}) {
  if (!steps?.length) return '';
  const items = steps.map(step => `<li class="ai-step" data-status="${escapeText(step.status)}">
    <span class="ai-step-icon">${STEP_ICON[step.status] ?? ''}</span>
    <span class="ai-step-text"><strong>${escapeText(step.label)}</strong>${step.detail ? `<small>${escapeText(step.detail)}</small>` : ''}<span class="visually-hidden">, ${STEP_STATUS[step.status] ?? ''}</span></span>
  </li>`).join('');
  if (live) return `<ol class="ai-steps is-live" aria-label="Кроки виконання">${items}</ol>`;
  const failed = steps.filter(step => step.status === 'error').length;
  return `<details class="ai-steps-box"><summary>${steps.length} ${plural(steps.length, 'крок', 'кроки', 'кроків')}${failed ? ` · ${failed} з помилкою` : ''}</summary><ol class="ai-steps">${items}</ol></details>`;
}

function previewMarkup(preview) {
  if (!preview) return '';
  if (preview.kind === 'outline' || preview.kind === 'slides' || preview.kind === 'project') {
    if (!preview.items?.length) return '';
    const items = preview.items.slice(0, 6);
    return `<ol class="ai-file-outline" aria-label="${preview.kind === 'slides' ? 'Слайди' : preview.kind === 'project' ? 'Файли проєкту' : 'Розділи'}">${items.map(item => `<li>${escapeText(item)}</li>`).join('')}${preview.items.length > items.length ? `<li class="is-more">ще ${preview.items.length - items.length}</li>` : ''}</ol>`;
  }
  if (preview.kind === 'table') {
    const header = preview.header ?? [];
    return `<div class="ai-file-table" role="region" aria-label="Перші рядки таблиці «${escapeText(preview.sheet ?? '')}»" tabindex="0"><table><thead><tr>${header.map(cell => `<th>${escapeText(cell)}</th>`).join('')}</tr></thead><tbody>${(preview.rows ?? []).slice(0, 3).map(row => `<tr>${row.map(cell => `<td>${escapeText(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  if (preview.kind === 'text' && preview.text) return `<p class="ai-file-text">${escapeText(preview.text)}</p>`;
  return '';
}

function fileCards(files, { live = false } = {}) {
  if (!files?.length) return '';
  return `<div class="ai-files">${files.map(file => `<div class="ai-file-card" data-format="${escapeText(file.format)}">
    <span class="ai-file-badge" aria-hidden="true">${escapeText(file.format === 'project' ? 'ZIP' : file.format.toUpperCase())}</span>
    <span class="ai-file-info"><strong>${escapeText(file.name)}</strong><small>${escapeText(file.preview?.incomplete ? 'Чернетка · код ще дописується' : file.format === 'project' ? 'Проєкт' : KIND_LABEL[file.format] ?? file.format)} · ${formatFileSize(file.size)}</small></span>
    ${live ? '' : `<button type="button" class="btn btn--secondary btn--sm ai-file-download" data-ai="file" data-id="${escapeText(file.id)}" aria-label="Завантажити ${escapeText(file.name)}">${icons.download}<span>Завантажити</span></button>`}
    ${previewMarkup(file.preview)}
    ${!live && file.preview?.kind === 'project' && file.preview.projectKind === 'website' ? `<button type="button" class="btn btn--secondary btn--sm" data-ai="project-preview" data-id="${escapeText(file.id)}">Переглянути сайт</button>` : ''}
  </div>`).join('')}</div>`;
}

function confirmMarkup(action) {
  if (!action) return '';
  return `<div class="ai-confirm" role="group" aria-labelledby="aiConfirmTitle">
    <strong id="aiConfirmTitle">${escapeText(action.title)}</strong>
    <p>${escapeText(action.details)}</p>
    <small>Без вашої згоди дані нікуди не надсилаються. Якщо не відповісти за 2 хвилини, агент продовжить без цього.</small>
    <div class="ai-confirm-actions">
      <button type="button" class="btn btn--secondary btn--sm" data-ai="decline">Відхилити</button>
      <button type="button" class="btn btn--primary btn--sm" data-ai="approve">Дозволити</button>
    </div>
  </div>`;
}

function statusPill(label, tone) { return `<span class="ai-status" data-tone="${tone}">${label}</span>`; }

function lastUser() { return [...state.messages].reverse().find(message => message.role === 'user' && !message.auto); }
function controls(message) {
  if (state.pending || !message.id) return '';
  const id = escapeText(message.id);
  if (message.role === 'user') return message.id === lastUser()?.id ? `<button type="button" class="ai-icon-action" data-ai="edit-message" data-id="${id}" aria-label="Редагувати останній запит">${icons.edit}</button>` : '';
  return `<button type="button" class="ai-icon-action" data-ai="vote-up" data-id="${id}" aria-label="Корисна відповідь" aria-pressed="${message.feedback === 'up'}">${icons.up}</button><button type="button" class="ai-icon-action" data-ai="vote-down" data-id="${id}" aria-label="Некорисна відповідь" aria-pressed="${message.feedback === 'down'}">${icons.down}</button>${message.id === state.messages.at(-1)?.id ? `<button type="button" class="ai-icon-action" data-ai="regenerate" aria-label="Згенерувати ще раз">${icons.retry}</button>` : ''}`;
}

function messageMarkup(message, { streaming = false } = {}) {
  // The app's own request to continue after the time limit: a quiet note, not the student's words.
  if (message.role === 'user' && message.auto) return `<p class="ai-auto-note" data-message="${escapeText(message.id ?? '')}">${icons.retry}<span>Автоматичне продовження</span></p>`;
  if (message.role === 'user') {
    const files = message.attachments?.length ? `<div class="ai-file-chips">${message.attachments.map(attachmentChip).join('')}</div>` : '';
    return `<article class="ai-msg ai-msg--user" data-message="${escapeText(message.id ?? '')}">
      ${files}
      <div class="ai-bubble">${escapeText(message.content).replace(/\n/g, '<br>')}</div>
      <div class="ai-msg-actions"><button type="button" class="ai-icon-action" data-ai="copy" data-id="${escapeText(message.id ?? '')}" aria-label="Копіювати повідомлення">${icons.copy}</button>${controls(message)}</div>
    </article>`;
  }
  const usage = message.usage;
  const agent = message.mode === 'agent';
  let status = '';
  if (message.status === 'stopped') status = statusPill('Зупинено', 'muted');
  else if (message.status === 'interrupted' && message.continued) status = statusPill('Продовжено автоматично', 'running');
  else if (message.status === 'interrupted') status = statusPill('Помилка · відповідь перервалася', 'danger');
  else if (agent) status = statusPill('Готово', 'ok');
  const meta = [
    message.skill?.name ? `Навичка «${escapeText(message.skill.name)}»` : '',
    message.modelLabel ? escapeText(message.modelLabel) : '',
    usage ? `${usage.approximate ? '≈ ' : ''}${formatTokens(usage.total)}` : ''
  ].filter(Boolean).join(' · ');
  return `<article class="ai-msg ai-msg--assistant" data-message="${escapeText(message.id ?? '')}">
    <span class="ai-avatar" aria-hidden="true">${icons.spark}</span>
    <div class="ai-answer">
      ${stepsMarkup(message.steps)}
      <div class="ai-md">${renderMarkdown(message.content)}</div>
      ${fileCards(message.files)}
      ${message.archive?.fileCount ? `<button type="button" class="btn btn--secondary btn--sm ai-zip" data-ai="zip" data-id="${escapeText(message.id ?? '')}" aria-label="Завантажити ZIP: ${message.archive.fileCount} ${fileWord(message.archive.fileCount)}">${icons.download}<span>Завантажити ZIP · ${message.archive.fileCount} ${fileWord(message.archive.fileCount)}</span></button>` : ''}
      <div class="ai-msg-actions"><button type="button" class="ai-icon-action" data-ai="copy" data-id="${escapeText(message.id ?? '')}" aria-label="Копіювати відповідь">${icons.copy}</button>${controls(message)}${status}${meta ? `<span class="ai-meta"${usage?.approximate ? ' title="Провайдер не повідомив точну кількість — показано оцінку"' : ''}>${meta}</span>` : ''}</div>
    </div>
  </article>`;
}

/** The answer being made: its steps, a confirmation if one waits, text so far, files so far. */
function queueWait(pending) {
  const until = pending.queuedUntil ? new Date(pending.queuedUntil).getTime() : 0;
  return until > Date.now() ? Math.max(1, Math.round((until - Date.now()) / 1000)) : 0;
}

function pendingMarkup(pending) {
  const wait = queueWait(pending);
  const label = pending.stopping ? 'Зупиняємо…' : pending.action ? 'Чекає на вашу відповідь' : wait ? `У черзі · ≈ ${wait} с` : 'Генерується';
  return `<article class="ai-msg ai-msg--assistant is-streaming" data-message="pending">
    <span class="ai-avatar" aria-hidden="true">${icons.spark}</span>
    <div class="ai-answer">
      ${stepsMarkup(pending.steps, { live: true })}
      ${confirmMarkup(pending.action)}
      <div class="ai-md">${pendingText(pending)}</div>
      ${fileCards(pending.files, { live: true })}
      ${wait && !pending.text ? '<p class="ai-queue-note">Зараз багато запитів до ШІ, тому відповідь стоїть у черзі. Вона почнеться сама — можна закрити застосунок.</p>' : ''}
      <div class="ai-msg-actions">${statusPill(label, 'running')}${pending.modelLabel ? `<span class="ai-meta">${escapeText(pending.modelLabel)}</span>` : ''}</div>
    </div>
  </article>`;
}

function pendingText(pending) {
  return pending.text ? renderMarkdown(pending.text, { streaming: true }) : '<span class="ai-typing" aria-label="ШІ працює над відповіддю"><i></i><i></i><i></i></span>';
}

function emptyMarkup() {
  const block = blocker();
  const agent = agentOn();
  const context = state.context;
  const homework = context?.type === 'homework';
  const list = homework ? HOMEWORK_SUGGESTIONS : context ? LESSON_SUGGESTIONS : agent ? AGENT_SUGGESTIONS : SUGGESTIONS;
  const attachHint = state.me?.limits?.attachments?.enabled ? ` Можна прикріпити ${visionAvailable() ? 'фото, ' : ''}PDF, Word, Excel, PowerPoint, текст або ZIP.` : '';
  const title = context ? `«${escapeText(context.title)}»` : '';
  const heading = homework ? 'Підказки до завдання' : context ? 'Питання про урок' : agent ? 'Що зробити?' : 'Чим допомогти?';
  const intro = homework
    ? `Асистент бачить умову ${title} і підкаже, з чого почати, але не розвʼяже завдання за вас.`
    : context
      ? `Асистент бачить матеріал уроку ${title} і пояснить, що незрозуміло.`
      : agent
        ? `Агент працює кроками: читає ваші файли, застосовує навички й створює документи — Word, PDF, презентації, таблиці.${attachHint}`
        : `Питайте про урок, ідею проєкту чи код. Асистент пояснює й підказує, а рішення лишається за вами.${attachHint}`;
  return `<div class="ai-empty">
    <span class="ai-empty-mark" aria-hidden="true">${agent ? icons.agent : icons.spark}</span>
    <h2>${heading}</h2>
    <p>${intro}</p>
    <div class="ai-suggestions">${list.map(([text, prompt]) => `<button type="button" class="ai-suggestion" data-ai="suggest" data-text="${escapeText(prompt)}" ${block ? 'disabled' : ''}>${escapeText(text)}</button>`).join('')}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Rendering

function $(selector) { return root?.querySelector(selector) ?? null; }

function renderAll() {
  if (!root?.isConnected) return;
  renderHeader();
  renderBalance();
  renderThread();
  renderComposer();
  renderLayers();
}

function renderHeader() {
  const chip = $('[data-ai="model"]');
  const model = selectedModel();
  if (!chip) return;
  chip.hidden = !model;
  if (model) {
    const several = models().length > 1;
    chip.disabled = !several || Boolean(state.pending);
    chip.innerHTML = `<span>${escapeText(model.label)}</span>${several ? icons.chevron : ''}`;
    chip.setAttribute('aria-label', several ? `Модель: ${model.label}. Змінити` : `Модель: ${model.label}`);
  }
}

function renderBalance() {
  const node = $('#aiBalance');
  if (!node) return;
  if (!state.me) { node.innerHTML = state.loadError ? '' : '<span class="ai-skeleton"></span>'; node.dataset.tone = 'muted'; return; }
  const block = blocker();
  if (block) { node.dataset.tone = block.tone; node.innerHTML = `<strong>${escapeText(block.text)}</strong>`; return; }
  const balance = state.me.balance;
  node.dataset.tone = balance.low ? 'low' : 'ok';
  node.innerHTML = `<span>Залишилось: <strong>${formatTokens(balance.available)}</strong></span>${balance.low ? '<small>Ліміт закінчується</small>' : ''}`;
}

function pendingHere() {
  const pending = state.pending;
  return pending && (pending.conversationId === (state.currentId ?? 'new') || pending.conversationId === state.currentId) ? pending : null;
}

function renderThread() {
  const thread = $('#aiThread');
  if (!thread) return;
  if (!state.loaded && state.loading) {
    thread.innerHTML = '<div class="ai-loading"><span class="ai-skeleton"></span><span class="ai-skeleton"></span><span class="ai-skeleton short"></span></div>';
    return;
  }
  if (state.loadError) {
    thread.innerHTML = `<div class="ai-state-card" role="alert"><strong>Не вдалося завантажити чати</strong><p>${escapeText(state.loadError)}</p><button type="button" class="btn btn--secondary" data-ai="reload">Спробувати ще раз</button></div>`;
    return;
  }
  if (state.messagesLoading) {
    thread.innerHTML = '<div class="ai-loading"><span class="ai-skeleton"></span><span class="ai-skeleton short"></span></div>';
    return;
  }
  const pending = pendingHere();
  const items = state.messages.map(message => messageMarkup(message));
  if (pending) {
    items.push(messageMarkup({ ...pending.user, id: 'pending-user' }));
    items.push(pendingMarkup(pending));
  }
  if (state.error) {
    items.push(`<div class="ai-error" role="alert"><strong>${escapeText(state.error.message)}</strong>${state.error.retryText ? '<button type="button" class="btn btn--secondary btn--sm" data-ai="retry">Спробувати ще раз</button>' : ''}</div>`);
  }
  thread.innerHTML = items.length ? items.join('') : emptyMarkup();
  thread.setAttribute('aria-busy', pending ? 'true' : 'false');
  if (state.stick) thread.scrollTop = thread.scrollHeight;
  updateToBottom();
}

/** While text streams only the growing answer is redrawn, at most once per frame. */
function schedulePendingRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const node = root?.querySelector('[data-message="pending"] .ai-md');
    if (!node || !state.pending) return;
    node.innerHTML = pendingText(state.pending);
    const thread = $('#aiThread');
    if (thread && state.stick) thread.scrollTop = thread.scrollHeight;
    updateToBottom();
  });
}

function renderComposer() {
  const input = $('#aiInput');
  const send = $('#aiSend');
  const hint = $('#aiHint');
  if (!input || !send) return;
  const block = blocker();
  const limit = state.me?.limits?.maxMessageChars ?? 8000;
  input.disabled = Boolean(block) || !state.me;
  input.placeholder = block ? 'Надсилання зараз недоступне' : agentOn() ? 'Опишіть завдання: наприклад, «Зроби конспект у Word»' : 'Напишіть питання…';
  input.maxLength = limit;
  const busy = state.attachments.some(item => item.status === 'uploading' || item.status === 'processing');
  if (state.pending) {
    send.innerHTML = icons.stop;
    send.className = 'btn btn--icon btn--danger ai-send';
    send.setAttribute('aria-label', state.pending.stopping ? 'Зупиняємо' : 'Зупинити генерацію');
    send.dataset.mode = 'stop';
    send.disabled = Boolean(state.pending.stopping);
  } else {
    send.innerHTML = icons.send;
    send.className = 'btn btn--icon btn--primary ai-send';
    send.setAttribute('aria-label', 'Надіслати');
    send.dataset.mode = 'send';
    const ready = state.attachments.some(item => item.status === 'ready');
    send.disabled = Boolean(block) || !state.me || busy || (!input.value.trim() && !ready);
  }
  const attach = $('[data-ai="attach"]');
  const max = state.me?.limits?.attachments?.maxPerMessage ?? 1;
  if (attach) {
    attach.hidden = !state.me?.limits?.attachments?.enabled;
    attach.disabled = Boolean(block) || !state.me || Boolean(state.pending) || Boolean(state.reviseMessageId) || state.attachments.length >= max;
    $('#aiComposer')?.classList.toggle('can-attach', !attach.hidden);
  }
  renderTools();
  const picker = $('#aiFile');
  if (picker) picker.accept = pickerAccept();
  renderHeader();
  const length = input.value.length;
  if (hint) {
    hint.textContent = length > limit * 0.8 ? `${numberFormat.format(length)} / ${numberFormat.format(limit)}` : '';
    hint.dataset.tone = length >= limit ? 'danger' : '';
  }
  renderAttachments();
  autosize(input);
}

function renderTools() {
  const note = $('#aiContextNote');
  if (note) {
    note.hidden = !state.context && !state.reviseMessageId;
    note.innerHTML = state.reviseMessageId ? '<span class="ai-context-text">Редагування останнього запиту</span><button type="button" class="ai-icon-action" data-ai="cancel-edit">Скасувати</button>' : state.context ? `<span class="ai-context-text">${escapeText((state.context.type === 'homework' ? 'Підказки до завдання: ' : 'Урок: ') + state.context.title)}</span>` : '';
  }
  const tools = $('#aiTools');
  if (!tools) return;
  const agentChip = tools.querySelector('[data-ai="agent"]');
  const skillChip = tools.querySelector('[data-ai="skills"]');
  const showAgent = Boolean(state.me?.agent?.enabled);
  const showSkills = skills().length > 0;
  tools.hidden = !showAgent && !showSkills;
  if (agentChip) {
    agentChip.hidden = !showAgent;
    const unsupported = showAgent && !agentAvailable();
    agentChip.setAttribute('aria-pressed', String(agentOn()));
    agentChip.disabled = Boolean(state.pending) || unsupported;
    agentChip.title = unsupported ? 'Жодна доступна модель не працює в режимі агента' : 'Агент виконує завдання кроками: читає файли й створює документи';
  }
  if (skillChip) {
    skillChip.hidden = !showSkills;
    skillChip.disabled = Boolean(state.pending);
    const skill = selectedSkill();
    skillChip.querySelector('span').textContent = skill ? `Навичка: ${skill.name}` : agentOn() ? 'Навичка: авто' : 'Без навички';
    skillChip.setAttribute('aria-expanded', String(state.sheet === 'skill'));
    skillChip.classList.toggle('is-set', Boolean(skill));
  }
}

function attachmentStatus(item) {
  if (item.status === 'uploading') return `Завантаження… ${Math.round((item.progress ?? 0) * 100)}%`;
  if (item.status === 'processing') return 'Читаємо файл…';
  if (item.status === 'error') return item.error;
  const kind = item.kind ?? 'zip';
  if (kind === 'zip') return `${item.files.length} ${fileWord(item.files.length)} для ШІ · ≈ ${formatTokens(item.estimatedTokens)}${item.skipped?.length ? ` · пропущено ${item.skipped.length}` : ''}`;
  if (item.scanned) return `Скан без тексту, ${item.pages ?? '?'} стор. — прочитає лише модель, що розпізнає скани`;
  const facts = [KIND_LABEL[kind], item.pages ? `${item.pages} стор.` : '', item.slides ? `${item.slides} слайдів` : '', item.sheets ? `${item.sheets.length} ${plural(item.sheets.length, 'аркуш', 'аркуші', 'аркушів')}` : '', `≈ ${formatTokens(item.estimatedTokens)}`].filter(Boolean);
  return facts.join(' · ');
}

/** The files waiting to be sent: progress, what the server found inside, or what went wrong. */
function renderAttachments() {
  const row = $('#aiAttachment');
  if (!row) return;
  row.hidden = !state.attachments.length;
  row.innerHTML = state.attachments.map(item => {
    const progress = item.status === 'uploading' ? `<span class="ai-attachment-progress" aria-hidden="true"><i style="width:${Math.round((item.progress ?? 0) * 100)}%"></i></span>` : '';
    const notes = [...(item.warnings ?? []), ...(item.skipped ?? []).slice(0, 12).map(skip => `${skip.path}: ${skip.reason}`)];
    return `<div class="ai-attachment" data-state="${item.status}" data-key="${item.key}">
      <span class="ai-attachment-icon" aria-hidden="true">${(item.kind ?? 'zip') === 'zip' ? icons.archive : PHOTO_KINDS.has(item.kind) ? icons.photo : icons.doc}</span>
      <span class="ai-attachment-text"><strong>${escapeText(item.name)}</strong><small role="status"${notes.length ? ` title="${escapeText(notes.join('\n'))}"` : ''}>${escapeText(attachmentStatus(item))}</small>${progress}</span>
      ${item.status === 'error' && item.retryable ? `<button type="button" class="ai-icon-action" data-ai="attachment-retry" data-key="${item.key}" aria-label="Завантажити «${escapeText(item.name)}» ще раз">${icons.retry}</button>` : '<span></span>'}
      <button type="button" class="ai-icon-action" data-ai="attachment-remove" data-key="${item.key}" aria-label="Прибрати ${escapeText(item.name)}">${icons.close}</button>
    </div>`;
  }).join('');
}

function renderLayers() {
  const drawer = $('#aiDrawer'), sheet = $('#aiSheet'), scrim = $('.ai-scrim');
  if (!drawer || !sheet || !scrim) return;
  drawer.hidden = !state.drawer;
  sheet.hidden = !state.sheet;
  scrim.hidden = !state.drawer && !state.sheet;
  $('[data-ai="chats"]')?.setAttribute('aria-expanded', String(state.drawer));
  $('[data-ai="model"]')?.setAttribute('aria-expanded', String(state.sheet === 'model'));
  $('[data-ai="skills"]')?.setAttribute('aria-expanded', String(state.sheet === 'skill'));
  if (state.drawer) renderDrawerList();
  if (state.sheet) renderSheetList();
}

function chatStatus(item) {
  const job = item.job;
  if (!job) return '';
  if (ACTIVE.has(job.status) || state.pending?.conversationId === item.id) return statusPill('Генерується', 'running');
  if ((job.status === 'error' || job.status === 'interrupted') && job.unseen) return statusPill('Помилка', 'danger');
  if (job.status === 'complete' && job.unseen) return statusPill('Готово', 'ok');
  return '';
}

function renderDrawerList() {
  const list = $('#aiDrawerList');
  if (!list) return;
  if (!state.conversations.length) {
    list.innerHTML = '<p class="ai-drawer-empty">Тут зʼявляться ваші чати. Почніть з першого питання.</p>';
    return;
  }
  list.innerHTML = state.conversations.map(item => {
    const current = item.id === state.currentId;
    if (state.renaming === item.id) {
      return `<form class="ai-chat-item is-editing" data-ai-rename="${escapeText(item.id)}">
        <label class="visually-hidden" for="aiRenameInput">Нова назва чату</label>
        <input id="aiRenameInput" class="field-input" maxlength="80" value="${escapeText(item.title)}" required>
        <div class="ai-chat-item-actions"><button type="button" class="btn btn--ghost btn--sm" data-ai="rename-cancel">Скасувати</button><button type="submit" class="btn btn--primary btn--sm">Зберегти</button></div>
      </form>`;
    }
    if (state.confirmDelete === item.id) {
      return `<div class="ai-chat-item is-confirm" role="alertdialog" aria-labelledby="aiDeleteText">
        <p id="aiDeleteText">Видалити чат «${escapeText(item.title)}»? Повідомлення, файли та сайти з цього чату зникнуть назавжди. Опубліковані сайти також перестануть відкриватися.</p>
        <div class="ai-chat-item-actions"><button type="button" class="btn btn--ghost btn--sm" data-ai="delete-cancel">Скасувати</button><button type="button" class="btn btn--danger btn--sm" data-ai="delete-confirm" data-id="${escapeText(item.id)}">Видалити</button></div>
      </div>`;
    }
    return `<div class="ai-chat-item${current ? ' is-current' : ''}">
      <button type="button" class="ai-chat-open" data-ai="open" data-id="${escapeText(item.id)}" ${current ? 'aria-current="true"' : ''}>
        <strong>${escapeText(item.title)}</strong>
        <small>${chatStatus(item)}${escapeText(shortTime(item.updatedAt))}${item.preview ? ` · ${escapeText(item.preview)}` : ''}</small>
      </button>
      <button type="button" class="ai-icon-action" data-ai="rename" data-id="${escapeText(item.id)}" aria-label="Перейменувати «${escapeText(item.title)}»">${icons.edit}</button>
      <button type="button" class="ai-icon-action is-danger" data-ai="delete" data-id="${escapeText(item.id)}" aria-label="Видалити «${escapeText(item.title)}»" ${state.pending?.conversationId === item.id ? 'disabled' : ''}>${icons.trash}</button>
    </div>`;
  }).join('');
  const rename = list.querySelector('#aiRenameInput');
  if (rename) { rename.focus(); rename.select(); }
}

function renderSheetList() {
  const list = $('#aiSheetList');
  const title = $('#aiSheetTitle');
  if (!list) return;
  if (state.sheet === 'skill') {
    if (title) title.textContent = 'Навичка';
    const selected = selectedSkill();
    const option = (id, name, description) => `<button type="button" class="ai-model-option${(selected?.id ?? null) === id ? ' is-selected' : ''}" data-ai="pick-skill" data-id="${escapeText(id ?? '')}" role="menuitemradio" aria-checked="${(selected?.id ?? null) === id}">
      <span><strong>${escapeText(name)}</strong><small>${escapeText(description)}</small></span>${(selected?.id ?? null) === id ? icons.check : ''}
    </button>`;
    list.innerHTML = [
      option(null, agentOn() ? 'Авто' : 'Без навички', agentOn() ? 'Агент сам обере навичку, якщо вона підходить до завдання' : 'Звичайна відповідь асистента'),
      ...skills().map(skill => option(skill.id, skill.name, skill.description))
    ].join('');
    return;
  }
  if (title) title.textContent = 'Модель';
  const selected = selectedModel();
  const agent = agentOn();
  list.innerHTML = models().map(model => {
    const unusable = agent && model.agent === false;
    const facts = [familyLabel(model.family), model.vision ? 'бачить фото' : '', model.id === state.me?.agent?.defaultModelId ? 'для агента' : '', model.agent === false ? 'без режиму агента' : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="ai-model-option${model.id === selected?.id ? ' is-selected' : ''}" data-ai="pick-model" data-id="${escapeText(model.id)}" role="menuitemradio" aria-checked="${model.id === selected?.id}" ${unusable ? 'disabled' : ''}>
    <span><strong>${escapeText(model.label)}</strong><small>${escapeText(facts)}</small></span>${model.id === selected?.id ? icons.check : ''}
  </button>`;
  }).join('');
}

function familyLabel(family) {
  return ({ gpt: 'OpenAI GPT', claude: 'Anthropic Claude', gemini: 'Google Gemini', deepseek: 'DeepSeek', qwen: 'Qwen', llama: 'Llama', mistral: 'Mistral' })[family] ?? 'Модель провайдера';
}

function autosize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  // A scrollbar only once the field reaches its maximum height.
  input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
}

function updateToBottom() {
  const thread = $('#aiThread');
  const button = $('[data-ai="to-bottom"]');
  if (!thread || !button) return;
  button.hidden = state.stick || thread.scrollHeight <= thread.clientHeight + 4;
}

// ---------------------------------------------------------------------------------------------
// Data

async function load({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) { state.loadError = ''; renderAll(); }
  try {
    const [me, list] = await Promise.all([deps.api.aiMe(), deps.api.aiConversations()]);
    state.me = me;
    state.conversations = list.conversations;
    state.loaded = true;
    state.loadError = '';
    if (state.currentId && !state.conversations.some(item => item.id === state.currentId) && state.pending?.conversationId !== state.currentId) setCurrent(null);
    // Coming back to the assistant: an answer still being written is the first thing to see.
    if (!state.currentId && !state.pending) {
      const running = state.conversations.find(item => item.job && ACTIVE.has(item.job.status));
      if (running) setCurrent(running.id);
    }
    if (!models().some(model => model.id === state.modelId)) state.modelId = currentConversation()?.modelId && models().some(model => model.id === currentConversation().modelId) ? currentConversation().modelId : me.defaultModelId;
    if (state.skillId && !skills().some(skill => skill.id === state.skillId)) state.skillId = null;
    if (state.currentId && state.messagesFor !== state.currentId) await openConversation(state.currentId, { silent: true });
  } catch (error) {
    if (!state.loaded) state.loadError = error.message || 'Перевірте зʼєднання та спробуйте ще раз.';
  } finally {
    state.loading = false;
    renderAll();
  }
}

function setCurrent(id) {
  state.currentId = id;
  writeStorage(CURRENT_KEY, id);
}

function acknowledged(jobId) { return (readStorage(ACK_KEY) ?? '').split(',').includes(jobId); }
function acknowledge(jobId) { writeStorage(ACK_KEY, [...(readStorage(ACK_KEY) ?? '').split(',').filter(Boolean).slice(-20), jobId].join(',')); }

// A run cut off by the time limit goes on by itself, even before its first file. The app asks once per job and
// tab; the server starts a continuation only once whatever asks, so another tab or a reopen is harmless.
// The job counts as continued only after the server answered (started it, or it was continued elsewhere):
// a request lost to the network or a busy server is tried again, a few times, with growing pauses.
const RESUMED_KEY = 'aiss-ai-resumed';
const RESUME_TRIES = 3;
const resumeTries = new Map();
function resumed(jobId) { return (readStorage(RESUMED_KEY) ?? '').split(',').includes(jobId); }
function markResumed(jobId) {
  resumeTries.delete(jobId);
  if (!resumed(jobId)) writeStorage(RESUMED_KEY, [...(readStorage(RESUMED_KEY) ?? '').split(',').filter(Boolean).slice(-20), jobId].join(','));
}
function scheduleResume(conversationId, jobId, delay = 1200) {
  if (!jobId || resumed(jobId) || (resumeTries.get(jobId) ?? 0) >= RESUME_TRIES) return;
  setTimeout(() => {
    if (resumed(jobId) || state.pending || state.currentId !== conversationId || !root?.isConnected) return;
    resumeTries.set(jobId, (resumeTries.get(jobId) ?? 0) + 1);
    void send('', { resumeJobId: jobId });
  }, delay);
}

async function openConversation(id, { silent = false } = {}) {
  setCurrent(id);
  state.error = null;
  state.stick = true;
  state.messagesLoading = true;
  if (!silent) renderAll();
  try {
    const result = await deps.api.aiConversation(id);
    if (state.currentId !== id) return;
    state.messages = result.messages;
    state.context = result.conversation.context ?? null;
    state.reviseMessageId = null;
    state.messagesFor = id;
    const modelId = result.conversation.modelId;
    if (modelId && models().some(model => model.id === modelId)) { state.modelId = modelId; state.modelPicked = false; }
    const job = result.job;
    if (job && ACTIVE.has(job.status) && (!state.pending || state.pending.jobId !== job.id)) {
      // Reconnect to the answer the server is still writing.
      state.pending = pendingFromJob(job);
      void follow(state.pending);
    } else if (job && !ACTIVE.has(job.status) && job.resume) {
      // The app was closed when the time limit hit: continue now that the chat is open again.
      scheduleResume(id, job.id);
    } else if (job && !ACTIVE.has(job.status) && job.error && !job.message && !acknowledged(job.id)) {
      acknowledge(job.id);
      state.error = { message: job.error.message };
    }
  } catch (error) {
    if (error.status === 404) { setCurrent(null); state.messages = []; state.messagesFor = null; await refreshList(); }
    else state.error = { message: error.message || 'Не вдалося відкрити чат' };
  } finally {
    state.messagesLoading = false;
    if (!silent) renderAll();
  }
  const input = $('#aiInput');
  if (input) input.value = readStorage(`${DRAFT_KEY}:${id}`) ?? '';
}

async function refreshList() {
  try { state.conversations = (await deps.api.aiConversations()).conversations; } catch {}
  if (state.drawer) renderDrawerList();
}

async function refreshMe() {
  try { state.me = await deps.api.aiMe(); } catch {}
  renderBalance();
  renderComposer();
  renderHeader();
}

export function aiStartLearningContext(context) {
  if (state.pending) return false;
  newChat(); state.context = context;
  state.skillId = context.type === 'homework' ? 'skill-homework-hints' : null;
  state.agent = false;
  writeStorage(DRAFT_KEY + ':new', context.type === 'homework' ? 'Допоможи розібратися із завданням. З чого почати?' : 'Поясни головну ідею цього уроку простими словами.');
  return true;
}

function newChat() {
  if (state.pending) return;
  setCurrent(null);
  state.reviseMessageId = null;
  state.context = null;
  state.messages = [];
  state.messagesFor = null;
  state.error = null;
  state.modelId = state.me?.defaultModelId ?? state.modelId;
  state.modelPicked = false;
  state.drawer = false;
  const input = $('#aiInput');
  if (input) input.value = readStorage(`${DRAFT_KEY}:new`) ?? '';
  renderAll();
  input?.focus();
}

// ---------------------------------------------------------------------------------------------
// Answers. A send starts a job on the server and watches it through a stream. If the stream breaks
// or the app goes to the background, the job keeps going; the app follows it again by asking for
// what was written after the part it already shows.

async function readEvents(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const frameText = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = 'message';
      const data = [];
      for (const line of frameText.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(event, JSON.parse(data.join('\n')));
    }
    if (done) return;
  }
}

function pendingFromJob(job) {
  return {
    jobId: job.id, conversationId: job.conversationId, user: job.userMessage ?? { role: 'user', content: '' },
    text: job.mode === 'agent' ? '' : job.text ?? '', offset: job.mode === 'agent' ? 0 : job.offset ?? 0,
    modelLabel: job.model?.label ?? '', mode: job.mode ?? 'chat', steps: job.steps ?? [], files: job.files ?? [], action: job.pending ?? null, queuedUntil: job.queuedUntil ?? null,
    controller: null, viewing: null, finished: false, stopping: false, sentAttachments: []
  };
}

function finishPending(pending) {
  pending.finished = true;
  if (state.pending === pending) state.pending = null;
}

/** Shows a finished job: its saved message, or what went wrong. */
function showFinished(pending, result) {
  finishPending(pending);
  acknowledge(pending.jobId);
  if (result.message && state.currentId === result.conversationId && !state.messages.some(item => item.id === result.message.id)) {
    const user = result.userMessage ?? pending.user;
    if (user && !state.messages.some(item => item.id === user.id)) state.messages.push(user);
    state.messages.push(result.message);
    if (user?.revision) {
      state.messages = state.messages.filter(message => ![user.revision.userId, user.revision.assistantId].includes(message.id));
    }
    state.reviseMessageId = null;
  }
  if (result.message) {
    // Sent files belong to the chat now; files of an unanswered message stay attached for another try.
    const sent = new Set((result.userMessage ?? pending.user)?.attachments?.map(item => item.id) ?? []);
    state.attachments = state.attachments.filter(item => !sent.has(item.id));
  }
  const field = $('#aiInput');
  if (result.resume && result.message) { state.error = null; scheduleResume(result.conversationId, pending.jobId); }
  else if (result.error) state.error = { message: result.error.message, ...(result.message || pending.user?.auto ? {} : { retryText: pending.user?.content }) };
  if (!result.message && field && !field.value && pending.user?.content && !pending.user.auto) field.value = pending.user.content;
  if (result.balance && state.me) state.me.balance = { ...state.me.balance, available: result.balance.available, exhausted: result.balance.exhausted };
  void refreshMe();
  void refreshList();
  deps.haptic?.(result.message ? 'success' : result.error ? 'error' : 'selection');
  renderAll();
}

function applyView(pending, view) {
  const structural = JSON.stringify([view.steps, view.files, view.pending, view.queuedUntil ?? null]) !== JSON.stringify([pending.steps, pending.files, pending.action, pending.queuedUntil ?? null]);
  pending.queuedUntil = view.queuedUntil ?? null;
  pending.text += view.text ?? '';
  pending.offset = view.offset ?? pending.offset;
  pending.steps = view.steps ?? [];
  pending.files = view.files ?? [];
  pending.action = view.pending ?? null;
  pending.modelLabel = view.model?.label ?? pending.modelLabel;
  if (structural) renderThread(); else if (view.text) schedulePendingRender();
}

/** Follows a job by polling while the app is in front; pauses while it is hidden. */
async function follow(pending) {
  if (pending.following) return;
  pending.following = true;
  pending.viewing = 'poll';
  let delay = 900;
  try {
    while (state.pending === pending && !pending.finished && root?.isConnected) {
      if (appHidden || document.visibilityState === 'hidden') { await sleep(800); continue; }
      try {
        const view = await deps.api.aiJob(pending.jobId, pending.offset);
        if (state.pending !== pending) return;
        applyView(pending, view);
        delay = 900;
        if (!ACTIVE.has(view.status)) {
          showFinished(pending, {
            conversationId: view.conversationId, message: view.message, userMessage: view.userMessage,
            error: view.status === 'stopped' ? null : view.error, resume: view.resume ?? null
          });
          return;
        }
      } catch (error) {
        if (error.status === 404) { finishPending(pending); state.error = { message: 'Цю відповідь не знайдено.' }; renderAll(); return; }
        delay = Math.min(delay * 2, 8000);
      }
      await sleep(delay);
    }
  } finally {
    pending.following = false;
    if (pending.viewing === 'poll') pending.viewing = null;
  }
}

/** The stream is gone but the job goes on: keep showing it from the server's copy. */
function detach(pending) {
  if (pending.finished || !pending.jobId) return;
  pending.controller?.abort();
  pending.controller = null;
  // Agent drafts are not stored; the server's copy holds only the final answer.
  if (pending.mode === 'agent') { pending.text = ''; pending.offset = 0; }
  else pending.offset = bytesOf(pending.text);
  pending.viewing = null;
  renderThread();
  void follow(pending);
}

/** Sends the student's message, or with resumeJobId asks the server to continue a run cut off by the time limit. */
async function send(rawText, { resumeJobId = null } = {}) {
  const text = resumeJobId ? '' : String(rawText ?? '').trim();
  const ready = resumeJobId ? [] : state.attachments.filter(item => item.status === 'ready');
  if (!resumeJobId && state.attachments.some(item => item.status === 'uploading' || item.status === 'processing')) return;
  if ((!text && !ready.length && !resumeJobId) || state.pending || blocker() || !state.me) return;
  const limit = state.me.limits?.maxMessageChars ?? 8000;
  if (text.length > limit) { state.error = { message: `Повідомлення задовге: максимум ${numberFormat.format(limit)} символів` }; renderThread(); return; }
  const conversationId = state.currentId ?? 'new';
  const model = selectedModel();
  if (ready.some(item => PHOTO_KINDS.has(item.kind)) && !model?.vision) { state.error = { message: 'Для фото оберіть модель з позначкою «бачить фото».' }; renderThread(); return; }
  const agent = resumeJobId ? true : agentOn();
  const skill = resumeJobId ? null : selectedSkill();
  const controller = new AbortController();
  const pending = {
    jobId: null, conversationId,
    user: resumeJobId
      ? { role: 'user', content: 'Автоматичне продовження', auto: true, createdAt: new Date().toISOString() }
      : { role: 'user', content: text || 'Переглянь прикріплені файли.', createdAt: new Date().toISOString(), ...(ready.length ? { attachments: ready.map(item => ({ id: item.id, name: item.name, size: item.size, fileCount: item.files.length, kind: item.kind, ...(item.pages ? { pages: item.pages } : {}) })) } : {}) },
    text: '', offset: 0, modelLabel: model?.label ?? '', mode: agent ? 'agent' : 'chat',
    steps: skill ? [{ id: 'local-skill', kind: 'skill', label: `Навичка «${skill.name}»`, status: 'done' }] : [], files: [], action: null,
    controller, viewing: 'stream', finished: false, stopping: false
  };
  state.pending = pending;
  state.error = null;
  state.stick = true;
  const input = $('#aiInput');
  if (!resumeJobId && input && input.value.trim() === text) { input.value = ''; writeStorage(`${DRAFT_KEY}:${conversationId}`, null); }
  renderAll();
  deps.haptic?.('selection');

  try {
    // A continuation keeps the cut-off run's model and skill on the server; only the job is named.
    const response = await deps.api.aiStream(conversationId, resumeJobId ? { content: '', clientRequestId: crypto.randomUUID(), continueJobId: resumeJobId, mode: 'agent' } : {
      content: text, clientRequestId: crypto.randomUUID(),
      ...(state.reviseMessageId ? { reviseMessageId: state.reviseMessageId } : {}),
      ...(state.context ? { context: { type: state.context.type, id: state.context.id } } : {}),
      ...(model ? { modelId: model.id } : {}), ...(ready.length ? { attachmentIds: ready.map(item => item.id) } : {}),
      mode: agent ? 'agent' : 'chat', ...(skill ? { skillId: skill.id } : {})
    }, controller.signal);
    await readEvents(response.body, (event, data) => {
      if (state.pending !== pending || pending.viewing !== 'stream') return;
      // The student left the assistant screen: stop watching; it follows the job again on return.
      if (!root?.isConnected && pending.jobId && event !== 'done' && event !== 'error') { pending.viewing = null; pending.controller?.abort(); pending.controller = null; return; }
      switch (event) {
        case 'start':
          if (resumeJobId) markResumed(resumeJobId);
          pending.jobId = data.jobId;
          pending.conversationId = data.conversationId;
          pending.modelLabel = data.model?.label ?? pending.modelLabel;
          if (data.model?.id && models().some(item => item.id === data.model.id)) state.modelId = data.model.id;
          pending.mode = data.mode ?? pending.mode;
          pending.steps = data.steps ?? pending.steps;
          if (data.userMessage) pending.user = data.userMessage;
          if (conversationId === 'new' && state.currentId === null) { setCurrent(data.conversationId); state.messagesFor = data.conversationId; }
          if (pending.stopAfterStart) void stopPending();
          void refreshList();
          renderThread();
          return;
        case 'delta': if (pending.queuedUntil) { pending.queuedUntil = null; renderThread(); } pending.text += data.text; schedulePendingRender(); return;
        case 'queue': pending.queuedUntil = data.until ? new Date(data.until).toISOString() : null; renderThread(); return;
        case 'reset': pending.text = ''; schedulePendingRender(); return;
        case 'steps': pending.steps = data.steps ?? []; renderThread(); return;
        case 'files': pending.files = data.files ?? []; renderThread(); return;
        case 'confirm': pending.action = data.pending ?? null; renderThread(); if (pending.action) deps.haptic?.('warning'); return;
        case 'model': pending.modelLabel = data.label; renderHeader(); return;
        case 'attach': if (resumeJobId) markResumed(resumeJobId); pending.jobId = data.jobId; pending.conversationId = data.conversationId; detach(pending); return;
        case 'done':
          showFinished(pending, { conversationId: data.conversationId, message: data.message, userMessage: data.userMessage, error: data.error ?? null, balance: data.balance, resume: data.resume ?? null });
          return;
        case 'error':
          showFinished(pending, { conversationId: data.conversationId ?? pending.conversationId, message: null, userMessage: null, error: { message: data.message }, balance: data.balance });
          return;
      }
    });
    if (!pending.finished && state.pending === pending && pending.viewing === 'stream') {
      if (pending.jobId) detach(pending);
      else { finishPending(pending); state.error = { message: 'Зʼєднання перервалося. Перевіряємо, що збереглося…' }; renderAll(); setTimeout(syncAfterInterruption, 1200); }
    }
  } catch (error) {
    if (pending.finished || state.pending !== pending || pending.viewing !== 'stream') return;
    if (pending.jobId) { detach(pending); return; }
    finishPending(pending);
    // Already continued elsewhere (another tab, a reopened app): just show what is there now.
    if (resumeJobId && error.code === 'AI_RESUME_STALE') { markResumed(resumeJobId); if (state.currentId) await openConversation(state.currentId, { silent: true }); }
    else if (resumeJobId && (!error.status || error.status === 429 || error.status >= 500)) {
      // Not continued yet: try again shortly (the server joins repeated asks into one continuation).
      scheduleResume(conversationId, resumeJobId, 4000 * (resumeTries.get(resumeJobId) ?? 1));
      if (!error.status) setTimeout(syncAfterInterruption, 1200);
    }
    else if (error.status) handleRefusal(error, text);
    else { state.error = { message: 'Зʼєднання перервалося. Перевіряємо, що збереглося…' }; setTimeout(syncAfterInterruption, 1200); }
    renderAll();
  }
}

/** «Стоп»: the only way to end an answer early. The server finishes it and the stream or poll shows the result. */
async function stopPending() {
  const pending = state.pending;
  if (!pending || pending.stopping) return;
  if (!pending.jobId) { pending.stopAfterStart = true; pending.stopping = true; renderComposer(); renderThread(); return; }
  pending.stopping = true;
  renderComposer();
  renderThread();
  try { await deps.api.aiStopJob(pending.jobId); }
  catch (error) {
    pending.stopping = false;
    state.error = { message: error.message || 'Не вдалося зупинити. Спробуйте ще раз.' };
    renderAll();
  }
}

async function answerConfirmation(approve, button) {
  const pending = state.pending;
  if (!pending?.action || !pending.jobId) return;
  const stepId = pending.action.stepId;
  root.querySelectorAll('.ai-confirm button').forEach(item => { item.disabled = true; });
  button?.setAttribute('aria-busy', 'true');
  try {
    await deps.api.aiConfirmJob(pending.jobId, { stepId, approve });
    if (pending.action?.stepId === stepId) pending.action = null;
    deps.haptic?.(approve ? 'success' : 'selection');
  } catch (error) {
    if (error.status === 409) pending.action = null;
    else state.error = { message: error.message || 'Не вдалося передати відповідь. Спробуйте ще раз.' };
  }
  renderThread();
}

function handleRefusal(error, text) {
  const input = $('#aiInput');
  if (input && !input.value) input.value = text;
  if (['AI_ATTACHMENT_SENT', 'AI_ATTACHMENT_NOT_FOUND'].includes(error.code)) {
    state.attachments = state.attachments.filter(item => item.status !== 'ready');
    state.error = { message: `${error.message} Прикріпіть файл ще раз.` };
    return;
  }
  if (error.code === 'AI_LIMIT_EXHAUSTED' && state.me) { state.me.balance = { ...state.me.balance, available: 0, exhausted: true }; return; }
  if (error.code === 'AI_ACCESS_BLOCKED' && state.me) { state.me.balance = { ...state.me.balance, blocked: true }; return; }
  if (error.code === 'AI_NOT_CONFIGURED' && state.me) { state.me.configured = false; return; }
  if (error.code === 'AI_BUSY' && state.currentId) { void openConversation(state.currentId, { silent: true }).then(renderAll); }
  if (['AI_MODEL_FORBIDDEN', 'AI_CONVERSATION_NOT_FOUND', 'AI_SKILL_NOT_FOUND', 'AI_AGENT_DISABLED', 'AI_AGENT_UNSUPPORTED'].includes(error.code)) { void load({ quiet: true }); }
  state.error = { message: error.message, ...(error.status >= 500 || error.status === 429 ? { retryText: text } : {}) };
  deps.haptic?.('error');
}

async function syncAfterInterruption() {
  await Promise.all([refreshMe(), refreshList()]);
  if (state.currentId && !state.pending) await openConversation(state.currentId, { silent: true });
  if (state.error?.message?.startsWith('Зʼєднання перервалося')) state.error = { message: 'Зʼєднання перервалося. Збережене показано вище.' };
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// Files. Students' files go straight to private storage and the server reads them; files from the
// assistant come back through short signed links that Telegram's own downloader can open.

let attachmentKey = 0;

async function uploadAttachment(item) {
  item.status = 'uploading';
  item.progress = 0;
  item.error = '';
  renderComposer();
  const current = () => state.attachments.includes(item);
  try {
    if (PHOTO_KINDS.has(item.kind) && !item.prepared) {
      item.file = await preparePhoto(item.file);
      if (!current()) return;
      item.name = item.file.name; item.size = item.file.size; item.kind = 'jpg'; item.prepared = true;
    }
    if (!item.id) {
      const reserved = await deps.api.aiReserveAttachment({ name: item.name, size: item.size });
      item.id = reserved.attachment.id;
      item.upload = reserved.upload;
    }
    await sendFile(item.upload, item.file, {
      onStart: xhr => { item.xhr = xhr; },
      onProgress: share => { item.progress = share; if (current()) renderAttachments(); }
    });
    if (!current()) return;
    item.status = 'processing';
    renderComposer();
    const ready = await deps.api.aiCompleteAttachment(item.id);
    if (!current()) return;
    Object.assign(item, {
      status: 'ready', kind: ready.kind ?? item.kind, files: ready.files ?? [], skipped: ready.skipped ?? [], estimatedTokens: ready.estimatedTokens ?? 0,
      pages: ready.pages, slides: ready.slides, sheets: ready.sheets, scanned: ready.scanned, warnings: ready.warnings ?? []
    });
    deps.haptic?.('success');
  } catch (error) {
    if (!current() || error.aborted) return;
    // A rejected file is gone on the server; an expired link or a lost connection can be retried.
    const final = ['AI_ATTACHMENT_INVALID', 'AI_ATTACHMENT_NO_TEXT', 'AI_ATTACHMENT_TYPE', 'AI_ATTACHMENT_TOO_LARGE', 'AI_ATTACHMENT_EMPTY', 'AI_ATTACHMENT_LIMIT', 'FILE_SIZE_MISMATCH'].includes(error.code);
    if (final || error.expired) { item.id = null; item.upload = null; }
    Object.assign(item, { status: 'error', error: error.message || 'Не вдалося прикріпити файл.', retryable: !final || error.expired });
    deps.haptic?.('error');
  }
  renderComposer();
}

function attachFiles(fileList) {
  if (!state.me) return;
  const kinds = attachmentKinds();
  const max = state.me.limits?.attachments?.maxPerMessage ?? 1;
  for (const file of [...(fileList ?? [])]) {
    if (state.attachments.length >= max) { state.error = { message: `До одного повідомлення можна прикріпити до ${max} ${fileWord(max)}.` }; break; }
    const extension = (/\.([^.]+)$/.exec(file.name)?.[1] ?? '').toLowerCase().replace('markdown', 'md').replace('jpeg', 'jpg');
    const kind = kinds.find(item => item.extension === extension);
    const photo = PHOTO_KINDS.has(extension);
    const base = { key: `a${++attachmentKey}`, file, name: file.name, size: file.size, kind: kind?.extension ?? null, status: 'error', progress: 0, id: null, upload: null, files: [], skipped: [], estimatedTokens: 0, retryable: false };
    if (!kind) state.attachments.push({ ...base, error: photo ? 'Фото поки не підтримуються: жодна доступна модель не розпізнає зображення.' : ['doc', 'xls', 'ppt'].includes(extension) ? `Формат .${extension} не підтримується — збережіть як .${extension}x.` : 'Такий формат не підтримується.' });
    else if (!file.size) state.attachments.push({ ...base, error: 'Файл порожній.' });
    else if (file.size > (photo ? MAX_PHOTO_SOURCE_BYTES : kind.maxBytes)) state.attachments.push({ ...base, error: `Завеликий: для ${kind.label} максимум ${formatFileSize(photo ? MAX_PHOTO_SOURCE_BYTES : kind.maxBytes)}.` });
    else { const item = { ...base, status: 'uploading' }; state.attachments.push(item); void uploadAttachment(item); }
  }
  renderComposer();
  renderThread();
}

function removeAttachment(key) {
  const item = state.attachments.find(entry => entry.key === key);
  if (!item) return;
  state.attachments = state.attachments.filter(entry => entry !== item);
  item.xhr?.abort();
  if (item.id) void deps.api.aiDeleteAttachment(item.id).catch(() => {});
  renderComposer();
  $('[data-ai="attach"]')?.focus();
}

/** Hands a short-lived link to Telegram's downloader, or to the browser. */
function startDownload(url, fileName) {
  const absolute = new URL(url, location.origin).href;
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.downloadFile === 'function' && tg.isVersionAtLeast?.('8.0')) {
    // Telegram shows its own download dialog and saves the file on the phone.
    tg.downloadFile({ url: absolute, file_name: fileName });
  } else {
    const anchor = Object.assign(document.createElement('a'), { href: absolute, download: fileName, rel: 'noopener' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
}

async function withBusyButton(button, readyLabel, work) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const label = button.querySelector('span');
  const original = label?.textContent ?? '';
  try {
    await work();
    if (label) label.textContent = readyLabel;
    deps.haptic?.('success');
  } catch (error) {
    state.error = { message: error.message || 'Не вдалося підготувати файл. Спробуйте ще раз.' };
    renderThread();
  } finally {
    setTimeout(() => {
      if (!button.isConnected) return;
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (label) label.textContent = original;
    }, 1500);
  }
}

function downloadArchive(messageId, button) {
  if (!state.currentId) return;
  void withBusyButton(button, 'Архів готовий', async () => {
    const link = await deps.api.aiArchive(state.currentId, messageId);
    startDownload(link.url, link.fileName);
  });
}

function downloadFile(fileId, button) {
  void withBusyButton(button, 'Завантажується', async () => {
    const link = await deps.api.aiFileLink(fileId);
    startDownload(link.url, link.fileName);
  });
}

function previewProject(fileId, button) {
  void withBusyButton(button, 'Відкрито', async () => {
    const link = await deps.api.aiFileLink(fileId);
    if (!link.previewUrl) throw new Error('Перегляд для цього проєкту недоступний.');
    document.querySelector('.ai-project-dialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.className = 'ai-project-dialog';
    dialog.setAttribute('aria-label', 'Перегляд сайту');
    dialog.innerHTML = `<header><strong>Чернетка сайту</strong><button type="button" class="btn btn--secondary btn--sm" data-project-close>Закрити</button></header><p>Перевірте всі сторінки перед публікацією. Посилання на перегляд діє 10 хвилин.</p><iframe title="Чернетка сайту" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe><footer>${link.publishedUrl ? `<a class="btn btn--secondary btn--sm" href="${escapeText(link.publishedUrl)}" target="_blank" rel="noopener noreferrer">Відкрити опублікований сайт</a><button type="button" class="btn btn--secondary btn--sm" data-project-unpublish>Зняти з публікації</button>` : '<span>Щоб опублікувати, попросіть агента «Опублікуй мій сайт».</span>'}</footer>`;
    dialog.querySelector('iframe').src = link.previewUrl;
    dialog.querySelector('[data-project-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('[data-project-unpublish]')?.addEventListener('click', async event => {
      const control = event.currentTarget;
      await withBusyButton(control, 'Знято з публікації', async () => {
        await deps.api.aiUnpublishProject(fileId);
        dialog.querySelector('footer').textContent = 'Сайт знято з публікації. Чернетку збережено.';
      });
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// ---------------------------------------------------------------------------------------------
// Events

async function copyText(text, button) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    try { document.execCommand('copy'); } catch {}
    area.remove();
  }
  if (!button?.isConnected) return;
  const previous = button.innerHTML;
  button.classList.add('is-done');
  if (button.matches('.ai-code-copy')) button.textContent = 'Скопійовано';
  else button.innerHTML = icons.check;
  setTimeout(() => { if (button.isConnected) { button.classList.remove('is-done'); button.innerHTML = previous; } }, 1500);
  deps.haptic?.('selection');
}

function onClick(event) {
  const codeCopy = event.target.closest('[data-copy-code]');
  if (codeCopy) { copyText(codeCopy.closest('.ai-code')?.querySelector('code')?.textContent ?? '', codeCopy); return; }
  const target = event.target.closest('[data-ai]');
  if (!target || !root.contains(target) || target.disabled) return;
  const action = target.dataset.ai;
  const id = target.dataset.id;
  switch (action) {
    case 'edit-message': {
      if (state.pending || id !== lastUser()?.id) break;
      state.reviseMessageId = id;
      const input = $('#aiInput'); input.value = lastUser().content; input.focus(); renderComposer(); break;
    }
    case 'cancel-edit': state.reviseMessageId = null; $('#aiInput').value = ''; renderComposer(); break;
    case 'regenerate': {
      if (state.pending || !lastUser()) break;
      state.reviseMessageId = lastUser().id;
      const answer = state.messages.at(-1);
      state.agent = answer?.mode === 'agent'; state.skillId = answer?.skill?.id ?? null;
      void send(lastUser().content); break;
    }
    case 'vote-up': case 'vote-down': {
      const message = state.messages.find(item => item.id === id);
      if (!message || state.pending) break;
      const vote = action === 'vote-up' ? 'up' : 'down';
      const value = message.feedback === vote ? null : vote;
      target.disabled = true;
      void deps.api.aiFeedback(state.currentId, id, value).then(() => { message.feedback = value; renderThread(); }).catch(error => { state.error = { message: error.message }; renderThread(); }); break;
    }
    case 'back': deps.onBack(); break;
    case 'chats': state.drawer = !state.drawer; state.sheet = false; state.renaming = null; state.confirmDelete = null; renderLayers(); if (state.drawer) { void refreshList(); $('#aiDrawer button')?.focus(); } break;
    case 'new': newChat(); break;
    case 'model': if (models().length > 1 && !state.pending) { state.sheet = 'model'; state.drawer = false; renderLayers(); $('#aiSheetList button')?.focus(); } break;
    case 'skills': if (!state.pending) { state.sheet = 'skill'; state.drawer = false; renderLayers(); $('#aiSheetList button')?.focus(); } break;
    case 'pick-model': state.modelId = id; state.modelPicked = true; state.sheet = false; renderAll(); $('#aiInput')?.focus(); break;
    case 'pick-skill': state.skillId = id || null; state.sheet = false; renderAll(); $('#aiInput')?.focus(); break;
    case 'agent':
      state.agent = !agentOn();
      writeLocal(AGENT_KEY, state.agent ? '1' : null);
      deps.haptic?.('selection');
      renderAll();
      break;
    case 'close-layer': closeLayers(); break;
    case 'open': state.drawer = false; renderLayers(); if (id !== state.currentId || state.messagesFor !== id) void openConversation(id); break;
    case 'rename': state.renaming = id; state.confirmDelete = null; renderDrawerList(); break;
    case 'rename-cancel': state.renaming = null; renderDrawerList(); break;
    case 'delete': state.confirmDelete = id; state.renaming = null; renderDrawerList(); $('[data-ai="delete-cancel"]')?.focus(); break;
    case 'delete-cancel': state.confirmDelete = null; renderDrawerList(); break;
    case 'delete-confirm': void removeConversation(id, target); break;
    case 'copy': {
      const message = state.messages.find(item => item.id === id);
      if (message) void copyText(message.content, target);
      break;
    }
    case 'suggest': void send(target.dataset.text); break;
    case 'attach': $('#aiFile')?.click(); break;
    case 'attachment-remove': removeAttachment(target.dataset.key); break;
    case 'attachment-retry': {
      const item = state.attachments.find(entry => entry.key === target.dataset.key);
      if (item?.file) void uploadAttachment(item);
      break;
    }
    case 'zip': downloadArchive(id, target); break;
    case 'file': downloadFile(id, target); break;
    case 'project-preview': previewProject(id, target); break;
    case 'approve': void answerConfirmation(true, target); break;
    case 'decline': void answerConfirmation(false, target); break;
    case 'retry': { const text = state.error?.retryText; state.error = null; if (text) void send(text); break; }
    case 'reload': void load(); break;
    case 'to-bottom': { const thread = $('#aiThread'); state.stick = true; thread?.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' }); updateToBottom(); break; }
  }
}

async function removeConversation(id, button) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await deps.api.aiDelete(id);
    state.conversations = state.conversations.filter(item => item.id !== id);
    state.confirmDelete = null;
    if (state.currentId === id) { setCurrent(null); state.messages = []; state.messagesFor = null; }
    writeStorage(`${DRAFT_KEY}:${id}`, null);
    renderAll();
    deps.haptic?.('success');
  } catch (error) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    const box = button.closest('.ai-chat-item');
    if (box && !box.querySelector('.ai-inline-error')) box.insertAdjacentHTML('beforeend', `<p class="ai-inline-error" role="alert">${escapeText(error.message || 'Не вдалося видалити чат')}</p>`);
  }
}

async function onSubmit(event) {
  const renameForm = event.target.closest('[data-ai-rename]');
  if (renameForm) {
    event.preventDefault();
    const id = renameForm.dataset.aiRename;
    const input = renameForm.querySelector('input');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const save = renameForm.querySelector('[type="submit"]');
    save.disabled = true; save.setAttribute('aria-busy', 'true');
    try {
      const updated = await deps.api.aiRename(id, title);
      state.conversations = state.conversations.map(item => item.id === id ? { ...item, title: updated.title } : item);
      state.renaming = null;
      renderDrawerList();
    } catch (error) {
      save.disabled = false; save.removeAttribute('aria-busy');
      if (!renameForm.querySelector('.ai-inline-error')) renameForm.insertAdjacentHTML('beforeend', `<p class="ai-inline-error" role="alert">${escapeText(error.message || 'Не вдалося перейменувати')}</p>`);
    }
    return;
  }
  if (event.target.id !== 'aiComposer') return;
  event.preventDefault();
  if (state.pending) { void stopPending(); return; }
  void send($('#aiInput')?.value);
}

function onInput(event) {
  if (event.target.id !== 'aiInput') return;
  writeStorage(`${DRAFT_KEY}:${state.currentId ?? 'new'}`, event.target.value);
  renderComposer();
}

function onKeydown(event) {
  if (event.key === 'Escape' && (state.drawer || state.sheet)) { closeLayers(); return; }
  if (event.target.id !== 'aiInput' || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  // Phones keep Enter for new lines; send with the button. Keyboards with a mouse send on Enter.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    event.preventDefault();
    if (!state.pending) void send(event.target.value);
  }
}

function onScroll(event) {
  if (event.target.id !== 'aiThread') return;
  const thread = event.target;
  state.stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  updateToBottom();
}

function closeLayers() {
  const wasOpen = state.drawer || state.sheet;
  const opener = state.drawer ? $('[data-ai="chats"]') : state.sheet === 'skill' ? $('[data-ai="skills"]') : $('[data-ai="model"]');
  state.drawer = false; state.sheet = false; state.renaming = null; state.confirmDelete = null;
  renderLayers();
  if (wasOpen) opener?.focus();
  return wasOpen;
}

/** Telegram's back button: closes an open layer first. */
export function aiHandleBack() {
  const preview = document.querySelector('.ai-project-dialog');
  if (preview) { preview.close(); return true; }
  if (!root?.isConnected) return false;
  return closeLayers();
}

/** Opens one chat, e.g. from the «Відкрити чат» button of a Telegram notice. */
export function aiSelectConversation(id) {
  if (state.pending) return;
  setCurrent(id);
  state.messagesFor = null;
  state.error = null;
}

// The keyboard shrinks the visible area on phones; the chat follows it so the composer stays visible.
function syncViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--ai-vh', `${Math.round(height)}px`);
  document.documentElement.style.setProperty('--ai-top', `${Math.round(viewport?.offsetTop ?? 0)}px`);
  const thread = $('#aiThread');
  if (thread && state.stick) thread.scrollTop = thread.scrollHeight;
}
window.visualViewport?.addEventListener('resize', () => { if (root?.isConnected) syncViewport(); });
window.visualViewport?.addEventListener('scroll', () => { if (root?.isConnected) syncViewport(); });

/**
 * The app goes to the background (another app, a locked phone, Telegram minimised): stop watching,
 * so the server knows nobody is looking and can send the «ready» notice. The answer goes on.
 * Back in front: catch up from the server's copy.
 */
function onAway() {
  appHidden = true;
  const pending = state.pending;
  if (pending?.viewing === 'stream' && pending.jobId) {
    pending.viewing = null;
    pending.controller?.abort();
    pending.controller = null;
  }
}
function onBack() {
  appHidden = false;
  if (!root?.isConnected || !state.loaded) return;
  const pending = state.pending;
  if (pending && pending.jobId && !pending.finished && pending.viewing !== 'stream') detach(pending);
  else if (!pending) {
    void refreshMe();
    void refreshList();
    // An answer that finished while the app was away: show it.
    if (state.currentId) void openConversation(state.currentId, { silent: true }).then(renderAll);
  }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onAway(); else onBack(); });
try {
  window.Telegram?.WebApp?.onEvent?.('deactivated', onAway);
  window.Telegram?.WebApp?.onEvent?.('activated', onBack);
} catch {}

export function mountAiScreen(element, dependencies) {
  root = element;
  deps = dependencies;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('change', event => {
    if (event.target.id !== 'aiFile') return;
    attachFiles(event.target.files);
    event.target.value = '';
  });
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('scroll', onScroll, true);
  const file = $('#aiFile');
  if (file) file.accept = pickerAccept();
  syncViewport();
  const input = $('#aiInput');
  if (input) input.value = readStorage(`${DRAFT_KEY}:${state.currentId ?? 'new'}`) ?? '';
  renderAll();
  // A job left running when the screen was closed: follow it again.
  if (state.pending && !state.pending.finished && state.pending.viewing !== 'stream') detach(state.pending);
  if (state.loaded) void load({ quiet: true });
  else void load();
}
