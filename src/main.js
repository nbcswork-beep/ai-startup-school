import {startAcademicSync} from './academic-sync.js';
import { api } from './api.js';
import { createActionGate, createNavigationGuard, navigationSection, performUiAction } from './student-interactions.js';
import { HOMEWORK_FILE_ACCEPT, checkSelection, formatFileSize, isFinalUploadError, sendFile } from './homework-uploads.js';
import { aiStartLearningContext, aiHandleBack, aiScreenMarkup, aiSelectConversation, mountAiScreen } from './ai-chat.js';

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
    tg.setHeaderColor('#100B28');
    tg.setBackgroundColor('#100B28');
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

let firstName = 'Творець';
let data = null;
let currentLesson = null;
let currentHomework = null;
let aiOrigin = 'home';
let authError = '';
let notificationPanelOpen = false;
let notificationReturnFocus = null;
// Items that were unread when the panel opened stay highlighted until it closes,
// even though they are persisted as read right away.
let notificationFreshIds = new Set();
let notificationRequestVersion = 0;
const actionGate = createActionGate();
const navigationGuard = createNavigationGuard();
let lessonRequest = null;
const detailOrigins = { lesson: { tab: 'learn', scroll: 0 }, homework: { tab: 'learn', scroll: 0 } };
let returnScroll = null;
let errorReturnPage = null;

const icons = {
  home: '<path d="m3.5 10.8 8.5-7.3 8.5 7.3"/><path d="M5.5 9.5v10.8h13V9.5M9.4 20.3v-6.1h5.2v6.1"/>',
  learn: '<path d="M3.5 5.2A2.2 2.2 0 0 1 5.7 3h4.1a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3H5.7a2.2 2.2 0 0 0-2.2 2.2z"/><path d="M20.5 5.2A2.2 2.2 0 0 0 18.3 3h-4.1a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3h4.1a2.2 2.2 0 0 1 2.2 2.2z"/>',
  project: '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 9h17M8.5 9V4M8.5 14h3.2M8.5 17h6.7"/>',
  portfolio: '<rect x="3.5" y="6.5" width="17" height="13" rx="2.5"/><path d="M8.5 6.5V4h7v2.5M3.5 12h17M9.5 12v2h5v-2"/>',
  ai: '<path d="M12 2.7 14.1 8l5.2 2.1-5.2 2.1L12 17.5l-2.1-5.3-5.2-2.1L9.9 8z"/><path d="m18.7 16 .8 2.1 2.1.8-2.1.9-.8 2.1-.9-2.1-2.1-.9 2.1-.8z"/>',
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

function stateIcon(status) {
  if (status === 'done') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.4 3.4 7.7-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  if (status === 'current' || status === 'available') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5 16.5 12 8 18.5z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.7 10V7.5a3.3 3.3 0 0 1 6.6 0V10" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function isHomeworkVideoResource(resource) {
  const href = safeHttpsUrl(resource.url);
  if (!href) return false;
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (/\.(?:mp4|webm|mov|m4v|ogv|avi|mkv)$/i.test(path)) return true;
  if (['youtu.be', 'www.youtu.be'].includes(host) && path !== '/') return true;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)
    && ((path === '/watch' && Boolean(url.searchParams.get('v'))) || /^\/(?:shorts|embed|live)\/[^/]+/.test(path))) return true;
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host) && /^\/(?:video\/)?\d+(?:\/|$)/.test(path)) return true;
  if (['loom.com', 'www.loom.com'].includes(host) && /^\/(?:share|embed)\/[^/]+/.test(path)) return true;
  // Legacy attachments share the "link" kind; a named video can use any HTTPS host.
  if (!['link', 'other'].includes(resource.kind) || /\.(?:pdf|docx?|pptx?|xlsx?|txt|md|zip|png|jpe?g|svg)$/i.test(path)) return false;
  return /(?:^|[^\p{L}\p{N}])(?:відео|видео|video)(?=$|[^\p{L}\p{N}])/iu.test(resource.title ?? '');
}

function formatClassTime(value, timezone = 'Europe/Kyiv') {
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(value));
}

function effortLabel(value) {
  return ({ needs_attention: 'Потрібно більше уваги', good_effort: 'Старався', high_effort: 'Дуже старався' })[value] ?? '';
}

function homeworkStateLabel(value) {
  return ({ not_started: 'НОВЕ', in_progress: 'ЧЕРНЕТКА', submitted: 'НА ПЕРЕВІРЦІ', needs_revision: 'НА ДОПРАЦЮВАННІ', completed: 'ПЕРЕВІРЕНО' })[value] ?? value;
}

// One status vocabulary for every homework surface: Нове, Чернетка, На перевірці, Перевірено, На доопрацюванні.
function homeworkStatus(homework) {
  const submission = homework.latestSubmission;
  if (homework.withdrawn) return { label: 'Неактивне', tone: 'muted' };
  if (!submission) return homework.draftFiles?.length ? { label: 'Чернетка', tone: 'draft' } : { label: 'Нове', tone: 'new' };
  if (submission.status === 'needs_revision') return { label: 'На доопрацюванні', tone: 'revision' };
  if (submission.status === 'completed' || submission.review) return { label: 'Перевірено', tone: 'done' };
  if (submission.status === 'submitted') return { label: 'На перевірці', tone: 'review' };
  return { label: 'Чернетка', tone: 'draft' };
}

function plural(count, one, few, many) {
  const mod10 = count % 10, mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function portalMarkup(size = 'large', label = 'AI', sublabel = 'CORE') {
  return `<div class="creation-engine ${size}" aria-hidden="true">
    <div class="engine-track track-one"><i></i></div>
    <div class="engine-track track-two"><i></i></div>
    <div class="engine-track track-three"><i></i></div>
    <div class="engine-core"><span>${label}</span><small>${sublabel}</small></div>
  </div>`;
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
        <button class="btn btn--icon btn--secondary ai-entry" type="button" data-tab="ai" aria-label="ШІ-асистент">${svgIcon('ai')}</button>
        <button class="btn btn--icon btn--secondary notification" id="notificationBell" type="button" aria-label="Сповіщення" aria-controls="studentNotifications" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><i class="notification-dot" hidden></i>
        </button>
        <button class="btn btn--icon btn--primary avatar" type="button" data-tab="profile" aria-label="Відкрити профіль">${firstName[0]?.toUpperCase() || 'M'}</button>
      </div>
    </header>
    <main id="view" class="view"></main>
    <nav class="bottom-nav" aria-label="Головна навігація">
      ${nav.map(([id, label]) => `<button class="nav-item" data-tab="${id}" aria-label="${label}"><span class="nav-icon">${svgIcon(id)}</span><span class="nav-label">${label}</span></button>`).join('')}
    </nav>
    <button class="notification-backdrop" id="notificationBackdrop" type="button" aria-label="Закрити сповіщення" hidden></button>
    <section class="notification-panel" id="studentNotifications" role="dialog" aria-modal="true" aria-labelledby="notificationPanelTitle" hidden>
      <header class="notification-panel-head">
        <div><span>STUDENT APP</span><h2 id="notificationPanelTitle">Сповіщення</h2></div>
        <button class="btn btn--icon btn--secondary notification-close" id="closeNotifications" type="button" aria-label="Закрити сповіщення">${closeIcon()}</button>
      </header>
      <div class="notification-panel-tools"><span id="notificationCount">0 непрочитаних</span><button class="btn btn--ghost btn--sm" id="markAllNotifications" type="button">Позначити всі прочитаними</button></div>
      <div class="notification-list" id="notificationList" aria-live="polite"></div>
    </section>
  </div>`;

const view = document.querySelector('#view');
view.tabIndex = -1;
const notificationBell = document.querySelector('#notificationBell');
const notificationDot = notificationBell.querySelector('.notification-dot');
const notificationBackdrop = document.querySelector('#notificationBackdrop');
const notificationPanel = document.querySelector('#studentNotifications');
const notificationList = document.querySelector('#notificationList');
const notificationCount = document.querySelector('#notificationCount');
const markAllNotifications = document.querySelector('#markAllNotifications');
let active = 'home';
let requestedTab = 'home';
let renderTimer;

function showActionStatus(anchor, state, message) {
  if (!anchor?.isConnected) return;
  const host = anchor.closest('form') ?? (anchor.closest('.notification-panel') || anchor.parentElement);
  let status = [...host.children].find(child => child.classList.contains('action-feedback'));
  if (!status) { status = document.createElement('p'); status.className = 'action-feedback'; host.append(status); }
  status.dataset.state = state;
  status.setAttribute('role', state === 'error' ? 'alert' : 'status');
  status.textContent = message;
}

function runAction(button, key, loadingText, operation, afterSuccess, options = {}) {
  return performUiAction(actionGate, {
    key, button, form: button.closest('form'), loadingText, operation, afterSuccess,
    onStatus: (state, message) => showActionStatus(button, state, message), ...options
  });
}

function rememberOrigin(page) {
  if (!['lesson', 'homework'].includes(active)) detailOrigins[page] = { tab: active, scroll: window.scrollY };
}

function backLabel(page) { return nav.find(([id]) => id === detailOrigins[page].tab)?.[1] ?? 'Навчання'; }

function updateTelegramBackButton() {
  const mentorOpen = document.querySelector('#mentorBooking')?.hidden === false;
  const visible = Boolean(data && (notificationPanelOpen || mentorOpen || lessonRequest || errorReturnPage || ['lesson', 'homework', 'ai'].includes(active)));
  try { if (visible) tg?.BackButton?.show(); else tg?.BackButton?.hide(); } catch {}
}

function closeMentorBooking() {
  const panel = document.querySelector('#mentorBooking');
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  const opener = document.querySelector('#openMentorBooking');
  opener?.setAttribute('aria-expanded', 'false');
  opener?.focus();
  updateTelegramBackButton();
  return true;
}

function goBack(requestedPage) {
  if (notificationPanelOpen) { closeNotifications(); return; }
  if (active === 'ai' && aiHandleBack()) return;
  if (closeMentorBooking()) return;
  const page = typeof requestedPage === 'string' ? requestedPage : errorReturnPage ?? (lessonRequest ? 'lesson' : active);
  const origin = detailOrigins[page];
  if (origin) {
    returnScroll = origin.scroll;
    if (!lessonRequest && !errorReturnPage && history.state?.studentDetail === page) history.back();
    else render(origin.tab);
  } else if (active === 'ai') render(aiOrigin);
}

try { tg?.BackButton?.onClick(goBack); } catch {}
document.querySelectorAll('.topbar button, .nav-item').forEach(button => { button.disabled = true; });

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
  markAllNotifications.disabled = notifications.unreadCount < 1 || actionGate.has('notifications:read');
  if (!actionGate.has('notifications:read')) {
    markAllNotifications.textContent = 'Позначити всі прочитаними';
    delete markAllNotifications.dataset.actionState;
  }
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
    if (actionGate.has(`notification:open:${id}`)) return;
    item.disabled = true;
    await actionGate.run(`notification:open:${id}`, async () => {
      try { data.notifications = await actionGate.run('notifications:read', () => api.markNotificationsRead([id])); updateNotificationBell(); }
      catch {}
      if (notificationPanelOpen && item.isConnected) navigateFromNotification(item);
    });
  }));
}

function navigateFromNotification(item) {
  closeNotifications();
  if (item.dataset.homework && data.homework?.some(homework => homework.id === item.dataset.homework)) openHomework(item.dataset.homework);
  else if (item.dataset.notificationTab) render(item.dataset.notificationTab);
}

async function openNotifications() {
  if (!data || notificationPanelOpen) return;
  const requestVersion = ++notificationRequestVersion;
  notificationPanelOpen = true;
  notificationReturnFocus = document.activeElement;
  notificationBell.setAttribute('aria-expanded', 'true');
  notificationBackdrop.hidden = false;
  notificationPanel.hidden = false;
  notificationPanel.querySelector('.action-feedback')?.remove();
  notificationBackdrop.tabIndex = -1;
  for (const element of document.querySelectorAll('.topbar, .bottom-nav, #view')) element.inert = true;
  document.body.classList.add('notifications-open');
  notificationList.innerHTML = '<div class="notification-loading">Завантажуємо сповіщення…</div>';
  document.querySelector('#closeNotifications').focus();
  updateTelegramBackButton();
  try {
    const notifications = await actionGate.run('notifications:load', () => api.notifications());
    if (!notificationPanelOpen || requestVersion !== notificationRequestVersion) return;
    data.notifications = notifications;
    notificationFreshIds = new Set(data.notifications.items.filter(item => !item.readAt).map(item => item.id));
    renderNotificationPanel();
    const unreadIds = data.notifications.items.filter(item => !item.readAt).map(item => item.id);
    if (unreadIds.length) {
      try {
        data.notifications = await actionGate.run('notifications:read', () => api.markNotificationsRead(unreadIds));
        if (!notificationPanelOpen || requestVersion !== notificationRequestVersion) { updateNotificationBell(); return; }
        renderNotificationPanel(); updateNotificationBell();
      } catch (error) { if (notificationPanelOpen && requestVersion === notificationRequestVersion) showActionStatus(markAllNotifications, 'error', error.message); }
    }
  } catch (error) {
    if (!notificationPanelOpen || requestVersion !== notificationRequestVersion) return;
    notificationList.innerHTML = `<div class="notification-empty error"><strong>Не вдалося завантажити сповіщення</strong><small>${escapeHtml(error.message)}</small></div>`;
  }
}

function closeNotifications() {
  if (!notificationPanelOpen) return;
  notificationPanelOpen = false;
  notificationRequestVersion += 1;
  notificationFreshIds = new Set();
  notificationBell.setAttribute('aria-expanded', 'false');
  notificationBackdrop.hidden = true;
  notificationPanel.hidden = true;
  for (const element of document.querySelectorAll('.topbar, .bottom-nav, #view')) element.inert = false;
  document.body.classList.remove('notifications-open');
  notificationReturnFocus?.focus?.();
  updateTelegramBackButton();
}

notificationBell.addEventListener('click', openNotifications);
notificationBackdrop.addEventListener('click', closeNotifications);
document.querySelector('#closeNotifications').addEventListener('click', closeNotifications);
markAllNotifications.addEventListener('click', async () => {
  if (!data) return;
  await runAction(markAllNotifications, 'notifications:read', 'Позначаємо…', () => api.markNotificationsRead(), result => {
    data.notifications = result; renderNotificationPanel(); updateNotificationBell();
  }, { successText: 'Усі сповіщення прочитано' });
});

document.addEventListener('keydown', event => {
  if (!notificationPanelOpen && event.key === 'Escape' && closeMentorBooking()) { event.preventDefault(); return; }
  if (!notificationPanelOpen) return;
  if (event.key === 'Escape') { event.preventDefault(); closeNotifications(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...notificationPanel.querySelectorAll('button:not(:disabled)')];
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

function home() {
  const homeData = data.home;
  const lesson = homeData.currentLesson;
  const projectData = homeData.currentProject;
  const progress = homeData.course.progressPercent;
  const nextClass = homeData.nextClass ?? data.schedule?.nextClass;
  const joinUrl = safeHttpsUrl(nextClass?.meetingUrl);
  return `
    <section class="page home-page${nextClass ? ' has-next-class' : ''}${homeData.homeworkDue ? ' has-homework' : ''}">
      <div class="eyebrow">ДОБРОГО ДНЯ, ${firstName.toUpperCase()} <span></span></div>
      <section class="home-hero">
        <div class="hero-copy">
          <span class="coordinate">ТВІЙ ШЛЯХ · ${String(Math.min(homeData.course.completedLessons + 1, homeData.course.totalLessons)).padStart(2, '0')}/${String(homeData.course.totalLessons).padStart(2, '0')}</span>
          <h1>Твоя ідея<br><em>стає проєктом.</em></h1>
          <p>Крок за кроком: від першої думки до продукту, який працює.</p>
          <button type="button" class="btn btn--primary btn--lg" data-tab="learn">Продовжити навчання ${arrowIcon()}</button>
        </div>
        <div class="hero-engine-wrap">${portalMarkup('large')}</div>
        <div class="hero-progress" aria-label="Прогрес курсу ${progress} відсотків"><span>КУРС</span><strong>${progress}%</strong><i><b style="width:${progress}%"></b></i></div>
      </section>

      ${nextClass ? `<section class="next-class-zone">
        <div class="class-signal"><span>LIVE</span><i></i></div>
        <div class="class-copy"><span>НАСТУПНЕ ЖИВЕ ЗАНЯТТЯ</span><h2>${escapeHtml(nextClass.title)}</h2><p>${escapeHtml(formatClassTime(nextClass.startsAt, data.schedule.timezone))} · ${nextClass.durationMinutes} хв · ${escapeHtml(nextClass.teacherName)}</p></div>
        ${joinUrl ? `<button type="button" class="btn btn--secondary btn--block class-join" data-external="${escapeHtml(joinUrl)}">Приєднатися до заняття ${externalIcon()}</button>` : '<span class="class-link-pending">Посилання з’явиться перед заняттям</span>'}
      </section>` : ''}

      <button type="button" class="next-step card-action" ${lesson ? `data-lesson="${lesson.id}"` : 'data-tab="learn"'} aria-label="${lesson ? `Відкрити урок: ${escapeHtml(lesson.title)}` : 'До навчання'}">
        <span class="step-index"><small>УРОК</small><strong>${lesson?.number ?? '—'}</strong></span>
        <span class="step-copy"><span>НАСТУПНИЙ КРОК</span><strong class="card-title">${escapeHtml(lesson?.title ?? (homeData.course.totalLessons ? 'Маршрут завершено' : 'Занять ще немає'))}</strong><span class="card-description">${escapeHtml(lesson?.summary ?? (homeData.course.totalLessons ? 'Переглянь свої досягнення та обери наступну ціль.' : 'Викладач ще не додав заняття для вашої групи.'))}</span><span class="card-action-label">${lesson ? 'Відкрити урок' : 'До навчання'}</span></span>
        <span class="round-arrow" aria-hidden="true">${arrowIcon()}</span>
      </button>

      ${homeData.homeworkDue ? `<button type="button" class="homework-pulse" data-homework="${homeData.homeworkDue.id}"><span>HOMEWORK · ${escapeHtml(homeworkStatus(homeData.homeworkDue).label.toUpperCase())}</span><strong>${escapeHtml(homeData.homeworkDue.title)}</strong><small>${homeData.homeworkDue.dueAt ? `До ${escapeHtml(formatClassTime(homeData.homeworkDue.dueAt, data.schedule.timezone))}` : 'Без дедлайну'}</small>${arrowIcon()}</button>` : ''}

      <div class="signal-strip" aria-label="Твоя статистика">
        <div><span class="signal-mark bolt">ϟ</span><strong>${homeData.viewer.streak}</strong><small>дні поспіль</small></div>
        <div><span class="signal-mark">${String(homeData.projectCount).padStart(2, '0')}</span><strong>${homeData.projectCount}</strong><small>проєкти</small></div>
        <div><span class="signal-mark">XP</span><strong>${homeData.viewer.xp}</strong><small>досвід</small></div>
      </div>

      <div class="section-head"><div><span class="section-kicker">STARTUP LAB</span><h2>Ти зараз будуєш</h2></div><button type="button" class="btn btn--ghost btn--sm" data-tab="project">До проєкту ${arrowIcon()}</button></div>
      <button type="button" class="project-preview card-action" data-tab="project" aria-label="Відкрити мій проєкт">
        <span class="preview-rail" aria-hidden="true">${Array.from({ length: projectData?.stage.total ?? 5 }, (_, index) => `<i class="${index < (projectData?.stage.position ?? 0) ? 'done' : ''}"></i>`).join('')}</span>
        <span class="preview-copy"><span>MVP · ЕТАП ${projectData?.stage.position ?? 0} З ${projectData?.stage.total ?? 5}</span><strong class="card-title">${escapeHtml(projectData?.title ?? 'Створи перший проєкт')}</strong><span class="card-description">${escapeHtml(projectData?.tasks.find(task => task.status === 'in_progress')?.title ?? 'Сформулюй свою ідею')}</span><span class="card-action-label">Відкрити проєкт</span></span>
        <span class="preview-progress"><strong>${projectData?.completionPercent ?? 0}%</strong><span>створено</span></span>
      </button>
    </section>`;
}

// «Навчання»: what to do next first, then this week and homework beside it, then the whole route.
function learn() {
  const learning = data.learning;
  const course = learning.course;
  const module = learning.modules[0];
  const lessons = module?.lessons ?? [];
  const open = lessons.filter(lesson => ['current', 'available'].includes(lesson.state));
  const nextLesson = open.find(lesson => lesson.id === data.home.currentLesson?.id) ?? open[0] ?? null;
  const timezone = data.schedule?.timezone ?? 'Europe/Kyiv';
  const weekClasses = data.schedule?.thisWeek ?? [];
  const homework = data.homework ?? [];
  const activeHomework = homework.filter(item => item.state !== 'completed').length;
  const recoveries = data.recoveries ?? [];
  const progress = Math.max(0, Math.min(100, course.progressPercent));
  const lessonCount = `${course.completedLessons} з ${course.totalLessons} ${plural(course.totalLessons, 'уроку', 'уроків', 'уроків')}`;
  return `
    <section class="page learn">
      <header class="learn-head">
        <h1>Навчання</h1>
        ${lessons.length ? `<div class="learn-course">
          <p><strong>${escapeHtml(module?.title ?? course.title)}</strong><span>${lessonCount}</span></p>
          <div class="learn-track" role="progressbar" aria-label="Пройдено ${lessonCount}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><i style="width:${progress}%"></i></div>
        </div>` : ''}
      </header>
      ${learnNextMarkup(nextLesson, lessons.length)}
      <aside class="learn-side">
        <section class="learn-panel learn-week" aria-labelledby="learnWeekTitle">
          <div class="learn-panel-head"><h2 id="learnWeekTitle">Цього тижня</h2>${weekClasses.length ? `<span class="learn-count">${weekClasses.length} ${plural(weekClasses.length, 'заняття', 'заняття', 'занять')}</span>` : ''}</div>
          ${weekClasses.length ? `<div class="learn-list">${weekClasses.map(item => learnClassMarkup(item, timezone)).join('')}</div>` : '<p class="learn-empty">Живих занять цього тижня немає.</p>'}
        </section>
        <section class="learn-panel learn-homework" aria-labelledby="learnHomeworkTitle">
          <div class="learn-panel-head"><h2 id="learnHomeworkTitle">Домашні завдання</h2>${activeHomework ? `<span class="learn-count">${activeHomework} ${plural(activeHomework, 'активне', 'активні', 'активних')}</span>` : ''}</div>
          ${homework.length ? `<div class="learn-list">${homework.map(item => learnHomeworkMarkup(item, timezone)).join('')}</div>` : '<p class="learn-empty">Завдань поки немає. Вони зʼявляться після заняття.</p>'}
        </section>
        <button type="button" class="learn-mentor card-action" data-tab="profile">
          <span class="learn-mentor-icon" aria-hidden="true">${svgIcon('profile')}</span>
          <span class="learn-mentor-body"><strong>Потрібна допомога?</strong><small>Забронюй зустріч 1:1 з ментором у профілі.</small></span>
          ${arrowIcon()}
        </button>
      </aside>
      ${recoveries.length ? `<section class="learn-catchup" aria-labelledby="learnCatchupTitle">
        <div class="learn-panel-head"><h2 id="learnCatchupTitle">Наздогнати пропущене</h2></div>
        ${recoveries.map(item => `<article class="recovery-card ${item.status}">
          <div class="recovery-card-head"><span>Пропущене заняття</span><small>${escapeHtml(formatClassTime(item.startsAt, timezone))}</small></div>
          <h3>${escapeHtml(item.lessonTitle || item.title)}</h3><p>${escapeHtml(item.description)}</p>
          ${item.materials.length ? `<div class="recovery-materials">${item.materials.map(material => safeHttpsUrl(material.url) ? `<button type="button" class="btn btn--secondary btn--row btn--block" data-external="${escapeHtml(safeHttpsUrl(material.url))}"><span class="btn-label">${escapeHtml(material.title)}</span>${externalIcon()}</button>` : `<span class="recovery-material-pending">${escapeHtml(material.title)}</span>`).join('')}</div>` : '<small class="recovery-empty">Матеріали ще готує викладач.</small>'}
          ${item.homework ? `<div class="recovery-task"><span>Що зробити самостійно</span><strong>${escapeHtml(item.homework.title)}</strong><p>${escapeHtml(item.homework.instructions)}</p></div>` : ''}
          ${item.homework || item.mentorSlotId ? `<div class="recovery-actions">${item.homework ? `<button type="button" class="btn btn--primary btn--row recovery-homework" data-homework="${item.homework.id}"><span class="btn-label">Відкрити домашнє завдання</span>${arrowIcon()}</button>` : ''}${item.mentorSlotId ? `<button type="button" class="btn btn--outline recovery-mentor" data-recovery-mentor="${item.mentorSlotId}">Записатися до ментора</button>` : ''}</div>` : ''}
        </article>`).join('')}
      </section>` : ''}
      ${lessons.length ? `<section class="learn-route" aria-labelledby="learnRouteTitle">
        <div class="learn-panel-head"><h2 id="learnRouteTitle">Маршрут курсу</h2><span class="learn-count">${lessonCount}</span></div>
        <ol class="route">${lessons.map(lesson => learnStopMarkup(lesson, nextLesson)).join('')}</ol>
      </section>` : ''}
    </section>`;
}

function learnNextMarkup(lesson, lessonCount) {
  if (!lesson) {
    return lessonCount
      ? `<button type="button" class="learn-next is-finished card-action" data-tab="project">
          <span class="learn-next-body"><span class="learn-next-lead">Усі уроки модуля пройдено</span><strong class="learn-next-title">Маршрут завершено</strong><span class="learn-next-summary">Час довести до ладу свій проєкт.</span><span class="learn-next-foot"><span class="learn-next-cta">Відкрити проєкт</span></span></span>
        </button>`
      : `<div class="learn-next is-empty"><span class="learn-next-body"><strong class="learn-next-title">Уроків ще немає</strong><span class="learn-next-summary">Викладач ще не додав уроки для вашої групи. Вони зʼявляться тут.</span></span></div>`;
  }
  const started = lesson.state === 'current' && lesson.progressPercent > 0;
  return `<button type="button" class="learn-next card-action" data-lesson="${lesson.id}" aria-label="${started ? 'Продовжити' : 'Почати'} урок ${escapeHtml(lesson.number)}: ${escapeHtml(lesson.title)}">
    <span class="learn-next-number" aria-hidden="true">${escapeHtml(lesson.number)}</span>
    <span class="learn-next-body">
      <span class="learn-next-lead">${started ? `Пройдено ${lesson.progressPercent}% уроку` : 'Твій наступний урок'}</span>
      <strong class="learn-next-title">${escapeHtml(lesson.title)}</strong>
      ${lesson.summary ? `<span class="learn-next-summary">${escapeHtml(lesson.summary)}</span>` : ''}
      <span class="learn-next-foot">
        <span class="learn-next-cta">${started ? 'Продовжити урок' : 'Почати урок'}</span>
        ${lesson.estimatedMinutes ? `<span class="learn-next-fact">${lesson.estimatedMinutes} хв</span>` : ''}
        ${lesson.xpReward ? `<span class="learn-next-fact is-xp">+${lesson.xpReward} XP</span>` : ''}
      </span>
    </span>
  </button>`;
}

function learnClassMarkup(item, timezone) {
  const date = new Date(item.startsAt);
  const part = options => new Intl.DateTimeFormat('uk-UA', { ...options, timeZone: timezone }).format(date);
  const joinUrl = item.status === 'in_progress' ? safeHttpsUrl(item.meetingUrl) : null;
  const note = { in_progress: 'Іде зараз', rescheduled: 'Перенесено', cancelled: 'Скасовано', completed: 'Відбулося' }[item.status];
  return `<article class="learn-class is-${item.status}">
    <span class="learn-class-date"><small>${escapeHtml(part({ weekday: 'short' }))}</small><b>${escapeHtml(part({ day: 'numeric' }))}</b></span>
    <span class="learn-class-body">
      <strong>${escapeHtml(item.title)}</strong>
      <small><span>${escapeHtml(part({ hour: '2-digit', minute: '2-digit' }))}</span><span>${item.durationMinutes} хв</span>${note ? `<span class="learn-class-note">${note}</span>` : ''}</small>
    </span>
    ${joinUrl ? `<button type="button" class="btn btn--primary btn--sm" data-external="${escapeHtml(joinUrl)}">Приєднатися</button>` : ''}
  </article>`;
}

function learnHomeworkMarkup(item, timezone) {
  const status = homeworkStatus(item);
  const review = item.latestSubmission?.review;
  const detail = review ? `${review.score}/10, ${effortLabel(review.effort).toLowerCase()}` : item.dueAt ? `До ${formatClassTime(item.dueAt, timezone)}` : 'Без дедлайну';
  return `<button type="button" class="learn-hw" data-homework="${item.id}">
    <span class="learn-hw-body"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(detail)}</small></span>
    <span class="learn-status is-${status.tone}">${escapeHtml(status.label)}</span>
    ${arrowIcon()}
  </button>`;
}

function learnStopMarkup(lesson, nextLesson) {
  const state = lesson.state === 'completed' ? 'done' : lesson.state === 'locked' ? 'locked' : lesson.id === nextLesson?.id ? 'current' : 'available';
  const dot = state === 'done' ? stateIcon('done') : state === 'locked' ? stateIcon('locked') : escapeHtml(lesson.number);
  const note = { done: 'Пройдено', current: 'Зараз', available: 'Доступний', locked: '' }[state];
  const body = `<span class="route-dot" aria-hidden="true">${dot}</span>
    <span class="route-body"><small>Урок ${escapeHtml(lesson.number)}</small><strong>${escapeHtml(lesson.title)}</strong></span>
    ${note ? `<span class="route-note">${note}</span>` : '<span class="visually-hidden">Урок поки недоступний</span>'}`;
  return `<li class="route-stop is-${state}">${state === 'locked'
    ? `<div class="route-row">${body}</div>`
    : `<button type="button" class="route-row" data-lesson="${lesson.id}">${body}${arrowIcon()}</button>`}</li>`;
}

function project() {
  const projectData = data.projects.find(item => item.status === 'active') ?? data.projects[0];
  if (!projectData) return projectEmpty();
  const tasks = projectData.tasks;
  const currentTask=tasks.find(t=>t.status!=='completed');
  return `
    <section class="page project-page">
      <div class="page-title"><span class="section-kicker">STARTUP LAB</span><span class="zone-code">ZONE 03 · LAB</span><h1>Мій проєкт</h1><p>Тут ідея перетворюється на продукт.</p></div>
      <section class="project-engine">
        <div class="lab-readout"><span>BUILD CHANNEL</span><strong>${escapeHtml(projectData.stage.title.toUpperCase())}</strong><div>${Array.from({length:projectData.stage.total},(_,index)=>`<i class="${index+1<projectData.stage.position?'done':index+1===projectData.stage.position?'active':''}"></i>`).join('')}</div></div>
        <div class="project-engine-art">${portalMarkup('medium lab-engine', String(projectData.stage.position).padStart(2, '0'), 'BUILD')}<span class="stage-index">${String(projectData.stage.position).padStart(2, '0')}</span></div>
        <div class="project-engine-copy"><span>MVP · ${projectData.status === 'completed' ? 'ГОТОВО' : 'В РОБОТІ'}</span><h2>${escapeHtml(projectData.title)}</h2><p>${escapeHtml(projectData.summary)}</p></div>
        <div class="project-meter"><div><span>ГОТОВНІСТЬ</span><strong>${projectData.completionPercent}%</strong></div><i><b style="width:${projectData.completionPercent}%"></b></i></div>
      </section>
      <div class="stage-tags">${projectData.tags.map((tag,index)=>`${index?'<i></i>':''}<span>${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="section-head"><div><span class="section-kicker">СПРИНТ 01</span><h2>Збираємо основу</h2></div><button class="btn btn--outline btn--sm" id="editProject" type="button" aria-controls="projectEditor" aria-expanded="false">Редагувати проєкт</button></div>
      <div class="build-path">
        ${tasks.map(task => {
          const status = task.status === 'completed' ? 'done' : ['in_progress','available','pending_review','needs_revision'].includes(task.status) ? 'current' : 'locked';
          return `
          <article class="build-step ${status}" >
            <span class="build-marker">${status === 'done' ? stateIcon('done') : task.number}</span>
            <div><strong>${escapeHtml(task.title)}</strong><small>${status === 'done' ? 'Підтверджено викладачем' : task.status==='pending_review'?'На перевірці':task.status==='needs_revision'?'На доопрацювання':status === 'current' ? `Напиши відповідь · +${task.xpReward} XP після перевірки` : 'Відкриється після підтвердження попереднього етапу'}</small>${task.feedback?`<small>Коментар: ${escapeHtml(task.feedback)}</small>`:''}</div>
            <span class="build-reward">${status === 'done' ? `+${task.xpReward} XP` : status === 'current' ? '<span class="stage-direction">Відповідь нижче</span>' : stateIcon('locked')}</span>
          </article>`}).join('')}
      </div>
      ${currentTask?`<form class="project-editor" id="projectStageSubmit" data-project-id="${projectData.id}" data-task-id="${currentTask.id}" data-version="${currentTask.version??1}"><h3>Етап ${currentTask.number}: ${escapeHtml(currentTask.title)}</h3><p>${escapeHtml(currentTask.description)}</p>${currentTask.feedback?`<p class="stage-feedback">Коментар викладача: ${escapeHtml(currentTask.feedback)}</p>`:''}<label>Твоя відповідь<textarea name="contentText" maxlength="20000" required ${currentTask.status==='pending_review'?'disabled':''}>${escapeHtml(currentTask.contentText??'')}</textarea></label><p class="stage-review-status">${currentTask.status==='pending_review'?'Відповідь на перевірці. Наступний етап відкриє викладач.':'Наступний етап відкриється після підтвердження викладачем.'}</p><button type="submit" class="btn btn--primary btn--lg btn--block" ${currentTask.status==='pending_review'?'disabled':''}>${currentTask.status==='pending_review'?'На перевірці':`Надіслати на перевірку ${arrowIcon()}`}</button></form>`:''}
      <section class="project-notes"><h2>Нотатки й посилання проєкту</h2><p>Тут можна зберігати ідеї, результати й посилання та отримувати коментарі викладача.</p>${(projectData.notes??[]).map(note=>`<article class="project-editor"><p>${escapeHtml(note.contentText)}</p>${safeHttpsUrl(note.contentUrl)?`<button type="button" class="btn btn--ghost btn--sm" data-external="${escapeHtml(safeHttpsUrl(note.contentUrl))}">Відкрити посилання проєкту ${externalIcon()}</button>`:''}${note.replies.map(reply=>`<blockquote><strong>${escapeHtml(reply.teacherName)}</strong><p>${escapeHtml(reply.contentText)}</p></blockquote>`).join('')}</article>`).join('')}<form class="project-editor" id="projectNoteForm" data-project-id="${projectData.id}" data-version="${projectData.notes?.length??0}"><label>Нотатка<textarea name="contentText" maxlength="20000" placeholder="Ідея, результат чи питання до викладача…"></textarea></label><label>Посилання HTTPS<input type="url" name="contentUrl" maxlength="2048" placeholder="https://…"></label><button type="submit" class="btn btn--secondary btn--block">Зберегти нотатку</button></form></section>
      <section class="workspace-dock">
        <div class="workspace-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4M14 5l-4 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><span>CODE WORKSPACE</span><h3>Продовжити збірку</h3><p>Повна web-версія з кодом і preview.</p></div>
        ${projectData.workspaceUrl ? `<button type="button" class="btn btn--secondary btn--block" id="openCode">Відкрити робочий простір ${externalIcon()}</button>` : '<p class="workspace-pending">Посилання на робочий простір додасть викладач.</p>'}
      </section>
      <form class="project-editor" id="projectEditor" data-project-id="${projectData.id}" hidden><label>Назва<input name="title" value="${escapeHtml(projectData.title)}" maxlength="120" required></label><label>Короткий опис<textarea name="summary" maxlength="1000">${escapeHtml(projectData.summary)}</textarea></label><button type="submit" class="btn btn--secondary btn--block">Зберегти зміни</button></form>
    </section>`;
}

function projectEmpty() {
  return `<section class="page project-page"><div class="page-title"><span class="section-kicker">STARTUP LAB</span><span class="zone-code">ZONE 03 · LAB</span><h1>Мій проєкт</h1><p>Тут ідея перетворюється на продукт.</p></div><section class="project-empty">${portalMarkup('medium lab-engine','01','START')}<h2>Запусти перший проєкт</h2><p>Опиши одну проблему та ідею рішення. Перший етап надішлеш викладачу; наступні відкриються після перевірки.</p><form id="createProject"><label>Назва<input name="title" maxlength="120" required></label><label>Короткий опис<textarea name="summary" maxlength="1000"></textarea></label><button type="submit" class="btn btn--primary btn--lg btn--block">Створити проєкт ${arrowIcon()}</button></form></section></section>`;
}

function portfolio() {
  const portfolioData = data.portfolio;
  const projects = portfolioData?.projects ?? [];
  const activeProject = data.projects.find(item => item.status === 'active') ?? data.projects[0];
  const alreadyAdded = projects.some(item => item.projectId === activeProject?.id);
  return `
    <section class="page portfolio-page">
      <div class="page-title"><span class="section-kicker">CREATOR ARCHIVE</span><span class="zone-code">PRIVATE · ЗА ЗАМОВЧУВАННЯМ</span><h1>Портфоліо</h1><p>Не список уроків. Те, що ти справді створив і чого навчився.</p></div>
      <section class="portfolio-beacon">
        <div class="portfolio-orbit"><span>${projects.length}</span><small>PROJECTS</small><i></i><b></b></div>
        <div><span>ПРИВАТНА КОЛЕКЦІЯ</span><h2>${escapeHtml(portfolioData?.title ?? 'Моє портфоліо')}</h2><p>Тільки ти, твій викладач і авторизована школа бачать цю сторінку.</p></div>
      </section>
      <div class="section-head"><div><span class="section-kicker">СТВОРЕНО ТОБОЮ</span><h2>Проєкти</h2></div><span class="tiny-badge">${projects.length}</span></div>
      <div class="portfolio-list">
        ${projects.length ? projects.map(item => `<article class="portfolio-project"><div class="portfolio-project-signal"><span>BUILD</span><strong>${escapeHtml(item.title.slice(0,2).toUpperCase())}</strong><i></i></div><div><span>${item.completionDate ? 'ЗАВЕРШЕНО' : 'В РОБОТІ'}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.shortDescription)}</p><blockquote>${escapeHtml(item.reflection || 'Рефлексія з’явиться після наступного кроку.')}</blockquote><div class="skill-chips">${[...item.skills,...item.technologies].slice(0,5).map(skill=>`<small>${escapeHtml(skill)}</small>`).join('')}</div></div></article>`).join('') : '<section class="portfolio-empty"><h2>Твій перший проєкт уже близько</h2><p>Додай його свідомо, коли буде що показати й про що розповісти.</p></section>'}
      </div>
      ${activeProject && !alreadyAdded ? `<button type="button" class="btn btn--primary btn--lg btn--block portfolio-add" data-add-portfolio="${activeProject.id}">Додати до портфоліо: ${escapeHtml(activeProject.title)} ${arrowIcon()}</button>` : ''}
      <div class="section-head"><div><span class="section-kicker">НАВИЧКИ</span><h2>Що вже вмієш</h2></div></div>
      <div class="skill-field">${(portfolioData?.skills ?? []).map(item=>`<article><span>LV ${item.level}</span><strong>${escapeHtml(item.title)}</strong><i><b style="width:${item.level*20}%"></b></i></article>`).join('')}</div>
    </section>`;
}

function homeworkPage() {
  const homework = currentHomework ?? data.homework?.[0];
  if (!homework) return `<section class="page homework-page">${backButton('homework')}<div class="page-title"><h1>Домашніх завдань поки немає</h1></div></section>`;
  const submission = homework.latestSubmission;
  const review = submission?.review;
  const resources = (homework.resources ?? []).map(resource => ({ ...resource, url: safeHttpsUrl(resource.url) })).filter(resource => resource.url);
  const videos = resources.filter(isHomeworkVideoResource);
  const materials = resources.filter(resource => !isHomeworkVideoResource(resource));
  const canSubmit = homework.canSubmit ?? (!submission || submission.status === 'needs_revision' || submission.status === 'in_progress');
  const status = homeworkStatus(homework);
  const timezone = data.schedule?.timezone;
  return `<section class="page homework-page">
    ${backButton('homework')}
    <header class="hw-header">
      <div class="hw-header-top"><span class="section-kicker">ДОМАШНЄ ЗАВДАННЯ</span><span class="status-pill" data-tone="${status.tone}">${escapeHtml(status.label)}</span></div>
      <h1>${escapeHtml(homework.title)}</h1>
      <dl class="hw-meta">
        <div><dt>Дедлайн</dt><dd>${homework.dueAt ? escapeHtml(formatClassTime(homework.dueAt, timezone)) : 'Без дедлайну'}</dd></div>
        <div><dt>Заняття</dt><dd>${escapeHtml(homework.classTitle ?? 'Самостійна практика')}</dd></div>
        <div><dt>Нагорода</dt><dd>+${homework.xpReward} XP</dd></div>
      </dl>
    </header>
    <button type="button" class="btn btn--secondary btn--block" data-ai-learning="homework" data-id="${escapeHtml(homework.id)}" data-title="${escapeHtml(homework.title)}">Допомога ШІ з цим завданням</button>
    <section class="hw-card hw-task" aria-labelledby="hwTaskTitle"><h2 class="hw-card-title" id="hwTaskTitle">Завдання</h2><p class="hw-text">${escapeHtml(homework.instructions)}</p></section>
    ${videos.length ? `<section class="lesson-section homework-videos"><span class="section-kicker">ВІДЕО ДО ЗАВДАННЯ</span><div class="hw-link-list">${videos.map(resource => `<button type="button" class="btn btn--secondary btn--row btn--block homework-video-btn" data-external="${escapeHtml(resource.url)}"><span class="btn-label">${videoIcon()}<span>Відео — ${escapeHtml(resource.title)}</span></span>${externalIcon()}</button>`).join('')}</div></section>` : ''}
    ${materials.length ? `<section class="lesson-section homework-materials"><span class="section-kicker">МАТЕРІАЛИ ДО ЗАВДАННЯ</span><div class="hw-link-list">${materials.map(resource => `<button type="button" class="btn btn--secondary btn--row btn--block homework-material-btn" data-external="${escapeHtml(resource.url)}"><span class="btn-label">${escapeHtml(resource.title)}</span>${externalIcon()}</button>`).join('')}</div></section>` : ''}
    ${review ? `<section class="teacher-feedback ${review.status}"><div class="feedback-score"><strong>${review.score}</strong><small>/10</small></div><div><span>ВІДГУК ВИКЛАДАЧА</span><h2>${escapeHtml(effortLabel(review.effort))}</h2><p>${escapeHtml(review.feedback)}</p></div></section>` : ''}
    ${submission ? homeworkAttemptMarkup(submission, timezone) : ''}
    ${homework.withdrawn?'<p class="withdrawn-homework" role="status">Завдання більше не активне для вашої групи. Введений текст збережено на цій сторінці.</p>':''}
    ${canSubmit ? homeworkFormMarkup(homework, submission) : homeworkSentMarkup(status)}
  </section>`;
}

// Upload state lives outside the DOM so re-renders and background refreshes never lose a file.
// Uploaded files are server-side drafts; only the "leave out" choice is kept in sessionStorage.
const homeworkUploads = new Map();       // homeworkId → files being uploaded or failed
const homeworkExcludedFiles = new Map(); // homeworkId → ids of earlier-attempt files left out of the next attempt
const homeworkFileNotices = new Map();   // homeworkId → { type, text }
const FILE_KINDS = { pdf: 'pdf', doc: 'doc', docx: 'doc', pptx: 'slides', xlsx: 'sheet', txt: 'text', png: 'image', jpg: 'image', jpeg: 'image', zip: 'archive' };

/** Earlier-attempt files the student left out; kept for this app session so a reload keeps the choice. */
function excludedFileIds(id) {
  if (!homeworkExcludedFiles.has(id)) {
    let saved = [];
    try { saved = JSON.parse(globalThis.sessionStorage?.getItem(`aiss:homework-excluded:${id}`) ?? '[]'); } catch {}
    homeworkExcludedFiles.set(id, new Set(Array.isArray(saved) ? saved : []));
  }
  return homeworkExcludedFiles.get(id);
}

function saveExcludedFileIds(id) {
  const ids = [...excludedFileIds(id)];
  try {
    if (ids.length) sessionStorage.setItem(`aiss:homework-excluded:${id}`, JSON.stringify(ids));
    else sessionStorage.removeItem(`aiss:homework-excluded:${id}`);
  } catch {}
}

/** Files of the next attempt: kept earlier-attempt files, saved drafts, then uploads in flight. */
function homeworkFileEntries(homework) {
  const excluded = excludedFileIds(homework.id);
  const previous = homework.latestSubmission?.status === 'needs_revision' ? homework.latestSubmission.attachments ?? [] : [];
  return [
    ...previous.filter(file => !excluded.has(file.id)).map(file => ({ ...file, key: file.id, state: 'ready', carried: true })),
    ...(homework.draftFiles ?? []).map(file => ({ ...file, key: file.id, state: 'ready' })),
    ...(homeworkUploads.get(homework.id) ?? []).map(item => ({ key: item.key, id: item.serverId, name: item.name, extension: item.extension, size: item.size, state: item.state, progress: item.progress, error: item.error, retryable: item.retryable }))
  ];
}

function homeworkFormStatusText(homework) {
  const entries = homeworkFileEntries(homework);
  const busy = entries.filter(entry => ['queued', 'uploading', 'verifying'].includes(entry.state)).length;
  const failed = entries.filter(entry => entry.state === 'error');
  const ready = entries.filter(entry => entry.state === 'ready').length;
  if (busy) return `Завантажуємо ${busy} ${plural(busy, 'файл', 'файли', 'файлів')}. Надіслати можна після завершення.`;
  if (failed.length) return `${failed.length} ${plural(failed.length, 'файл', 'файли', 'файлів')} з помилкою. ${failed.some(entry => entry.retryable) ? 'Повтори завантаження або прибери зі списку.' : 'Прибери зі списку, щоб надіслати роботу.'}`;
  if (ready) return `${ready} ${plural(ready, 'файл', 'файли', 'файлів')} ${plural(ready, 'готовий', 'готові', 'готові')} до відправки і ${plural(ready, 'збережений', 'збережені', 'збережені')} на сервері.`;
  return 'Додай відповідь, посилання або файл.';
}

function fileItemMarkup(entry, { removable = true } = {}) {
  const extension = String(entry.extension ?? '').toLowerCase();
  const name = escapeHtml(entry.name ?? 'Файл');
  const busy = ['queued', 'uploading', 'verifying'].includes(entry.state);
  const percent = Math.round((entry.progress ?? 0) * 100);
  const stateText = entry.state === 'ready'
    ? (entry.url ? (entry.carried ? 'З попередньої спроби' : 'Завантажено') : 'Посилання тимчасово недоступне')
    : { queued: 'У черзі', uploading: `Завантаження ${percent}%`, verifying: 'Перевіряємо файл', error: 'Не завантажено' }[entry.state];
  const label = busy ? 'Скасувати завантаження' : entry.carried ? 'Не надсилати повторно' : 'Видалити';
  return `<li class="file-item" data-state="${entry.state}" data-file-key="${escapeHtml(entry.key)}">
    <span class="file-icon" data-kind="${FILE_KINDS[extension] ?? 'file'}" aria-hidden="true">${escapeHtml(extension.toUpperCase().slice(0, 4))}</span>
    <span class="file-body">
      <span class="file-name">${name}</span>
      <span class="file-meta">${escapeHtml(extension.toUpperCase())} · ${formatFileSize(entry.size)}</span>
      <span class="file-state">${stateText}</span>
      ${busy ? `<span class="file-progress" role="progressbar" aria-label="Завантаження: ${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${entry.state === 'verifying' ? 100 : percent}"><i style="width:${entry.state === 'verifying' ? 100 : percent}%"></i></span>` : ''}
      ${entry.state === 'error' ? `<span class="file-error" role="alert">${escapeHtml(entry.error || 'Не вдалося завантажити файл.')}</span>${entry.retryable ? `<button type="button" class="btn btn--outline btn--sm file-retry" data-file-retry="${escapeHtml(entry.key)}">${retryIcon()}Повторити</button>` : ''}` : ''}
    </span>
    <span class="file-actions">
      ${entry.state === 'ready' && entry.url ? `<button type="button" class="btn btn--icon btn--ghost btn--sm" data-file-open data-file-url="${escapeHtml(entry.url)}" data-file-expires="${escapeHtml(entry.urlExpiresAt ?? '')}" aria-label="Відкрити ${name}" title="Відкрити">${openFileIcon()}</button>` : ''}
      ${removable ? `<button type="button" class="btn btn--icon btn--ghost btn--sm file-remove" data-file-remove="${escapeHtml(entry.key)}" aria-label="${label}: ${name}" title="${label}">${busy ? closeIcon() : trashIcon()}</button>` : ''}
    </span>
  </li>`;
}

function homeworkFilesInner(homework, disabled = false) {
  const policy = data.fileUploads;
  const entries = homeworkFileEntries(homework);
  const attached = entries.filter(entry => entry.state !== 'error').length;
  const full = attached >= policy.maxFiles;
  const notice = homeworkFileNotices.get(homework.id);
  return `<div class="hw-files-head"><span class="field-label" id="homeworkFilesLabel">Файли</span><span class="hw-files-count">${attached} / ${policy.maxFiles}</span></div>
    <div class="hw-dropzone" data-dropzone>
      <input type="file" id="homeworkFileInput" class="visually-hidden" multiple accept="${HOMEWORK_FILE_ACCEPT}" tabindex="-1" aria-hidden="true">
      <button type="button" class="btn btn--outline btn--block hw-attach" id="homeworkAttach" aria-describedby="homeworkFilesHint"${full || disabled ? ' disabled' : ''}>${paperclipIcon()}${full ? 'Ліміт файлів досягнуто' : 'Прикріпити файл'}</button>
      <p class="hw-files-hint" id="homeworkFilesHint">PDF, DOCX, DOC, PPTX, XLSX, TXT, PNG, JPG, ZIP · до ${formatFileSize(policy.maxFileBytes)} кожен, разом до ${formatFileSize(policy.maxTotalBytes)}</p>
    </div>
    ${notice ? `<p class="hw-files-notice" data-state="${notice.type}" role="${notice.type === 'error' ? 'alert' : 'status'}">${escapeHtml(notice.text)}</p>` : ''}
    ${entries.length ? `<ul class="file-list" aria-labelledby="homeworkFilesLabel">${entries.map(entry => fileItemMarkup(entry, { removable: !disabled })).join('')}</ul>` : ''}`;
}

function homeworkFormMarkup(homework, submission) {
  const policy = data.fileUploads;
  const disabled = homework.withdrawn ? ' disabled' : '';
  const revision = submission?.status === 'needs_revision';
  return `<form class="hw-card hw-form" id="homeworkSubmit" data-homework-id="${escapeHtml(homework.id)}" novalidate>
    <div class="hw-card-head"><h2 class="hw-card-title">${revision ? 'Допрацюй і надішли ще раз' : 'Твоя робота'}</h2>${revision ? '<p class="hw-card-note">Файли попередньої спроби вже додано. Прибери зайві або додай нові.</p>' : ''}</div>
    <label class="field"><span class="field-label">Відповідь</span><textarea name="contentText" rows="5" maxlength="20000" placeholder="Опиши, що зробив і що вийшло"${disabled}></textarea></label>
    <label class="field"><span class="field-label">Посилання <span class="field-hint">за потреби</span></span><input name="contentUrl" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://"${disabled}></label>
    ${policy?.enabled
      ? `<div class="hw-files" id="homeworkFiles" data-homework-id="${escapeHtml(homework.id)}">${homeworkFilesInner(homework, Boolean(homework.withdrawn))}</div>`
      : `<div class="hw-files hw-files--off"><span class="field-label">Файли</span><p class="hw-files-note">${escapeHtml(policy?.reason ?? 'Прикріплення файлів зараз недоступне. Надішли роботу текстом або посиланням.')}</p></div>`}
    <label class="field"><span class="field-label">Коментар викладачу <span class="field-hint">за потреби</span></span><textarea name="studentComment" rows="3" maxlength="2000" placeholder="Що було складно або цікаво?"${disabled}></textarea></label>
    <div class="hw-form-footer">
      <p class="hw-form-status" id="homeworkFormStatus">${escapeHtml(homeworkFormStatusText(homework))}</p>
      <button type="submit" class="btn btn--primary btn--lg hw-submit"${disabled}>Надіслати домашнє завдання ${arrowIcon()}</button>
    </div>
  </form>`;
}

function homeworkAttemptMarkup(submission, timezone) {
  const link = safeHttpsUrl(submission.contentUrl);
  const files = submission.attachments ?? [];
  return `<section class="hw-card hw-attempt" aria-labelledby="hwAttemptTitle">
    <div class="hw-card-head"><h2 class="hw-card-title" id="hwAttemptTitle">Спроба ${submission.attemptNumber}</h2>${submission.submittedAt ? `<p class="hw-card-note">Надіслано ${escapeHtml(formatClassTime(submission.submittedAt, timezone))}</p>` : ''}</div>
    ${submission.contentText ? `<p class="hw-text">${escapeHtml(submission.contentText)}</p>` : ''}
    ${link ? `<button type="button" class="btn btn--secondary btn--row btn--block" data-external="${escapeHtml(link)}"><span class="btn-label">Посилання на роботу</span>${externalIcon()}</button>` : ''}
    ${files.length ? `<ul class="file-list" aria-label="Файли спроби ${submission.attemptNumber}">${files.map(file => fileItemMarkup({ ...file, key: file.id, state: 'ready' }, { removable: false })).join('')}</ul>` : ''}
    ${submission.studentComment ? `<p class="hw-comment"><span>Коментар викладачу</span>${escapeHtml(submission.studentComment)}</p>` : ''}
  </section>`;
}

function homeworkSentMarkup(status) {
  const done = status.tone === 'done';
  return `<section class="hw-card hw-sent" data-tone="${status.tone}" role="status">
    <span class="hw-sent-icon" aria-hidden="true">${checkIcon()}</span>
    <div><strong>${done ? 'Роботу перевірено' : 'Роботу надіслано'}</strong><p>${done ? 'Відгук викладача та історія спроб збережені.' : 'Викладач перевірить її найближчим часом. Якщо роботу повернуть на доопрацювання, тут з’явиться форма для нової спроби.'}</p></div>
  </section>`;
}

function profile() {
  const profileData = data.profile;
  const viewer = profileData.viewer;
  const achievements = profileData.achievements;
  return `
    <section class="page profile-page">
      <div class="profile-head">
        <div class="profile-orbit"><div class="big-avatar">${firstName[0]?.toUpperCase() || 'M'}</div><i></i><b></b></div>
        <span class="profile-level">${escapeHtml(viewer.level.title.toUpperCase())} · LEVEL ${viewer.level.number}</span><h1>${escapeHtml(firstName)}</h1><p>Будуєш ідеї, які працюють.</p>
        <p>${viewer.group ? `Група: ${escapeHtml(viewer.group.name)}${viewer.group.status==='archived'?' · Архів':''}` : 'Без групи'}</p>
      </div>
      <section class="level-track">
        <div><span>НАСТУПНИЙ РІВЕНЬ</span><strong>${escapeHtml(viewer.level.title)}${viewer.level.nextTitle ? ` → ${escapeHtml(viewer.level.nextTitle)}` : ''}</strong></div><b>${viewer.xp} <small>${viewer.level.nextMinXp ? `/ ${viewer.level.nextMinXp} XP` : 'XP'}</small></b>
        <i><em style="width:${profileData.nextLevelProgressPercent}%"></em></i>
      </section>
      <div class="profile-stats"><div><strong>${profileData.lessonCount}</strong><small>уроків</small></div><div><strong>${profileData.projectCount}</strong><small>проєкти</small></div><div><strong>${viewer.streak}</strong><small>дні серії</small></div></div>
      <div class="section-head"><div><span class="section-kicker">АРТЕФАКТИ</span><h2>Твоя колекція</h2></div><span class="tiny-badge">${achievements.filter(item => item.earned).length} / ${achievements.length}</span></div>
      <div class="artifacts">
        ${achievements.map((achievement, index) => { const type = achievement.earned ? achievement.artifactStyleKey : 'locked'; return `<article class="artifact ${type}"><span class="artifact-number">A-${String(index + 1).padStart(2, '0')}</span><div class="artifact-glyph"><i></i>${artifactIcon(type)}</div><span class="artifact-state">${achievement.earned ? 'ЗНАЙДЕНО' : 'НЕ ВІДКРИТО'}</span><strong>${escapeHtml(achievement.title)}</strong><small>${escapeHtml(achievement.description)}</small></article>`; }).join('')}
      </div>
      <div class="profile-links">
        <button type="button" data-tab="ai"><span class="link-icon">${svgIcon('ai')}</span><span><strong>ШІ-асистент</strong><small>Уроки, ідеї, код — у кількох чатах</small></span>${arrowIcon()}</button>
        <button id="openNotificationsFromProfile" type="button"><span class="link-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span><span><strong>Сповіщення</strong><small>Уроки та дедлайни</small></span>${arrowIcon()}</button>
        <button id="openMentorBooking" type="button" aria-controls="mentorBooking" aria-expanded="false"><span class="link-icon">1:1</span><span><strong>Допомога ментора</strong><small>${escapeHtml(profileData.mentor?.displayName ?? 'Обери зручний час')}</small></span>${arrowIcon()}</button>
      </div>
      <section class="mentor-booking" id="mentorBooking" hidden aria-labelledby="mentorBookingTitle"><div class="section-head compact-head"><div><span class="section-kicker">MENTOR 1:1</span><h2 id="mentorBookingTitle" tabindex="-1">Забронювати зустріч</h2></div></div><div class="mentor-slots"><p class="empty-inline">Завантажуємо доступний час…</p></div></section>
    </section>`;
}

function lessonPage() {
  if (!currentLesson) return `<section class="page lesson-page"><div class="page-title"><h1>Урок не знайдено</h1></div><button type="button" class="btn btn--primary btn--lg" data-tab="learn">До маршруту ${arrowIcon()}</button></section>`;
  const lesson = currentLesson;
  return `<section class="page lesson-page">
    ${backButton('lesson')}
    <div class="page-title"><span class="section-kicker">УРОК ${lesson.number} · ${escapeHtml(lesson.moduleTitle)}</span><span class="zone-code">${lesson.estimatedMinutes} ХВ · +${lesson.xpReward} XP</span><h1>${escapeHtml(lesson.title)}</h1><p>${escapeHtml(lesson.summary)}</p></div>
    <button type="button" class="btn btn--secondary btn--block" data-ai-learning="lesson" data-id="${escapeHtml(lesson.id)}" data-title="${escapeHtml(lesson.title)}">Спитати ШІ про цей урок</button>
    ${lesson.content.explanation ? `<section class="lesson-console"><span>КЛЮЧОВА ІДЕЯ</span><h2>${escapeHtml(lesson.content.conceptName)}</h2><p>${escapeHtml(lesson.content.explanation)}</p></section>` : ''}
    ${lesson.content.examples.length ? `<section class="lesson-section"><span class="section-kicker">ПРИКЛАДИ</span>${lesson.content.examples.map(example => `<article><i></i><p>${escapeHtml(example)}</p></article>`).join('')}</section>` : ''}
    ${lesson.content.task.prompt ? `<section class="lesson-task"><span class="section-kicker">ТВІЙ ХІД</span><h2>${escapeHtml(lesson.content.task.prompt)}</h2><p>${escapeHtml(lesson.content.task.hint)}</p></section>` : ''}
    ${lesson.completionReview?.feedback?`<p class="lesson-review-feedback">Коментар викладача: ${escapeHtml(lesson.completionReview.feedback)}</p>`:''}
    <section class="lesson-next"><div><span>ДАЛІ</span><p>${escapeHtml(lesson.content.nextStep)}</p></div>${lesson.state === 'completed' ? `<button type="button" class="btn btn--primary btn--lg" data-tab="learn">Повернутися до маршруту</button>` : `<button type="button" class="btn btn--primary btn--lg" id="completeLesson" data-lesson="${lesson.id}" ${lesson.completionReview?.status==='pending_review'?'disabled':''}>${lesson.completionReview?.status==='pending_review'?'Очікує підтвердження викладача':`Надіслати на підтвердження ${arrowIcon()}`}</button>`}</section>
  </section>`;
}

function arrowIcon() {
  return '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function externalIcon() {
  return '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h9v9M19 5l-9 9M18 13v6H5V6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function videoIcon() {
  return '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
}

// A function declaration, not a const: the header template calls closeIcon() before this line runs.
function uiIcon(path) { return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`; }
function backIcon() { return uiIcon('<path d="M15 6l-6 6 6 6"/>'); }
function closeIcon() { return uiIcon('<path d="M6 6l12 12M18 6 6 18"/>'); }
function trashIcon() { return uiIcon('<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.9 12.1A1.9 1.9 0 0 0 9.3 21h5.4a1.9 1.9 0 0 0 1.9-1.9L17.5 7M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7"/>'); }
function paperclipIcon() { return uiIcon('<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.4 3.4 0 0 1 4.8 4.8l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4"/>'); }
function retryIcon() { return uiIcon('<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/>'); }
function checkIcon() { return uiIcon('<path d="m5 12.5 4.5 4.5L19 7.5"/>'); }
function openFileIcon() { return uiIcon('<path d="M7 17 17 7M8.5 7H17v8.5"/>'); }

function backButton(page) {
  return `<button type="button" class="btn btn--ghost btn--sm btn--back" data-back="${page}">${backIcon()}<span>${escapeHtml(backLabel(page))}</span></button>`;
}

function artifactIcon(type) {
  const artifactPaths = {
    spark: '<path d="m13 2-8 12h6l-1 8 9-13h-6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    build: '<path d="m12 3 7.8 4.5v9L12 21l-7.8-4.5v-9zM8 12h8M12 8v8" fill="none" stroke="currentColor" stroke-width="1.7"/>',
    explore: icons.ai,
    locked: '<path d="M7 11h10v9H7zM9 11V8a3 3 0 0 1 6 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${artifactPaths[type]}</svg>`;
}

const templates = { home, learn, project, portfolio, profile, lesson: lessonPage, homework: homeworkPage, ai: aiScreenMarkup };

function escapeHtml(str) {
  const amp = String.fromCharCode(38);
  return str.replace(/[&<>'"]/g, character => ({
    '&': `${amp}amp;`,
    '<': `${amp}lt;`,
    '>': `${amp}gt;`,
    '"': `${amp}quot;`,
    "'": `${amp}#039;`
  }[character]));
}

function loadingView(label = 'Завантажуємо твій маршрут') {
  clearTimeout(renderTimer);
  errorReturnPage = null;
  view.setAttribute('aria-busy', 'true');
  view.innerHTML = `<section class="system-state"><div class="state-signal"></div><span>SYNC</span><h1>${escapeHtml(label)}</h1><p>Ще мить — з’єднуємо прогрес, проєкт і AI ментора.</p></section>`;
}

function errorView(message, title = 'Не вдалося увійти', retry = initialize, backPage = null) {
  errorReturnPage = backPage;
  view.removeAttribute('aria-busy');
  view.innerHTML = `<section class="system-state error-state">${backPage ? `<button type="button" class="btn btn--ghost btn--sm btn--back" id="errorBack">${backIcon()}<span>${escapeHtml(backLabel(backPage))}</span></button>` : ''}<div class="state-signal"></div><span>CONNECTION</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><button type="button" class="btn btn--primary btn--lg" id="retryBoot">${retryIcon()}Спробувати ще раз</button></section>`;
  document.querySelector('#retryBoot')?.addEventListener('click', retry);
  document.querySelector('#errorBack')?.addEventListener('click', () => goBack(backPage));
  updateTelegramBackButton();
}

async function refreshData() {
  data = await api.bootstrap();
  firstName = data.home.viewer.firstName;
  document.querySelector('.avatar').textContent = firstName[0]?.toUpperCase() || 'A';
  updateNotificationBell();
  document.querySelectorAll('.topbar button, .nav-item').forEach(button => { button.disabled = false; });
}

async function openLesson(id, updateHistory = true) {
  if (!data) return;
  if (lessonRequest?.id === id && navigationGuard.isCurrent(lessonRequest.token)) return lessonRequest.promise;
  if (updateHistory) rememberOrigin('lesson');
  requestedTab = 'lesson';
  const token = navigationGuard.next();
  loadingView('Відкриваємо урок');
  const request = { id, token, promise: null };
  lessonRequest = request;
  updateTelegramBackButton();
  request.promise = (async () => {
    try {
      const lesson = await api.lesson(id);
      if (!navigationGuard.isCurrent(token)) return;
      currentLesson = lesson;
      render('lesson', updateHistory);
    } catch (error) {
      if (navigationGuard.isCurrent(token)) errorView(error.message, 'Не вдалося відкрити урок', () => openLesson(id, updateHistory), 'lesson');
    } finally {
      if (lessonRequest === request) lessonRequest = null;
      updateTelegramBackButton();
    }
  })();
  return request.promise;
}

function openHomework(id, updateHistory = true) {
  if (!data) return;
  if (updateHistory) rememberOrigin('homework');
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
    else if (type === 'success' || type === 'error') tg.HapticFeedback.notificationOccurred(type);
    else tg.HapticFeedback.impactOccurred('light');
  } catch {}
}

// ---- Homework files -------------------------------------------------------------------------

function homeworkById(id) {
  return data?.homework?.find(item => item.id === id) ?? (currentHomework?.id === id ? currentHomework : null);
}

/** Applies a change to every in-memory copy of one homework (the list entry and the open page). */
function updateHomework(id, change) {
  for (const homework of new Set([data?.homework?.find(item => item.id === id), currentHomework?.id === id ? currentHomework : null])) if (homework) change(homework);
}

function homeworkQueue(id) {
  if (!homeworkUploads.has(id)) homeworkUploads.set(id, []);
  return homeworkUploads.get(id);
}

function setHomeworkNotice(id, type, text) {
  if (text) homeworkFileNotices.set(id, { type, text }); else homeworkFileNotices.delete(id);
}

/** Re-renders only the file area, so typed text, focus and scroll stay where they are. */
function refreshHomeworkFiles(id, { focus } = {}) {
  const homework = homeworkById(id);
  if (!homework || active !== 'homework' || currentHomework?.id !== id) return;
  const host = view.querySelector('#homeworkFiles');
  if (host) {
    const focusedKey = document.activeElement?.closest?.('[data-file-key]')?.dataset.fileKey;
    host.innerHTML = homeworkFilesInner(homework, Boolean(homework.withdrawn));
    const target = focus ? host.querySelector(focus) : focusedKey ? host.querySelector(`[data-file-key="${CSS.escape(focusedKey)}"] button`) : null;
    target?.focus({ preventScroll: true });
  }
  const status = view.querySelector('#homeworkFormStatus');
  if (status) status.textContent = homeworkFormStatusText(homework);
  const title = view.querySelector('.hw-header .status-pill');
  if (title) { const next = homeworkStatus(homework); title.textContent = next.label; title.dataset.tone = next.tone; }
}

function updateUploadProgress(id, item) {
  const row = view.querySelector(`#homeworkFiles [data-file-key="${CSS.escape(item.key)}"]`);
  if (!row) return;
  const percent = Math.round(item.progress * 100);
  row.querySelector('.file-state')?.replaceChildren(item.state === 'verifying' ? 'Перевіряємо файл' : `Завантаження ${percent}%`);
  const bar = row.querySelector('.file-progress');
  bar?.setAttribute('aria-valuenow', String(item.state === 'verifying' ? 100 : percent));
  bar?.querySelector('i')?.style.setProperty('width', `${item.state === 'verifying' ? 100 : percent}%`);
}

function addHomeworkFiles(id, files) {
  const homework = homeworkById(id), policy = data?.fileUploads;
  if (!homework || !policy?.enabled || homework.withdrawn || actionGate.has(`homework:submit:${id}`)) return;
  const attached = homeworkFileEntries(homework).filter(entry => entry.state !== 'error');
  const { accepted, rejected } = checkSelection(files, policy, { count: attached.length, totalBytes: attached.reduce((sum, entry) => sum + (entry.size || 0), 0) });
  setHomeworkNotice(id, 'error', rejected.length ? `Не додано: ${rejected.join('; ')}.` : '');
  const queue = homeworkQueue(id);
  for (const { file, extension } of accepted) {
    queue.push({ key: crypto.randomUUID(), file, name: file.name, extension, size: file.size, state: 'queued', progress: 0, error: '', retryable: true, serverId: null, target: null, xhr: null, cancelled: false });
  }
  refreshHomeworkFiles(id);
  if (accepted.length) pumpHomeworkUploads(id);
  else if (rejected.length) haptic('error');
}

/** Uploads one file at a time; each run is in the action gate, so background refreshes wait. */
function pumpHomeworkUploads(id) {
  const running = actionGate.run(`homework:uploads:${id}`, async () => {
    let item;
    while ((item = homeworkQueue(id).find(entry => entry.state === 'queued'))) await uploadHomeworkFile(id, item);
  });
  running.finally(() => { if (homeworkQueue(id).some(entry => entry.state === 'queued') && !actionGate.has(`homework:uploads:${id}`)) pumpHomeworkUploads(id); });
}

async function uploadHomeworkFile(id, item) {
  const show = (state, progress = item.progress) => { item.state = state; item.progress = progress; refreshHomeworkFiles(id); };
  try {
    if (!item.target || item.target.expired || Date.parse(item.target.expiresAt) - Date.now() < 60_000) {
      if (item.serverId) { const stale = item.serverId; item.serverId = null; api.discardUpload(id, stale).catch(() => {}); }
      show('uploading', 0);
      const reserved = await api.reserveUpload(id, { name: item.name, size: item.size });
      if (item.cancelled) { api.discardUpload(id, reserved.file.id).catch(() => {}); return; }
      item.serverId = reserved.file.id;
      item.target = { ...reserved.upload, expiresAt: reserved.expiresAt };
    }
    show('uploading', 0);
    await sendFile(item.target, item.file, { onStart: xhr => { item.xhr = xhr; }, onProgress: value => { item.progress = value; updateUploadProgress(id, item); } });
    item.xhr = null;
    if (item.cancelled) return;
    show('verifying', 1);
    // Only the server's confirmation turns the row into "Завантажено".
    const ready = await api.completeUpload(id, item.serverId);
    if (item.cancelled) { api.discardUpload(id, ready.id).catch(() => {}); return; }
    const queue = homeworkQueue(id);
    queue.splice(queue.indexOf(item), 1);
    updateHomework(id, homework => { homework.draftFiles = [...(homework.draftFiles ?? []).filter(file => file.id !== ready.id), ready]; });
    refreshHomeworkFiles(id);
  } catch (error) {
    item.xhr = null;
    if (item.cancelled || error.aborted) return;
    if (error.expired) item.target = { ...item.target, expired: true };
    // The server already removed a rejected or truncated upload; a retry starts from a new reservation.
    if (['FILE_CONTENT_MISMATCH', 'FILE_SIZE_MISMATCH', 'ATTACHMENT_NOT_FOUND'].includes(error.code)) { item.serverId = null; item.target = null; }
    item.error = error.message || 'Не вдалося завантажити файл.';
    item.retryable = !isFinalUploadError(error);
    show('error');
    haptic('error');
  }
}

function retryHomeworkUpload(id, key) {
  const item = homeworkQueue(id).find(entry => entry.key === key);
  if (!item || item.state !== 'error' || actionGate.has(`homework:submit:${id}`)) return;
  item.state = 'queued'; item.error = ''; item.progress = 0;
  refreshHomeworkFiles(id, { focus: `[data-file-key="${CSS.escape(key)}"] .file-remove` });
  pumpHomeworkUploads(id);
}

async function removeHomeworkFile(id, key, button) {
  if (actionGate.has(`homework:submit:${id}`)) return;
  const queue = homeworkQueue(id), local = queue.find(item => item.key === key);
  if (local) {
    local.cancelled = true;
    local.xhr?.abort();
    queue.splice(queue.indexOf(local), 1);
    if (local.serverId) api.discardUpload(id, local.serverId).catch(() => {});
    setHomeworkNotice(id, 'status', `«${local.name}» прибрано.`);
    refreshHomeworkFiles(id, { focus: '#homeworkAttach' });
    return;
  }
  const homework = homeworkById(id);
  if (!homework) return;
  if (!homework.draftFiles?.some(file => file.id === key)) {
    // A file from the returned attempt: it stays in that attempt, only the next one leaves it out.
    const file = homework.latestSubmission?.attachments?.find(item => item.id === key);
    if (!file) return;
    excludedFileIds(id).add(key);
    saveExcludedFileIds(id);
    setHomeworkNotice(id, 'status', `«${file.name}» не буде в новій спробі. У попередній спробі файл залишиться.`);
    refreshHomeworkFiles(id, { focus: '#homeworkAttach' });
    return;
  }
  await actionGate.run(`homework:file:remove:${key}`, async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await api.discardUpload(id, key);
      const name = homework.draftFiles.find(file => file.id === key)?.name ?? 'Файл';
      updateHomework(id, item => { item.draftFiles = (item.draftFiles ?? []).filter(file => file.id !== key); });
      setHomeworkNotice(id, 'status', `«${name}» видалено.`);
      refreshHomeworkFiles(id, { focus: '#homeworkAttach' });
    } catch (error) {
      setHomeworkNotice(id, 'error', `Не вдалося видалити файл. ${error.message}`);
      refreshHomeworkFiles(id);
    }
  });
}

async function openHomeworkFile(button) {
  const expires = Date.parse(button.dataset.fileExpires ?? '');
  if (Number.isFinite(expires) && expires - Date.now() < 15_000) {
    // Signed links are short-lived. Telegram opens links only from a tap, so fetch fresh links and
    // ask for one more tap instead of opening after the request.
    button.disabled = true;
    try {
      data.homework = await api.homework();
      if (currentHomework) currentHomework = data.homework.find(item => item.id === currentHomework.id) ?? currentHomework;
      if (currentHomework) setHomeworkNotice(currentHomework.id, 'status', 'Посилання на файли оновлено. Натисни «Відкрити» ще раз.');
      if (active === 'homework') render('homework', false);
    } catch (error) {
      button.disabled = false;
      if (currentHomework) { setHomeworkNotice(currentHomework.id, 'error', error.message); refreshHomeworkFiles(currentHomework.id); }
    }
    return;
  }
  let url;
  try { url = new URL(button.dataset.fileUrl ?? '', location.href); } catch { return; }
  if (url.protocol === 'https:') openExternal(url.href);
  else if (url.origin === location.origin) window.open(url.href, '_blank', 'noopener,noreferrer');
}

// One delegated listener for every file control: the file area is re-rendered often.
view.addEventListener('click', event => {
  const control = event.target.closest?.('#homeworkAttach, [data-file-open], [data-file-remove], [data-file-retry]');
  if (!control || !view.contains(control) || control.disabled) return;
  const homeworkId = control.closest('[data-homework-id]')?.dataset.homeworkId ?? currentHomework?.id;
  if (control.id === 'homeworkAttach') { view.querySelector('#homeworkFileInput')?.click(); return; }
  if (control.hasAttribute('data-file-open')) { openHomeworkFile(control); return; }
  if (control.dataset.fileRemove) { removeHomeworkFile(homeworkId, control.dataset.fileRemove, control); return; }
  if (control.dataset.fileRetry) retryHomeworkUpload(homeworkId, control.dataset.fileRetry);
});
view.addEventListener('change', event => {
  if (event.target.id !== 'homeworkFileInput') return;
  const input = event.target, files = [...input.files];
  input.value = '';
  if (files.length) addHomeworkFiles(input.closest('[data-homework-id]').dataset.homeworkId, files);
});
for (const type of ['dragenter', 'dragover']) view.addEventListener(type, event => {
  const zone = event.target.closest?.('[data-dropzone]');
  if (!zone || zone.querySelector('#homeworkAttach')?.disabled || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  zone.classList.add('is-dragover');
});
view.addEventListener('dragleave', event => { const zone = event.target.closest?.('[data-dropzone]'); if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('is-dragover'); });
view.addEventListener('drop', event => {
  const zone = event.target.closest?.('[data-dropzone]');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('is-dragover');
  if (!zone.querySelector('#homeworkAttach')?.disabled) addHomeworkFiles(zone.closest('[data-homework-id]').dataset.homeworkId, [...event.dataTransfer.files]);
});

function render(tab, updateHistory = true) {
  if (!data) return;
  const token = navigationGuard.next();
  errorReturnPage = null;
  lessonRequest = null;
  const next = templates[tab] ? tab : 'home';
  requestedTab = next;
  clearTimeout(renderTimer);
  view.classList.add('leaving');

  renderTimer = setTimeout(() => {
    if (!navigationGuard.isCurrent(token)) return;
    const drafts=active===next?[...view.querySelectorAll('#homeworkSubmit,#projectStageSubmit,#projectEditor,#createProject,#projectNoteForm')].map(form=>({formId:form.id,key:form.dataset.homeworkId??form.dataset.taskId??form.dataset.projectId??'',version:form.dataset.version??'',requestId:form.dataset.requestId,hidden:form.hidden,fields:[...form.querySelectorAll('input[name],textarea[name]')].map(field=>({name:field.name,value:field.value,focused:document.activeElement===field,start:field.selectionStart,end:field.selectionEnd}))})):[];
    if (next === 'ai' && active !== 'ai') aiOrigin = ['lesson', 'homework'].includes(active) ? detailOrigins[active]?.tab ?? 'home' : active;
    active = next;
    document.documentElement.dataset.screen = active === 'ai' ? 'ai' : '';
    view.innerHTML = templates[active]();
    view.removeAttribute('aria-busy');
    document.querySelectorAll('.nav-item').forEach(item => {
      const isActive = item.dataset.tab === navigationSection(active);
      item.classList.toggle('active', isActive);
      if (isActive) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    const scroll = returnScroll ?? 0;
    returnScroll = null;
    document.querySelector('.app-shell')?.scrollTo({ top: scroll, behavior: 'auto' });
    window.scrollTo({ top: scroll, behavior: 'auto' });
    view.classList.remove('leaving');
    wirePage();
    if (active === 'ai') mountAiScreen(view.querySelector('#aiScreen'), { api, haptic, onBack: () => goBack() });
    for(const draft of drafts){const nextForm=view.querySelector('#'+draft.formId);if(!nextForm)continue;const key=nextForm.dataset.homeworkId??nextForm.dataset.taskId??nextForm.dataset.projectId??'';if(key!==draft.key||(['projectStageSubmit','projectNoteForm'].includes(draft.formId)&&nextForm.dataset.version!==draft.version))continue;if(draft.requestId)nextForm.dataset.requestId=draft.requestId;nextForm.hidden=draft.hidden;for(const item of draft.fields){const field=nextForm.elements.namedItem(item.name);if(field){field.value=item.value;if(item.focused&&!field.disabled){field.focus();if(item.start!==null)field.setSelectionRange(item.start,item.end);}}}}

    const targetHash = active === 'lesson' && currentLesson ? `#lesson=${currentLesson.id}` : active === 'homework' && currentHomework ? `#homework=${currentHomework.id}` : `#${active}`;
    if (updateHistory && location.hash !== targetHash) history.pushState({ tab: active, ...(['lesson', 'homework'].includes(active) ? { studentDetail: active, detailOrigin: detailOrigins[active] } : {}) }, '', targetHash);
    updateTelegramBackButton();
    if (updateHistory) {
      const title = view.querySelector('h1') ?? view;
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    haptic('selection');
  }, 70);
}

function wirePage() {
  // The page knows which lesson or homework it shows; the server loads its material and checks access.
  view.querySelectorAll('[data-ai-learning]').forEach(button => { button.onclick = () => {
    aiStartLearningContext({ type: button.dataset.aiLearning, id: button.dataset.id, title: button.dataset.title });
    render('ai');
  }; });
  view.querySelectorAll('[data-back]').forEach(button => { button.onclick = () => goBack(button.dataset.back); });
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
    element.onclick = event => { event.stopPropagation(); openHomework(element.dataset.homework); };
  });
  view.querySelectorAll('[data-external]').forEach(element => {
    element.onclick = event => { event.stopPropagation(); openExternal(element.dataset.external); };
  });
  view.querySelectorAll('[data-recovery-mentor]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      runAction(button, 'mentor:book', 'Бронюємо…', () => api.bookMentor(button.dataset.recoveryMentor), () => {
        button.classList.add('booked');
        tg?.showAlert?.('Зустріч із ментором зарезервовано. Деталі з’являться у профілі.');
      }, { successText: 'Зустріч зарезервовано' });
    };
  });

  document.querySelector('#completeLesson')?.addEventListener('click', event => {
    const button = event.currentTarget, id = button.dataset.lesson;
    runAction(button, `lesson:complete:${id}`, 'Надсилаємо…', () => api.completeLesson(id, button.dataset.requestId ?? (button.dataset.requestId = crypto.randomUUID())), async () => {
      await refreshData();
      const lesson = await api.lesson(id);
      if (active === 'lesson' && currentLesson?.id === id && button.isConnected) { currentLesson = lesson; render('lesson', false); }
    }, { successText: 'Надіслано на підтвердження' });
  });

  const createForm = document.querySelector('#createProject');
  createForm?.addEventListener('submit', event => {
    event.preventDefault(); const values = new FormData(createForm), button = createForm.querySelector('button');
    runAction(button, 'project:create', 'Створюємо…', () => api.createProject({ title: values.get('title'), summary: values.get('summary') }), async () => {
      await refreshData(); if (createForm.isConnected) render('project', false);
    }, { successText: 'Проєкт створено' });
  });
  document.querySelector('#editProject')?.addEventListener('click', event => {
    const editor = document.querySelector('#projectEditor'); editor.hidden = !editor.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!editor.hidden));
    if (!editor.hidden) { editor.scrollIntoView({ block: 'center', behavior: 'auto' }); editor.querySelector('input').focus({ preventScroll: true }); }
  });
  const editor = document.querySelector('#projectEditor');
  editor?.addEventListener('submit', event => {
    event.preventDefault(); const values = new FormData(editor), button = editor.querySelector('button');
    const projectData = data.projects.find(item => item.status === 'active') ?? data.projects[0];
    runAction(button, `project:edit:${projectData.id}`, 'Зберігаємо…', () => api.updateProject(projectData.id, { title: values.get('title'), summary: values.get('summary') }), async () => {
      await refreshData(); if (editor.isConnected) { editor.hidden = true; render('project', false); }
    }, { successText: 'Зміни збережено' });
  });
  const noteForm = view.querySelector('#projectNoteForm');
  noteForm?.addEventListener('submit', event => {
    event.preventDefault(); const button = noteForm.querySelector('button'), fields = new FormData(noteForm);
    const input = { contentText: fields.get('contentText'), clientRequestId: noteForm.dataset.requestId ?? (noteForm.dataset.requestId = crypto.randomUUID()) };
    if (fields.get('contentUrl')) input.contentUrl = fields.get('contentUrl');
    runAction(button, `project:note:${noteForm.dataset.projectId}`, 'Зберігаємо…', () => api.addProjectNote(noteForm.dataset.projectId, input), async () => {
      await refreshData(); if (noteForm.isConnected) render('project', false);
    }, { successText: 'Нотатку збережено' });
  });
  const stageForm = view.querySelector('#projectStageSubmit');
  stageForm?.addEventListener('submit', event => {
    event.preventDefault(); const button = stageForm.querySelector('button'), contentText = stageForm.querySelector('textarea').value;
    runAction(button, `project:stage:${stageForm.dataset.taskId}`, 'Надсилаємо…', () => api.submitProjectTask(stageForm.dataset.projectId, stageForm.dataset.taskId, { contentText, expectedVersion: Number(stageForm.dataset.version) }), async () => {
      await refreshData(); if (stageForm.isConnected) render('project', false);
    }, { successText: 'Відповідь надіслано на перевірку' });
  });

  document.querySelector('#openCode')?.addEventListener('click', () => {
    const url = (data.projects.find(item => item.status === 'active') ?? data.projects[0])?.workspaceUrl;
    if (url) openExternal(url);
  });
  document.querySelector('[data-add-portfolio]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    runAction(button, `portfolio:add:${button.dataset.addPortfolio}`, 'Додаємо до портфоліо…', () => api.addToPortfolio(button.dataset.addPortfolio), result => {
      data.portfolio = result; if (button.isConnected) render('portfolio', false);
    }, { successText: 'Проєкт додано до портфоліо' });
  });

  const homeworkForm = view.querySelector('#homeworkSubmit');
  homeworkForm?.addEventListener('submit', event => {
    event.preventDefault();
    const homeworkId = homeworkForm.dataset.homeworkId, homework = homeworkById(homeworkId), button = homeworkForm.querySelector('.hw-submit');
    if (!homework || button.disabled) return;
    const values = new FormData(homeworkForm);
    const contentText = String(values.get('contentText') ?? '').trim(), contentUrl = String(values.get('contentUrl') ?? '').trim(), studentComment = String(values.get('studentComment') ?? '').trim();
    const entries = homeworkFileEntries(homework);
    if (entries.some(entry => ['queued', 'uploading', 'verifying'].includes(entry.state))) { showActionStatus(button, 'error', 'Дочекайся, поки всі файли завантажаться.'); return; }
    if (entries.some(entry => entry.state === 'error')) { showActionStatus(button, 'error', 'Є файл з помилкою. Повтори його завантаження або прибери зі списку.'); return; }
    if (contentUrl && !safeHttpsUrl(contentUrl)) { showActionStatus(button, 'error', 'Посилання має починатися з https://'); homeworkForm.elements.contentUrl.focus(); return; }
    const attachmentIds = entries.filter(entry => entry.state === 'ready' && entry.id).map(entry => entry.id);
    if (!contentText && !contentUrl && !attachmentIds.length) { showActionStatus(button, 'error', 'Додай відповідь, посилання або хоча б один файл.'); homeworkForm.elements.contentText.focus(); return; }
    // The same key is reused on retry, so a request that reached the server is never stored twice.
    const clientRequestId = homeworkForm.dataset.requestId ?? (homeworkForm.dataset.requestId = crypto.randomUUID());
    runAction(button, `homework:submit:${homeworkId}`, 'Надсилаємо…', () => api.submitHomework(homeworkId, { contentText, ...(contentUrl ? { contentUrl } : {}), studentComment, attachmentIds, clientRequestId }), async () => {
      haptic('success');
      excludedFileIds(homeworkId).clear(); saveExcludedFileIds(homeworkId); homeworkFileNotices.delete(homeworkId);
      data.homework = await api.homework(); data.home.homeworkDue = data.homework.find(item => item.state !== 'completed') ?? null;
      if (homeworkForm.isConnected) { currentHomework = data.homework.find(item => item.id === homeworkId) ?? currentHomework; render('homework', false); }
    }, { successText: 'Роботу надіслано' });
  });

  document.querySelector('#openNotificationsFromProfile')?.addEventListener('click', openNotifications);
  document.querySelector('#openMentorBooking')?.addEventListener('click', async event => {
    const button = event.currentTarget, panel = document.querySelector('#mentorBooking');
    if (!panel.hidden) { closeMentorBooking(); return; }
    panel.hidden = false; button.setAttribute('aria-expanded', 'true'); updateTelegramBackButton();
    const list = panel.querySelector('.mentor-slots');
    await runAction(button, 'mentor:availability', 'Шукаємо час…', () => api.mentorSlots(), slots => {
      if (!panel.isConnected || panel.hidden) return;
      list.innerHTML = slots.length ? slots.map(slot => `<button type="button" class="mentor-slot" data-mentor-slot="${slot.id}" ${slot.available ? '' : 'disabled'}><span>${escapeHtml(formatClassTime(slot.startsAt, slot.timezone))}</span><strong>${escapeHtml(slot.mentorName)}</strong><small>${escapeHtml(slot.mentorTitle)}</small><small>${slot.available ? 'Забронювати цей час' : 'Час недоступний'}</small></button>`).join('') : '<p class="empty-inline">Нові вікна з’являться незабаром.</p>';
      list.querySelectorAll('[data-mentor-slot]').forEach(slotButton => { slotButton.onclick = async () => {
        if (actionGate.has('mentor:book')) return;
        const siblings = [...list.querySelectorAll('[data-mentor-slot]')].filter(item => item !== slotButton).map(item => ({ item, disabled: item.disabled }));
        for (const { item } of siblings) item.disabled = true;
        await runAction(slotButton, 'mentor:book', 'Бронюємо…', () => api.bookMentor(slotButton.dataset.mentorSlot), () => { slotButton.classList.add('booked'); }, { successText: 'Зустріч зарезервовано' });
        for (const { item, disabled } of siblings) item.disabled = disabled;
      }; });
      panel.scrollIntoView({ block: 'nearest', behavior: 'auto' }); document.querySelector('#mentorBookingTitle')?.focus({ preventScroll: true });
    }, { keepDisabled: false, successText: 'Обери зручний час' });
  });
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-tab]');
  if (target && !target.closest('#view')) render(target.dataset.tab);
});

async function renderFromLocation() {
  if (!data) return;
  const requested = location.hash.replace('#', '');
  if (history.state?.studentDetail && history.state.detailOrigin) detailOrigins[history.state.studentDetail] = history.state.detailOrigin;
  if (requested.startsWith('lesson=')) { await openLesson(requested.slice(7), false); return; }
  if (requested.startsWith('homework=')) { openHomework(requested.slice(9), false); return; }
  const next = templates[requested] ? requested : 'home';
  if (next !== active || requestedTab !== next || !view.querySelector('.page')) render(next, false);
}

window.addEventListener('popstate', renderFromLocation);
window.addEventListener('hashchange', renderFromLocation);

/** «Відкрити чат» in a Telegram notice opens the Mini App with ?ai=<chat id>: go straight to that chat. */
function openChatFromLink() {
  const params = new URLSearchParams(location.search);
  const id = params.get('ai');
  if (!id) return;
  params.delete('ai');
  const query = params.toString();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    aiSelectConversation(id);
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}#ai`);
  } else {
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  }
}

async function initialize() {
  if (actionGate.has('initialize')) return actionGate.get('initialize');
  authError = '';
  loadingView();
  return actionGate.run('initialize', async () => {
    try {
      await api.authenticate();
      await refreshData();
      openChatFromLink();
      await renderFromLocation();
    } catch (error) { authError = error.message; errorView(authError); }
  });
}

initialize();

const canApplyAcademicSync = () => Boolean(data) && !notificationPanelOpen && !actionGate.busy && !lessonRequest && !errorReturnPage && requestedTab === active;
startAcademicSync({revision:api.revision,canApply:canApplyAcademicSync,refresh:async()=>{
  const actionVersion = actionGate.version;
  if (!canApplyAcademicSync()) throw new Error('Student controls are busy');
  const [schedule,homework,learning,home,projects,recoveries]=await Promise.all([api.schedule(),api.homework(),api.learning(),api.home(),api.projects(),api.recoveries()]);
  // Let the next poll refresh instead of applying a snapshot from before a user action.
  if (!canApplyAcademicSync() || actionGate.version !== actionVersion) throw new Error('Student controls changed during refresh');
  data.schedule=schedule;data.home.nextClass=schedule.nextClass;data.homework=homework;data.home.homeworkDue=homework.find(h=>h.state!=='completed')??null;
  data.learning=learning;data.home.course=learning.course;data.home.currentLesson=learning.modules.flatMap(module=>module.lessons).find(lesson=>lesson.state==='current'||lesson.state==='available')??null;
  data.recoveries=recoveries;data.projects=projects;data.home.currentProject=home.currentProject;data.home.projectCount=projects.length;data.profile.projectCount=projects.length;
  data.home.viewer=home.viewer;data.profile.viewer=home.viewer;firstName=home.viewer.firstName;
  if(active==='lesson'&&currentLesson){
    const lessonId=currentLesson.id;
    const visible=learning.modules.some(module=>module.lessons.some(lesson=>lesson.id===lessonId));
    const refreshed=visible?await api.lesson(lessonId):null;
    if (!canApplyAcademicSync() || actionGate.version !== actionVersion) throw new Error('Student controls changed during refresh');
    if(active==='lesson'&&currentLesson?.id===lessonId){currentLesson=refreshed;render('lesson',false);}
  }
  if(active==='home'||active==='learn'||active==='profile'||active==='project')render(active,false);
  if(active==='homework'&&currentHomework){currentHomework=homework.find(h=>h.id===currentHomework.id)??{...currentHomework,withdrawn:true};render('homework',false);}
}});
