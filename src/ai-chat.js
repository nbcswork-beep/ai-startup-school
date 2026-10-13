// Student OS · ШІ-асистент. A chat screen over the server's AI proxy: several chats, model choice,
// streamed answers, stop, copy, rename and delete. The balance shown here always comes from the
// server; the client never computes or sends token counts.
import { escapeText, renderMarkdown } from './ai-markdown.js';

const CURRENT_KEY = 'aiss:ai:current';
const DRAFT_KEY = 'aiss:ai:draft';
const numberFormat = new Intl.NumberFormat('uk-UA');

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
  pending: null,
  error: null,
  drawer: false,
  sheet: false,
  renaming: null,
  confirmDelete: null,
  stick: true
};

let root = null;
let deps = null;
let frame = 0;

function readStorage(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function writeStorage(key, value) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch {} }

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
  spark: icon('<path d="M12 2.7 14.1 8l5.2 2.1-5.2 2.1L12 17.5l-2.1-5.3-5.2-2.1L9.9 8z"/>')
};

const SUGGESTIONS = [
  ['Поясни простіше', 'Поясни простими словами, що таке MVP і навіщо він стартапу.'],
  ['Перевір ідею', 'Допоможи перевірити мою ідею: які питання поставити першим користувачам?'],
  ['Допоможи з кодом', 'Поясни, як працює цикл for у JavaScript, на короткому прикладі.'],
  ['Склади план', 'Склади план роботи над шкільним проєктом на тиждень.']
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
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(date);
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return 'Вчора';
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' }).format(date);
}

function currentConversation() {
  return state.conversations.find(item => item.id === state.currentId) ?? null;
}

function models() { return state.me?.models ?? []; }

function selectedModel() {
  return models().find(model => model.id === state.modelId) ?? models().find(model => model.id === state.me?.defaultModelId) ?? models()[0] ?? null;
}

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

function messageMarkup(message, { streaming = false } = {}) {
  if (message.role === 'user') {
    return `<article class="ai-msg ai-msg--user" data-message="${escapeText(message.id ?? '')}">
      <div class="ai-bubble">${escapeText(message.content).replace(/\n/g, '<br>')}</div>
      <div class="ai-msg-actions"><button type="button" class="ai-icon-action" data-ai="copy" data-id="${escapeText(message.id ?? '')}" aria-label="Копіювати повідомлення">${icons.copy}</button></div>
    </article>`;
  }
  const usage = message.usage;
  const meta = [
    message.modelLabel ? escapeText(message.modelLabel) : '',
    usage ? `${usage.approximate ? '≈ ' : ''}${formatTokens(usage.total)}` : '',
    message.status === 'stopped' ? 'зупинено' : message.status === 'interrupted' ? 'відповідь перервалася' : ''
  ].filter(Boolean).join(' · ');
  return `<article class="ai-msg ai-msg--assistant${streaming ? ' is-streaming' : ''}" data-message="${escapeText(message.id ?? 'pending')}">
    <span class="ai-avatar" aria-hidden="true">${icons.spark}</span>
    <div class="ai-answer">
      <div class="ai-md">${message.content ? renderMarkdown(message.content, { streaming }) : '<span class="ai-typing" aria-label="ШІ пише відповідь"><i></i><i></i><i></i></span>'}</div>
      ${streaming ? '' : `<div class="ai-msg-actions"><button type="button" class="ai-icon-action" data-ai="copy" data-id="${escapeText(message.id ?? '')}" aria-label="Копіювати відповідь">${icons.copy}</button>${meta ? `<span class="ai-meta"${usage?.approximate ? ' title="Провайдер не повідомив точну кількість — показано оцінку"' : ''}>${meta}</span>` : ''}</div>`}
    </div>
  </article>`;
}

function emptyMarkup() {
  const block = blocker();
  return `<div class="ai-empty">
    <span class="ai-empty-mark" aria-hidden="true">${icons.spark}</span>
    <h2>Чим допомогти?</h2>
    <p>Питайте про урок, ідею проєкту чи код. Асистент пояснює й підказує, а рішення лишається за вами.</p>
    <div class="ai-suggestions">${SUGGESTIONS.map(([label, text]) => `<button type="button" class="ai-suggestion" data-ai="suggest" data-text="${escapeText(text)}" ${block ? 'disabled' : ''}>${escapeText(label)}</button>`).join('')}</div>
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
  const pending = state.pending && (state.pending.conversationId === (state.currentId ?? 'new') || state.pending.conversationId === state.currentId) ? state.pending : null;
  const items = state.messages.map(message => messageMarkup(message));
  if (pending) {
    items.push(messageMarkup({ ...pending.user, id: 'pending-user' }));
    items.push(messageMarkup({ role: 'assistant', id: 'pending', content: pending.text, modelLabel: pending.modelLabel }, { streaming: true }));
  }
  if (state.error) {
    items.push(`<div class="ai-error" role="alert"><strong>${escapeText(state.error.message)}</strong>${state.error.retryText ? '<button type="button" class="btn btn--secondary btn--sm" data-ai="retry">Спробувати ще раз</button>' : ''}</div>`);
  }
  thread.innerHTML = items.length ? items.join('') : emptyMarkup();
  thread.setAttribute('aria-busy', pending ? 'true' : 'false');
  if (state.stick) thread.scrollTop = thread.scrollHeight;
  updateToBottom();
}

/** During streaming only the growing answer is redrawn, at most once per frame. */
function schedulePendingRender() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const node = root?.querySelector('[data-message="pending"] .ai-md');
    if (!node || !state.pending) return;
    node.innerHTML = state.pending.text ? renderMarkdown(state.pending.text, { streaming: true }) : '<span class="ai-typing" aria-label="ШІ пише відповідь"><i></i><i></i><i></i></span>';
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
  input.placeholder = block ? 'Надсилання зараз недоступне' : 'Напишіть питання…';
  input.maxLength = limit;
  if (state.pending) {
    send.innerHTML = icons.stop;
    send.className = 'btn btn--icon btn--danger ai-send';
    send.setAttribute('aria-label', 'Зупинити генерацію');
    send.dataset.mode = 'stop';
    send.disabled = false;
  } else {
    send.innerHTML = icons.send;
    send.className = 'btn btn--icon btn--primary ai-send';
    send.setAttribute('aria-label', 'Надіслати');
    send.dataset.mode = 'send';
    send.disabled = Boolean(block) || !state.me || !input.value.trim();
  }
  const length = input.value.length;
  if (hint) {
    hint.textContent = length > limit * 0.8 ? `${numberFormat.format(length)} / ${numberFormat.format(limit)}` : '';
    hint.dataset.tone = length >= limit ? 'danger' : '';
  }
  autosize(input);
}

function renderLayers() {
  const drawer = $('#aiDrawer'), sheet = $('#aiSheet'), scrim = $('.ai-scrim');
  if (!drawer || !sheet || !scrim) return;
  drawer.hidden = !state.drawer;
  sheet.hidden = !state.sheet;
  scrim.hidden = !state.drawer && !state.sheet;
  $('[data-ai="chats"]')?.setAttribute('aria-expanded', String(state.drawer));
  $('[data-ai="model"]')?.setAttribute('aria-expanded', String(state.sheet));
  if (state.drawer) renderDrawerList();
  if (state.sheet) renderSheetList();
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
        <p id="aiDeleteText">Видалити чат «${escapeText(item.title)}»? Повідомлення зникнуть назавжди.</p>
        <div class="ai-chat-item-actions"><button type="button" class="btn btn--ghost btn--sm" data-ai="delete-cancel">Скасувати</button><button type="button" class="btn btn--danger btn--sm" data-ai="delete-confirm" data-id="${escapeText(item.id)}">Видалити</button></div>
      </div>`;
    }
    return `<div class="ai-chat-item${current ? ' is-current' : ''}">
      <button type="button" class="ai-chat-open" data-ai="open" data-id="${escapeText(item.id)}" ${current ? 'aria-current="true"' : ''}>
        <strong>${escapeText(item.title)}</strong>
        <small>${escapeText(shortTime(item.updatedAt))}${item.preview ? ` · ${escapeText(item.preview)}` : ''}</small>
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
  if (!list) return;
  const selected = selectedModel();
  list.innerHTML = models().map(model => `<button type="button" class="ai-model-option${model.id === selected?.id ? ' is-selected' : ''}" data-ai="pick-model" data-id="${escapeText(model.id)}" role="menuitemradio" aria-checked="${model.id === selected?.id}">
    <span><strong>${escapeText(model.label)}</strong><small>${escapeText(familyLabel(model.family))}</small></span>${model.id === selected?.id ? icons.check : ''}
  </button>`).join('');
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
    if (!models().some(model => model.id === state.modelId)) state.modelId = currentConversation()?.modelId && models().some(model => model.id === currentConversation().modelId) ? currentConversation().modelId : me.defaultModelId;
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
    state.messagesFor = id;
    const modelId = result.conversation.modelId;
    if (modelId && models().some(model => model.id === modelId)) state.modelId = modelId;
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

function newChat() {
  if (state.pending) return;
  setCurrent(null);
  state.messages = [];
  state.messagesFor = null;
  state.error = null;
  state.modelId = state.me?.defaultModelId ?? state.modelId;
  state.drawer = false;
  const input = $('#aiInput');
  if (input) input.value = readStorage(`${DRAFT_KEY}:new`) ?? '';
  renderAll();
  input?.focus();
}

// ---------------------------------------------------------------------------------------------
// Sending and streaming

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

async function send(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text || state.pending || blocker() || !state.me) return;
  const limit = state.me.limits?.maxMessageChars ?? 8000;
  if (text.length > limit) { state.error = { message: `Повідомлення задовге: максимум ${numberFormat.format(limit)} символів` }; renderThread(); return; }
  const conversationId = state.currentId ?? 'new';
  const model = selectedModel();
  const controller = new AbortController();
  const pending = {
    user: { role: 'user', content: text, createdAt: new Date().toISOString() },
    text: '', modelLabel: model?.label ?? '', conversationId, controller, finished: false
  };
  state.pending = pending;
  state.error = null;
  state.stick = true;
  const input = $('#aiInput');
  if (input) { input.value = ''; writeStorage(`${DRAFT_KEY}:${conversationId}`, null); }
  renderAll();
  deps.haptic?.('selection');

  const finish = () => { pending.finished = true; if (state.pending === pending) state.pending = null; };
  try {
    const response = await deps.api.aiStream(conversationId, { content: text, clientRequestId: crypto.randomUUID(), ...(model ? { modelId: model.id } : {}) }, controller.signal);
    await readEvents(response.body, (event, data) => {
      if (state.pending !== pending) return;
      if (event === 'start') {
        pending.conversationId = data.conversationId;
        pending.modelLabel = data.model?.label ?? pending.modelLabel;
        if (conversationId === 'new' && (state.currentId === null)) { setCurrent(data.conversationId); state.messagesFor = data.conversationId; }
      } else if (event === 'delta') {
        pending.text += data.text;
        schedulePendingRender();
      } else if (event === 'model') {
        pending.modelLabel = data.label;
      } else if (event === 'done') {
        finish();
        if (data.message && state.currentId === data.conversationId) state.messages.push(data.userMessage, data.message);
        if (data.error) state.error = { message: data.error.message };
        const field = $('#aiInput');
        if (!data.message && field && !field.value) field.value = text;
        applyBalance(data.balance);
        void refreshList();
        deps.haptic?.(data.message ? 'success' : 'selection');
      } else if (event === 'error') {
        finish();
        state.error = { message: data.message, retryText: text };
        applyBalance(data.balance);
        deps.haptic?.('error');
      }
      renderAll();
    });
    if (!pending.finished) {
      finish();
      state.error = { message: 'Зʼєднання перервалося. Перевіряємо, що збереглося…' };
      renderAll();
      setTimeout(syncAfterInterruption, 1200);
    }
  } catch (error) {
    const stopped = controller.signal.aborted;
    finish();
    if (stopped) {
      // The server saves what was written and charges it; show it now, then sync the real record.
      const field = $('#aiInput');
      if (pending.text) state.messages.push({ ...pending.user, id: `local-${Date.now()}` }, { role: 'assistant', id: `local-a-${Date.now()}`, content: pending.text, modelLabel: pending.modelLabel, status: 'stopped' });
      else if (field && !field.value) field.value = text;
      setTimeout(syncAfterInterruption, 1500);
    } else if (error.status) {
      handleRefusal(error, text);
    } else {
      state.error = { message: 'Зʼєднання перервалося. Перевіряємо, що збереглося…' };
      setTimeout(syncAfterInterruption, 1200);
    }
    renderAll();
  }
}

function handleRefusal(error, text) {
  const input = $('#aiInput');
  if (input && !input.value) input.value = text;
  if (error.code === 'AI_LIMIT_EXHAUSTED' && state.me) { state.me.balance = { ...state.me.balance, available: 0, exhausted: true }; return; }
  if (error.code === 'AI_ACCESS_BLOCKED' && state.me) { state.me.balance = { ...state.me.balance, blocked: true }; return; }
  if (error.code === 'AI_NOT_CONFIGURED' && state.me) { state.me.configured = false; return; }
  if (error.code === 'AI_MODEL_FORBIDDEN' || error.code === 'AI_CONVERSATION_NOT_FOUND') { void load({ quiet: true }); }
  state.error = { message: error.message, ...(error.status >= 500 || error.status === 429 ? { retryText: text } : {}) };
  deps.haptic?.('error');
}

function applyBalance(balance) {
  if (!balance || !state.me) return;
  state.me.balance = { ...state.me.balance, available: balance.available, exhausted: balance.exhausted };
  void refreshMe();
}

async function syncAfterInterruption() {
  await Promise.all([refreshMe(), refreshList()]);
  if (state.currentId) {
    try {
      const result = await deps.api.aiConversation(state.currentId);
      if (!state.pending) { state.messages = result.messages; state.messagesFor = state.currentId; }
    } catch {}
  }
  if (state.error?.message?.startsWith('Зʼєднання перервалося')) state.error = { message: 'Зʼєднання перервалося. Збережене показано вище.' };
  renderAll();
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
    case 'back': deps.onBack(); break;
    case 'chats': state.drawer = !state.drawer; state.sheet = false; state.renaming = null; state.confirmDelete = null; renderLayers(); if (state.drawer) { void refreshList(); $('#aiDrawer button')?.focus(); } break;
    case 'new': newChat(); break;
    case 'model': if (models().length > 1 && !state.pending) { state.sheet = true; state.drawer = false; renderLayers(); $('#aiSheetList button')?.focus(); } break;
    case 'pick-model': state.modelId = id; state.sheet = false; renderAll(); $('#aiInput')?.focus(); break;
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
  if (state.pending) { state.pending.controller.abort(); return; }
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
  const opener = state.drawer ? $('[data-ai="chats"]') : $('[data-ai="model"]');
  state.drawer = false; state.sheet = false; state.renaming = null; state.confirmDelete = null;
  renderLayers();
  if (wasOpen) opener?.focus();
  return wasOpen;
}

/** Telegram's back button: closes an open layer first. */
export function aiHandleBack() {
  if (!root?.isConnected) return false;
  return closeLayers();
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
// A teacher may change the allowance while the app is in the background.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && root?.isConnected && state.loaded && !state.pending) void refreshMe(); });
window.visualViewport?.addEventListener('scroll', () => { if (root?.isConnected) syncViewport(); });

export function mountAiScreen(element, dependencies) {
  root = element;
  deps = dependencies;
  root.addEventListener('click', onClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('scroll', onScroll, true);
  syncViewport();
  const input = $('#aiInput');
  if (input) input.value = readStorage(`${DRAFT_KEY}:${state.currentId ?? 'new'}`) ?? '';
  renderAll();
  if (state.loaded) void load({ quiet: true });
  else void load();
}
