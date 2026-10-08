import {startAcademicSync} from './academic-sync.js';
import { api } from './api.js';
import './student-workspace.css';
import { homeView, learningView, projectView, portfolioView, profileView, homeworkView, lessonView, escapeHtml } from './student-views.js';
import { currentProject, safeHttpsUrl } from './student-model.js';

const tg = window.Telegram?.WebApp;

function updateViewportLayout() {
  const width = window.innerWidth;
  document.documentElement.dataset.viewportLayout = width < 700 ? 'mobile' : width < 1100 ? 'tablet' : 'desktop';
}

let viewportFrame;
function scheduleViewportLayout() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    updateViewportLayout();
    // Telegram may apply the new WebView dimensions after dispatching its event.
    requestAnimationFrame(updateViewportLayout);
  });
}

updateViewportLayout();
window.addEventListener('resize', scheduleViewportLayout);

// Telegram draws its own controls ("Закрити", "⋯") over the WebView in fullscreen mode.
// safeAreaInset is the device inset, contentSafeAreaInset is Telegram's chrome inside it;
// the CSS combines them with env(safe-area-inset-*) so nothing depends on a device model.
function applyTelegramViewport() {
  const root = document.documentElement.style;
  const safe = tg.safeAreaInset ?? {};
  const content = tg.contentSafeAreaInset ?? {};
  const inset = side => `${Math.max(0, (Number(safe[side]) || 0) + (Number(content[side]) || 0))}px`;
  root.setProperty('--tg-app-safe-top', inset('top'));
  root.setProperty('--tg-app-safe-bottom', inset('bottom'));
  root.setProperty('--tg-app-safe-left', inset('left'));
  root.setProperty('--tg-app-safe-right', inset('right'));
  scheduleViewportLayout();
}

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor('#070a2b');
    tg.setBackgroundColor('#070a2b');
  } catch {}
  applyTelegramViewport();
  for (const event of ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged', 'fullscreenChanged', 'fullscreenFailed']) {
    try { tg.onEvent(event, applyTelegramViewport); } catch {}
  }
  if (typeof tg.requestFullscreen === 'function') {
    try { Promise.resolve(tg.requestFullscreen()).catch(() => {}).finally(scheduleViewportLayout); }
    catch { scheduleViewportLayout(); }
  }
}

let firstName = 'У';
let data = null;
let currentLesson = null;
let currentHomework = null;
let authError = '';
let notificationPanelOpen = false;
let notificationReturnFocus = null;
// Items that were unread when the panel opened stay highlighted until it closes,
// even though they are persisted as read right away.
let notificationFreshIds = new Set();

const icons = {
  home: '<path d="m3.5 10.8 8.5-7.3 8.5 7.3"/><path d="M5.5 9.5v10.8h13V9.5M9.4 20.3v-6.1h5.2v6.1"/>',
  learn: '<path d="M3.5 5.2A2.2 2.2 0 0 1 5.7 3h4.1a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H5.7a2.2 2.2 0 0 0-2.2 2.2z"/><path d="M20.5 5.2A2.2 2.2 0 0 0 18.3 3h-4.1a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h4.1a2.2 2.2 0 0 1 2.2 2.2z"/>',
  project: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M8.5 9V4M8.5 14h3.2M8.5 17h6.7"/>',
  portfolio: '<rect x="3.5" y="6.5" width="17" height="13" rx="2.5"/><path d="M8.5 6.5V4h7v2.5M3.5 12h17M9.5 12v2h5v-2"/>',
  profile: '<circle cx="12" cy="8" r="4.2"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'
};

const nav = [
  ['home', 'Головна'],
  ['learn', 'Навчання'],
  ['project', 'Проєкт'],
  ['portfolio', 'Портфоліо'],
  ['profile', 'Профіль']
];

const svgIcon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;


function formatClassTime(value, timezone = 'Europe/Kyiv') {
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(value));
}

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="app-shell">
    <div class="world-grid" aria-hidden="true"></div>
    <div class="world-signal signal-a" aria-hidden="true"></div>
    <div class="world-signal signal-b" aria-hidden="true"></div>
    <header class="topbar">
      <button class="brand" data-tab="home" aria-label="AI Startup School — головна">
        <span class="brand-symbol">AI</span>
        <span class="brand-name">STARTUP <b>SCHOOL</b></span>
      </button>
      <div class="top-actions">
        <button class="icon-btn notification" id="notificationBell" type="button" aria-label="Сповіщення" aria-controls="studentNotifications" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><i class="notification-dot" hidden></i>
        </button>
        <button class="avatar" data-tab="profile" aria-label="Відкрити профіль">${firstName[0]?.toUpperCase() || 'M'}</button>
      </div>
    </header>
    <div id="syncStatus" class="work-sync-status" role="status" hidden><span></span><button class="text-link" id="retrySync">Оновити дані</button></div>
    <main id="view" class="view"></main>
    <nav class="bottom-nav" aria-label="Головна навігація">
      ${nav.map(([id, label]) => `<button class="nav-item" data-tab="${id}" aria-label="${label}"><span class="nav-icon">${svgIcon(id)}</span><span class="nav-label">${label}</span></button>`).join('')}
    </nav>
    <button class="notification-backdrop" id="notificationBackdrop" type="button" aria-label="Закрити сповіщення" hidden></button>
    <section class="notification-panel" id="studentNotifications" role="dialog" aria-modal="true" aria-labelledby="notificationPanelTitle" hidden>
      <header class="notification-panel-head">
        <div><span>STUDENT APP</span><h2 id="notificationPanelTitle">Сповіщення</h2></div>
        <button class="notification-close" id="closeNotifications" type="button" aria-label="Закрити сповіщення">×</button>
      </header>
      <div class="notification-panel-tools"><span id="notificationCount">0 непрочитаних</span><button id="markAllNotifications" type="button">Позначити всі прочитаними</button></div>
      <div class="notification-list" id="notificationList" aria-live="polite"></div>
    </section>
  </div>`;

const view = document.querySelector('#view');
const notificationBell = document.querySelector('#notificationBell');
notificationBell.disabled = true;
const notificationDot = notificationBell.querySelector('.notification-dot');
const notificationBackdrop = document.querySelector('#notificationBackdrop');
const notificationPanel = document.querySelector('#studentNotifications');
const notificationList = document.querySelector('#notificationList');
const notificationCount = document.querySelector('#notificationCount');
const markAllNotifications = document.querySelector('#markAllNotifications');
let active = 'home';
let renderTimer;
let pendingMutation = 0;

async function mutateAndRefresh(action) {
  pendingMutation++;
  try {
    await action();
    await refreshData();
  } finally {
    pendingMutation--;
  }
}

function notificationTypeIcon(type) {
  if (type.includes('homework_reviewed')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 12 4 4 8-9"/><circle cx="12" cy="12" r="9"/></svg>';
  if (type.includes('homework')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h9l3 3V21H6zM9 11h6M9 15h6M15 3.5V7h3"/></svg>';
  if (type.includes('class')) return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="15" rx="2"/><path d="M7 3v5M17 3v5M3.5 10h17"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4"/></svg>';
}

function formatNotificationTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const minutes = Math.round((timestamp - Date.now()) / 60_000);
  const relative = new Intl.RelativeTimeFormat('uk-UA', { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) <= 7) return relative.format(days, 'day');
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

function updateNotificationBell() {
  const unread = data?.notifications?.unreadCount ?? 0;
  notificationDot.hidden = unread < 1;
  notificationBell.setAttribute('aria-label', unread ? `Сповіщення, непрочитаних: ${unread}` : 'Сповіщення');
}

function renderNotificationPanel() {
  const notifications = data?.notifications ?? { items: [], unreadCount: 0 };
  notificationCount.textContent = notificationFreshIds.size ? `${notificationFreshIds.size} нових` : `${notifications.unreadCount} непрочитаних`;
  markAllNotifications.disabled = notifications.unreadCount < 1;
  notificationList.innerHTML = notifications.items.length ? notifications.items.map(item => {
    const isNew = !item.readAt || notificationFreshIds.has(item.id);
    const destination = item.destination?.homeworkId ? ` data-homework="${escapeHtml(item.destination.homeworkId)}"` : item.destination?.tab ? ` data-notification-tab="${escapeHtml(item.destination.tab)}"` : '';
    return `<button class="notification-item${isNew ? ' unread' : ''}" type="button" data-notification-id="${escapeHtml(item.id)}"${destination}${item.destination ? '' : ' disabled'}>
      <span class="notification-type">${notificationTypeIcon(item.type)}</span>
      <span class="notification-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small><time datetime="${escapeHtml(item.occurredAt)}">${escapeHtml(formatNotificationTime(item.occurredAt))}</time></span>
      ${isNew ? '<i class="notification-unread" aria-label="Нове"></i>' : ''}
    </button>`;
  }).join('') : '<div class="notification-empty"><span aria-hidden="true">✓</span><strong>Нових сповіщень немає</strong></div>';

  notificationList.querySelectorAll('[data-notification-id]').forEach(item => item.addEventListener('click', async () => {
    const id = item.dataset.notificationId;
    if (data.notifications?.items.find(entry => entry.id === id)?.readAt) return navigateFromNotification(item);
    try { data.notifications = await api.markNotificationsRead([id]); updateNotificationBell(); }
    catch {}
    navigateFromNotification(item);
  }));
}

function navigateFromNotification(item) {
  closeNotifications();
  if (item.dataset.homework && data.homework?.some(homework => homework.id === item.dataset.homework)) openHomework(item.dataset.homework);
  else if (item.dataset.notificationTab) render(item.dataset.notificationTab);
}

async function openNotifications() {
  if (notificationPanelOpen) return;
  notificationPanelOpen = true;
  notificationReturnFocus = document.activeElement;
  notificationBell.setAttribute('aria-expanded', 'true');
  notificationBackdrop.hidden = false;
  notificationPanel.hidden = false;
  document.body.classList.add('notifications-open');
  notificationList.innerHTML = '<div class="notification-loading">Завантажуємо сповіщення…</div>';
  document.querySelector('#closeNotifications').focus();
  try {
    data.notifications = await api.notifications();
    notificationFreshIds = new Set(data.notifications.items.filter(item => !item.readAt).map(item => item.id));
    renderNotificationPanel();
    const unreadIds = data.notifications.items.filter(item => !item.readAt).map(item => item.id);
    if (unreadIds.length) {
      data.notifications = await api.markNotificationsRead(unreadIds);
      renderNotificationPanel();
      updateNotificationBell();
    }
  } catch (error) {
    notificationList.innerHTML = `<div class="notification-empty error"><strong>Не вдалося завантажити сповіщення</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function closeNotifications() {
  if (!notificationPanelOpen) return;
  notificationPanelOpen = false;
  notificationFreshIds = new Set();
  notificationBell.setAttribute('aria-expanded', 'false');
  notificationBackdrop.hidden = true;
  notificationPanel.hidden = true;
  document.body.classList.remove('notifications-open');
  notificationReturnFocus?.focus?.();
}

notificationBell.addEventListener('click', openNotifications);
notificationBackdrop.addEventListener('click', closeNotifications);
document.querySelector('#closeNotifications').addEventListener('click', closeNotifications);
markAllNotifications.addEventListener('click', async () => {
  markAllNotifications.disabled = true;
  try { data.notifications = await api.markNotificationsRead(); renderNotificationPanel(); updateNotificationBell(); }
  catch { markAllNotifications.disabled = false; }
});

document.addEventListener('keydown', event => {
  if (!notificationPanelOpen) return;
  if (event.key === 'Escape') { event.preventDefault(); closeNotifications(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...notificationPanel.querySelectorAll('button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function home() { return homeView(data); }
function learn() { return learningView(data); }
function project() { return projectView(data); }
function portfolio() { return portfolioView(data); }
function profile() { return profileView(data); }
function homeworkPage() { return homeworkView(data, currentHomework); }
function lessonPage() { return lessonView(data, currentLesson); }



const templates = { home, learn, project, portfolio, profile, lesson: lessonPage, homework: homeworkPage };
let navigationRequest = 0;

function loadingView(label = 'Завантажуємо твою роботу') {
  view.setAttribute('aria-busy', 'true');
  view.innerHTML = `<section class="system-state" role="status"><div class="state-signal" aria-hidden="true"></div><h1>${escapeHtml(label)}</h1><p>Завантажуємо проєкт, заняття та завдання.</p></section>`;
}

function errorView(message, title = 'Не вдалося завантажити дані', retry = initialize) {
  view.removeAttribute('aria-busy');
  view.innerHTML = `<section class="system-state error-state"><div class="state-signal"></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><button class="primary-btn" id="retryBoot">Спробувати ще раз</button></section>`;
  document.querySelector('#retryBoot')?.addEventListener('click', retry);
}

async function refreshData(snapshot) {
  data = snapshot ?? await api.bootstrap();
  firstName = data.home.viewer.firstName;
  document.querySelector('#syncStatus').hidden = true;
  document.querySelector('.avatar').textContent = Array.from(firstName)[0] || 'У';
  updateNotificationBell();
  notificationBell.disabled = false;
}

async function openLesson(id, updateHistory = true) {
  const requestId = ++navigationRequest;
  loadingView('Відкриваємо урок');
  try {
    const lesson = await api.lesson(id);
    if (requestId !== navigationRequest) return;
    currentLesson = lesson;
    render('lesson', updateHistory);
  } catch (error) {
    if (requestId === navigationRequest) errorView(error.message, 'Не вдалося відкрити урок', () => openLesson(id, updateHistory));
  }
}

function openHomework(id, updateHistory = true) {
  currentHomework = data.homework?.find(item => item.id === id) ?? null;
  render('homework', updateHistory);
}

function openExternal(url) {
  const safeUrl = safeHttpsUrl(url);
  if (!safeUrl) return;
  if (tg?.openLink) tg.openLink(safeUrl);
  else window.open(safeUrl, '_blank', 'noopener,noreferrer');
}

function haptic(type = 'impact') {
  try {
    if (!tg?.HapticFeedback) return;
    if (type === 'selection') tg.HapticFeedback.selectionChanged();
    else tg.HapticFeedback.impactOccurred('light');
  } catch {}
}

function render(tab, updateHistory = true) {
  if (!data) return;
  navigationRequest++;
  const next = templates[tab] ? tab : 'home';
  clearTimeout(renderTimer);
  view.classList.add('leaving');

  renderTimer = setTimeout(() => {
    const samePage = active === next;
    const scrollPosition = window.scrollY;
    const openDetails = samePage ? [...view.querySelectorAll('details[open]')].map(element => [...view.querySelectorAll('details')].indexOf(element)) : [];
    const drafts=samePage?[...view.querySelectorAll('#homeworkSubmit,#projectStageSubmit,#projectEditor,#createProject,#projectNoteForm')].map(form=>({formId:form.id,key:form.dataset.homeworkId??form.dataset.taskId??form.dataset.projectId??'',version:form.dataset.version??'',requestId:form.dataset.requestId,hidden:form.hidden,fields:[...form.querySelectorAll('input[name],textarea[name]')].map(field=>({name:field.name,value:field.value,focused:document.activeElement===field,start:field.selectionStart,end:field.selectionEnd}))})):[];
    active = next;
    view.innerHTML = templates[active]();
    view.removeAttribute('aria-busy');
    document.querySelectorAll('.nav-item').forEach(item => {
      const isActive = item.dataset.tab === (['lesson', 'homework'].includes(active) ? 'learn' : active);
      item.classList.toggle('active', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    window.scrollTo({ top: samePage ? scrollPosition : 0, behavior: 'auto' });
    if (['lesson', 'homework'].includes(active)) tg?.BackButton?.show?.();
    else tg?.BackButton?.hide?.();
    view.classList.remove('leaving');
    wirePage();
    for(const draft of drafts){const nextForm=view.querySelector('#'+draft.formId);if(!nextForm)continue;const key=nextForm.dataset.homeworkId??nextForm.dataset.taskId??nextForm.dataset.projectId??'';if(key!==draft.key||(['projectStageSubmit','projectNoteForm'].includes(draft.formId)&&nextForm.dataset.version!==draft.version))continue;if(draft.requestId)nextForm.dataset.requestId=draft.requestId;nextForm.hidden=draft.hidden;for(const item of draft.fields){const field=nextForm.elements.namedItem(item.name);if(field){field.value=item.value;if(item.focused&&!field.disabled){field.focus();if(item.start!==null)field.setSelectionRange(item.start,item.end);}}}}

    openDetails.forEach(index => { const detail = view.querySelectorAll('details')[index]; if (detail) detail.open = true; });
    if (view.querySelector('#projectStageSubmit') && !view.querySelector('#projectStageSubmit').hidden) view.querySelector('#continueProject')?.setAttribute('hidden', '');
    if (!samePage) { const heading = view.querySelector('h1'); heading?.setAttribute('tabindex', '-1'); heading?.focus({ preventScroll: true }); }

    const targetHash = active === 'lesson' && currentLesson ? `#lesson=${currentLesson.id}` : active === 'homework' && currentHomework ? `#homework=${currentHomework.id}` : `#${active}`;
    if (updateHistory && location.hash !== targetHash) history.pushState({ tab: active }, '', targetHash);
    haptic('selection');
  }, 70);
}

function wirePage() {
  view.querySelectorAll('[data-tab]').forEach(element => {
    element.onclick = event => {
      event.stopPropagation();
      render(element.dataset.tab);
    };
  });

  view.querySelectorAll('[data-lesson]').forEach(element => {
    if (element.id === 'completeLesson') return;
    element.onclick = event => { event.stopPropagation(); openLesson(element.dataset.lesson); };
  });
  view.querySelectorAll('[data-homework]').forEach(element => {
    element.onclick = async event => {
      event.stopPropagation();
      openHomework(element.dataset.homework);
      if (element.dataset.feedbackRead) {
        try { data.notifications = await api.markNotificationsRead([element.dataset.feedbackRead]); updateNotificationBell(); }
        catch { /* Keep unread state when the server cannot confirm it. */ }
      }
    };
  });
  view.querySelectorAll('[data-external]').forEach(element => {
    element.onclick = event => { event.stopPropagation(); openExternal(element.dataset.external); };
  });
  view.querySelectorAll('[data-recovery-mentor]').forEach(button => {
    button.onclick = async event => {
      event.stopPropagation();
      button.disabled = true; button.textContent = 'Бронюємо…';
      try {
        await api.bookMentor(button.dataset.recoveryMentor);
        button.textContent = 'Зустріч зарезервовано'; button.classList.add('booked');
        tg?.showAlert?.('Зустріч із ментором зарезервовано. Деталі з’являться у профілі.');
      } catch (error) { button.disabled = false; button.textContent = error.message; }
    };
  });

  document.querySelector('#completeLesson')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Зберігаємо…';
    try {
      const lessonId = button.dataset.lesson;
      await mutateAndRefresh(() => api.completeLesson(lessonId, crypto.randomUUID()));
      if (active === 'lesson' && currentLesson?.id === lessonId) {
        currentLesson = await api.lesson(lessonId);
        render('lesson', false);
      }
    }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });

  const createForm = document.querySelector('#createProject');
  createForm?.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(createForm); const button = createForm.querySelector('button'); button.disabled = true;
    try { await mutateAndRefresh(() => api.createProject({ title: values.get('title'), summary: values.get('summary') })); if (active === 'project') render('project', false); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });
  document.querySelector('#editProject')?.addEventListener('click', () => revealForm('projectEditor'));
  document.querySelector('#continueProject')?.addEventListener('click', event => { revealForm('projectStageSubmit'); event.currentTarget.hidden = true; });
  view.querySelectorAll('img').forEach(image => image.addEventListener('error', () => { const note = document.createElement('p'); note.className = 'work-muted'; note.textContent = 'Зображення тимчасово недоступне.'; image.replaceWith(note); }, { once: true }));
  const editor = document.querySelector('#projectEditor');
  editor?.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(editor); const projectData = currentProject(data);
    try { await mutateAndRefresh(() => api.updateProject(projectData.id, { title: values.get('title'), summary: values.get('summary') })); editor.hidden = true; if (active === 'project') render('project', false); }
    catch (error) { editor.querySelector('button').textContent = error.message; }
  });
  const noteForm=view.querySelector('#projectNoteForm');
  noteForm?.addEventListener('submit',async event=>{
    event.preventDefault();const button=noteForm.querySelector('button'),fields=new FormData(noteForm);button.disabled=true;
    const input={contentText:fields.get('contentText'),clientRequestId:noteForm.dataset.requestId??(noteForm.dataset.requestId=crypto.randomUUID())};if(fields.get('contentUrl'))input.contentUrl=fields.get('contentUrl');
    try{await mutateAndRefresh(()=>api.addProjectNote(noteForm.dataset.projectId,input));if(active==='project')render('project',false);}
    catch(error){button.disabled=false;button.textContent=error.message;}
  });
  const stageForm=view.querySelector('#projectStageSubmit');
  stageForm?.addEventListener('submit',async event=>{
    event.preventDefault();const button=stageForm.querySelector('button'),contentText=stageForm.querySelector('textarea').value;button.disabled=true;stageForm.querySelector('textarea').disabled=true;
    try{await mutateAndRefresh(()=>api.submitProjectTask(stageForm.dataset.projectId,stageForm.dataset.taskId,{contentText,expectedVersion:Number(stageForm.dataset.version)}));if(active==='project')render('project',false);}
    catch(error){button.disabled=false;stageForm.querySelector('textarea').disabled=false;button.textContent=error.message;}
  });

  document.querySelector('#openCode')?.addEventListener('click', () => {
    const url = currentProject(data)?.workspaceUrl;
    if (!url) return;
    openExternal(url);
  });

  document.querySelector('[data-add-portfolio]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Додаємо до колекції…';
    try { await mutateAndRefresh(() => api.addToPortfolio(button.dataset.addPortfolio)); if (active === 'portfolio') render('portfolio', false); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });

  const homeworkForm = document.querySelector('#homeworkSubmit');
  homeworkForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(homeworkForm);
    const contentUrl = String(values.get('contentUrl') ?? '').trim();
    const button = homeworkForm.querySelector('button'); button.disabled = true; button.textContent = 'Надсилаємо…';
    try {
      await mutateAndRefresh(() => api.submitHomework(homeworkForm.dataset.homeworkId, { contentText: String(values.get('contentText') ?? ''), ...(contentUrl ? { contentUrl } : {}), studentComment: String(values.get('studentComment') ?? '') }));
      if (active === 'homework' && currentHomework?.id === homeworkForm.dataset.homeworkId) {
        currentHomework = data.homework.find(item=>item.id===homeworkForm.dataset.homeworkId);
        render('homework', false);
      }
    } catch (error) { button.disabled = false; button.textContent = error.message; }
  });

  document.querySelector('#openNotificationsFromProfile')?.addEventListener('click', openNotifications);

  document.querySelector('#openMentorBooking')?.addEventListener('click', async () => {
    const panel = document.querySelector('#mentorBooking'); panel.hidden = false;
    const list = panel.querySelector('.mentor-slots');
    try {
      const slots = await api.mentorSlots();
      list.innerHTML = slots.length ? slots.map(slot=>`<button class="mentor-slot" data-mentor-slot="${slot.id}" ${slot.available?'':'disabled'}><span>${escapeHtml(formatClassTime(slot.startsAt,slot.timezone))}</span><strong>${escapeHtml(slot.mentorName)}</strong><small>${escapeHtml(slot.mentorTitle)}</small></button>`).join('') : '<p class="empty-inline">Нові вікна з’являться незабаром.</p>';
      list.querySelectorAll('[data-mentor-slot]').forEach(slotButton => slotButton.onclick = async () => {
        slotButton.disabled = true; slotButton.textContent = 'Бронюємо…';
        try { await api.bookMentor(slotButton.dataset.mentorSlot); slotButton.textContent = 'Зустріч зарезервовано'; slotButton.classList.add('booked'); }
        catch (error) { slotButton.disabled = false; slotButton.textContent = error.message; }
      });
    } catch (error) { list.innerHTML = `<p class="empty-inline">${escapeHtml(error.message)}</p>`; }
  });
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-tab]');
  if (target && !target.closest('#view')) render(target.dataset.tab);
});

async function renderFromLocation() {
  if (!data) return;
  const requested = location.hash.replace('#', '');
  if (requested.startsWith('lesson=')) { await openLesson(requested.slice(7), false); return; }
  if (requested.startsWith('homework=')) { openHomework(requested.slice(9), false); return; }
  const next = templates[requested] ? requested : 'home';
  if (next !== active || !view.querySelector('.page')) render(next, false);
}

window.addEventListener('popstate', renderFromLocation);
window.addEventListener('hashchange', renderFromLocation);

async function initialize() {
  authError = '';
  loadingView();
  try {
    await api.authenticate();
    await refreshData();
    await renderFromLocation();
  } catch (error) {
    authError = error.message;
    errorView(authError);
  }
}

initialize();

async function refreshAcademicData() {
  const snapshot = await api.bootstrap();
  if (!canApplyAcademicData()) return false;
  await refreshData(snapshot);
  if (active === 'lesson' && currentLesson) {
    const lessonId = currentLesson.id;
    const visible = data.learning.modules.some(module => module.lessons.some(lesson => lesson.id === lessonId));
    const refreshed = visible ? await api.lesson(lessonId) : null;
    if (active === 'lesson' && currentLesson?.id === lessonId) currentLesson = refreshed;
  }
  if (active === 'homework' && currentHomework) {
    currentHomework = data.homework.find(item => item.id === currentHomework.id) ?? { ...currentHomework, withdrawn: true };
  }
  if (!canApplyAcademicData()) return false;
  render(active, false);
}

function showSyncError() {
  const banner = document.querySelector('#syncStatus');
  banner.hidden = false;
  banner.querySelector('span').textContent = navigator.onLine === false
    ? 'Немає з’єднання. Показуємо останні завантажені дані.'
    : 'Не вдалося оновити дані. Спробуй ще раз.';
}

function revealForm(id) {
  const form = view.querySelector('#' + id);
  if (!form) return;
  form.hidden = false;
  form.scrollIntoView({ block: 'start', behavior: 'auto' });
  form.querySelector('input:not(:disabled), textarea:not(:disabled)')?.focus({ preventScroll: true });
}

document.querySelector('#retrySync').addEventListener('click', () => refreshAcademicData().catch(showSyncError));
window.addEventListener('online', () => { if (data) refreshAcademicData().catch(showSyncError); });
window.addEventListener('offline', () => { if (data) showSyncError(); });
try { tg?.BackButton?.onClick?.(() => render('learn')); } catch {}

function canApplyAcademicData() {
  return Boolean(data) && !notificationPanelOpen && !pendingMutation && !view.hasAttribute('aria-busy');
}

startAcademicSync({ revision: api.revision, canApply: canApplyAcademicData,
  refresh: refreshAcademicData, onError: showSyncError });
