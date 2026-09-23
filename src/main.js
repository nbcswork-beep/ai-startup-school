import { api } from './api.js';

const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor('#070a2b');
    tg.setBackgroundColor('#070a2b');
  } catch {}
}

let firstName = 'Творець';
let data = null;
let currentLesson = null;
let currentHomework = null;
let aiMessages = [];
let authError = '';
let notificationPanelOpen = false;
let notificationReturnFocus = null;

const icons = {
  home: '<path d="M4 11.2 12 4l8 7.2v8.3a.5.5 0 0 1-.5.5h-5v-5.5h-5V20h-5a.5.5 0 0 1-.5-.5z"/>',
  learn: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 5.5v15A2.5 2.5 0 0 0 7.5 23H20" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  project: '<path d="M5 19V8l7-4 7 4v11l-7 4z"/><path d="m8.5 13 2.2 2.2 4.8-5" fill="none" stroke="currentColor" stroke-width="2"/>',
  portfolio: '<path d="M5 7.5h14v12H5z"/><path d="M9 7.5V5h6v2.5M5 12h14M10 12v2h4v-2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  ai: '<path d="M12 2.7 14.1 8l5.2 2.1-5.2 2.1L12 17.5l-2.1-5.3-5.2-2.1L9.9 8z"/><path d="m18.7 16 .8 2.1 2.1.8-2.1.9-.8 2.1-.9-2.1-2.1-.9 2.1-.8z"/>',
  profile: '<path d="M12 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M4.5 22a7.5 7.5 0 0 1 15 0z"/>'
};

const nav = [
  ['home', 'Головна'],
  ['learn', 'Навчання'],
  ['project', 'Проєкт'],
  ['portfolio', 'Портфоліо'],
  ['profile', 'Профіль']
];

const svgIcon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;

function stateIcon(status) {
  if (status === 'done') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.5 12.5 3.4 3.4 7.7-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  if (status === 'current') {
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

function formatClassTime(value, timezone = 'Europe/Kyiv') {
  return new Intl.DateTimeFormat('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(value));
}

function effortLabel(value) {
  return ({ needs_attention: 'Потрібно більше уваги', good_effort: 'Старався', high_effort: 'Дуже старався' })[value] ?? '';
}

function homeworkStateLabel(value) {
  return ({ not_started: 'НОВЕ', in_progress: 'В РОБОТІ', submitted: 'НАДІСЛАНО', needs_revision: 'ПОТРІБНЕ ДОПРАЦЮВАННЯ', completed: 'ГОТОВО' })[value] ?? value;
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
        <button class="icon-btn notification" id="notificationBell" type="button" aria-label="Сповіщення" aria-controls="studentNotifications" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><i class="notification-dot" hidden></i>
        </button>
        <button class="avatar" data-tab="profile" aria-label="Відкрити профіль">${firstName[0]?.toUpperCase() || 'M'}</button>
      </div>
    </header>
    <main id="view" class="view"></main>
    <nav class="bottom-nav" aria-label="Головна навігація">
      ${nav.map(([id, label]) => `<button class="nav-item" data-tab="${id}"><span class="nav-icon">${svgIcon(id)}</span><span class="nav-label">${label}</span></button>`).join('')}
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
const notificationDot = notificationBell.querySelector('.notification-dot');
const notificationBackdrop = document.querySelector('#notificationBackdrop');
const notificationPanel = document.querySelector('#studentNotifications');
const notificationList = document.querySelector('#notificationList');
const notificationCount = document.querySelector('#notificationCount');
const markAllNotifications = document.querySelector('#markAllNotifications');
let active = 'home';
let renderTimer;

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
  notificationCount.textContent = `${notifications.unreadCount} непрочитаних`;
  markAllNotifications.disabled = notifications.unreadCount < 1;
  notificationList.innerHTML = notifications.items.length ? notifications.items.map(item => {
    const destination = item.destination?.homeworkId ? ` data-homework="${escapeHtml(item.destination.homeworkId)}"` : item.destination?.tab ? ` data-notification-tab="${escapeHtml(item.destination.tab)}"` : '';
    return `<button class="notification-item${item.readAt ? '' : ' unread'}" type="button" data-notification-id="${escapeHtml(item.id)}"${destination}${item.destination ? '' : ' disabled'}>
      <span class="notification-type">${notificationTypeIcon(item.type)}</span>
      <span class="notification-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small><time datetime="${escapeHtml(item.occurredAt)}">${escapeHtml(formatNotificationTime(item.occurredAt))}</time></span>
      ${item.readAt ? '' : '<i class="notification-unread" aria-label="Непрочитане"></i>'}
    </button>`;
  }).join('') : '<div class="notification-empty"><span aria-hidden="true">✓</span><strong>Нових сповіщень немає</strong></div>';

  notificationList.querySelectorAll('[data-notification-id]').forEach(item => item.addEventListener('click', async () => {
    const id = item.dataset.notificationId;
    if (!item.classList.contains('unread')) return navigateFromNotification(item);
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

function home() {
  const homeData = data.home;
  const lesson = homeData.currentLesson;
  const projectData = homeData.currentProject;
  const progress = homeData.course.progressPercent;
  const nextClass = homeData.nextClass ?? data.schedule?.nextClass;
  const joinUrl = safeHttpsUrl(nextClass?.meetingUrl);
  return `
    <section class="page home-page">
      <div class="eyebrow">ДОБРОГО ДНЯ, ${firstName.toUpperCase()} <span></span></div>
      <section class="home-hero">
        <div class="hero-copy">
          <span class="coordinate">ТВІЙ ШЛЯХ · ${String(homeData.course.completedLessons + 1).padStart(2, '0')}/${String(homeData.course.totalLessons).padStart(2, '0')}</span>
          <h1>Твоя ідея<br><em>стає проєктом.</em></h1>
          <p>Крок за кроком: від першої думки до продукту, який працює.</p>
          <button class="primary-btn" data-tab="learn">Продовжити навчання ${arrowIcon()}</button>
        </div>
        <div class="hero-engine-wrap">${portalMarkup('large')}</div>
        <div class="hero-progress" aria-label="Прогрес курсу ${progress} відсотків"><span>КУРС</span><strong>${progress}%</strong><i><b style="width:${progress}%"></b></i></div>
      </section>

      ${nextClass ? `<section class="next-class-zone">
        <div class="class-signal"><span>LIVE</span><i></i></div>
        <div class="class-copy"><span>НАСТУПНЕ ЖИВЕ ЗАНЯТТЯ</span><h2>${escapeHtml(nextClass.title)}</h2><p>${escapeHtml(formatClassTime(nextClass.startsAt, data.schedule.timezone))} · ${nextClass.durationMinutes} хв · ${escapeHtml(nextClass.teacherName)}</p></div>
        ${joinUrl ? `<button class="class-join" data-external="${escapeHtml(joinUrl)}">Приєднатися до заняття ${externalIcon()}</button>` : '<span class="class-link-pending">Посилання з’явиться перед заняттям</span>'}
      </section>` : ''}

      <section class="next-step" ${lesson ? `data-lesson="${lesson.id}"` : 'data-tab="learn"'}>
        <div class="step-index"><small>УРОК</small><strong>${lesson?.number ?? '—'}</strong></div>
        <div class="step-copy"><span>НАСТУПНИЙ КРОК</span><h2>${escapeHtml(lesson?.title ?? 'Маршрут завершено')}</h2><p>${escapeHtml(lesson?.summary ?? 'Переглянь свої досягнення та обери наступну ціль.')}</p></div>
        <button class="round-arrow" aria-label="Відкрити урок">${arrowIcon()}</button>
      </section>

      ${homeData.homeworkDue ? `<button class="homework-pulse" data-homework="${homeData.homeworkDue.id}"><span>HOMEWORK · ${homeworkStateLabel(homeData.homeworkDue.state)}</span><strong>${escapeHtml(homeData.homeworkDue.title)}</strong><small>${homeData.homeworkDue.dueAt ? `До ${escapeHtml(formatClassTime(homeData.homeworkDue.dueAt, data.schedule.timezone))}` : 'Без дедлайну'}</small>${arrowIcon()}</button>` : ''}

      <div class="signal-strip" aria-label="Твоя статистика">
        <div><span class="signal-mark bolt">ϟ</span><strong>${homeData.viewer.streak}</strong><small>дні поспіль</small></div>
        <div><span class="signal-mark">${String(homeData.projectCount).padStart(2, '0')}</span><strong>${homeData.projectCount}</strong><small>проєкти</small></div>
        <div><span class="signal-mark">XP</span><strong>${homeData.viewer.xp}</strong><small>досвід</small></div>
      </div>

      <div class="section-head"><div><span class="section-kicker">STARTUP LAB</span><h2>Ти зараз будуєш</h2></div><button class="text-link" data-tab="project">До проєкту ${arrowIcon()}</button></div>
      <section class="project-preview" data-tab="project">
        <div class="preview-rail">${Array.from({ length: projectData?.stage.total ?? 5 }, (_, index) => `<i class="${index < (projectData?.stage.position ?? 0) ? 'done' : ''}"></i>`).join('')}</div>
        <div class="preview-copy"><span>MVP · ЕТАП ${projectData?.stage.position ?? 0} З ${projectData?.stage.total ?? 5}</span><h3>${escapeHtml(projectData?.title ?? 'Створи перший проєкт')}</h3><p>${escapeHtml(projectData?.tasks.find(task => task.status === 'in_progress')?.title ?? 'Сформулюй свою ідею')}</p></div>
        <div class="preview-progress"><strong>${projectData?.completionPercent ?? 0}%</strong><span>створено</span></div>
      </section>
    </section>`;
}

function learn() {
  const learning = data.learning;
  const module = learning.modules[0];
  const lessonRows = module?.lessons ?? [];
  const weekClasses = data.schedule?.thisWeek ?? [];
  const homework = data.homework ?? [];
  const recoveries = data.recoveries ?? [];
  return `
    <section class="page learn-page">
      <div class="page-title"><span class="section-kicker">ТВІЙ МАРШРУТ</span><span class="zone-code">ZONE 02 · ROUTE</span><h1>Навчання</h1><p>Живі заняття, практика й робота над власним проєктом.</p></div>
      <section class="week-route">
        <div class="section-head compact-head"><div><span class="section-kicker">ЦЬОГО ТИЖНЯ</span><h2>Живі заняття</h2></div><span class="tiny-badge">${weekClasses.length} LIVE</span></div>
        ${weekClasses.length ? weekClasses.map(item => `<article class="schedule-row"><span class="schedule-date">${escapeHtml(new Intl.DateTimeFormat('uk-UA',{weekday:'short',day:'2-digit',timeZone:data.schedule.timezone}).format(new Date(item.startsAt)).toUpperCase())}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(formatClassTime(item.startsAt,data.schedule.timezone))} · ${item.durationMinutes} хв</small></div><i class="${item.status}"></i></article>`).join('') : '<p class="empty-inline">На цей тиждень занять немає.</p>'}
      </section>
      ${recoveries.length ? `<section class="recovery-route">
        <div class="section-head compact-head"><div><span class="section-kicker">НАЗДОГНАТИ ПРОПУЩЕНЕ</span><h2>Матеріали після заняття</h2></div><span class="tiny-badge">${recoveries.length} ДОСТУПНО</span></div>
        ${recoveries.map(item => `<article class="recovery-card ${item.status}">
          <div class="recovery-card-head"><span>ПРОПУЩЕНЕ ЗАНЯТТЯ</span><small>${escapeHtml(formatClassTime(item.startsAt,data.schedule.timezone))}</small></div>
          <h3>${escapeHtml(item.lessonTitle || item.title)}</h3><p>${escapeHtml(item.description)}</p>
          ${item.materials.length ? `<div class="recovery-materials">${item.materials.map(material => material.url ? `<button data-external="${escapeHtml(material.url)}">${escapeHtml(material.title)} ${externalIcon()}</button>` : `<span>${escapeHtml(material.title)}</span>`).join('')}</div>` : '<small class="recovery-empty">Матеріали ще готує викладач.</small>'}
          ${item.homework ? `<div class="recovery-task"><span>ЩО ЗРОБИТИ САМОСТІЙНО</span><strong>${escapeHtml(item.homework.title)}</strong><p>${escapeHtml(item.homework.instructions)}</p></div>` : ''}
          <div class="recovery-actions">${item.homework ? `<button class="recovery-homework" data-homework="${item.homework.id}">Відкрити домашнє завдання ${arrowIcon()}</button>` : ''}${item.mentorSlotId ? `<button class="recovery-mentor" data-recovery-mentor="${item.mentorSlotId}">Записатися до ментора</button>` : ''}</div>
        </article>`).join('')}
      </section>` : ''}
      <section class="module-overview">
        <div class="module-number">01</div>
        <div><span>ПОТОЧНИЙ МОДУЛЬ</span><h2>${escapeHtml(module?.title ?? learning.course.title)}</h2><p>${escapeHtml(module?.description ?? learning.course.description)}</p></div>
        <div class="module-progress"><strong>${learning.course.progressPercent}%</strong><span><i style="height:${learning.course.progressPercent}%"></i></span></div>
      </section>
      <div class="journey-label"><span>ТВОЯ ТРАЄКТОРІЯ</span><b>${learning.course.completedLessons} / ${learning.course.totalLessons} уроків</b></div>
      <div class="lesson-journey">
        ${lessonRows.map(lesson => {
          const visualState = lesson.state === 'completed' ? 'done' : lesson.state === 'current' || lesson.state === 'available' ? 'current' : 'locked';
          return `
          <button class="lesson-node ${visualState}" ${visualState === 'locked' ? 'aria-disabled="true"' : `data-lesson="${lesson.id}"`}>
            <span class="lesson-marker">${stateIcon(visualState)}</span>
            <span class="lesson-copy"><small>${lesson.number} · ${visualState === 'current' ? 'ЗАРАЗ' : visualState === 'done' ? 'ПРОЙДЕНО' : 'ЗАБЛОКОВАНО'}</small><strong>${escapeHtml(lesson.title)}</strong>${visualState === 'current' ? `<em>Продовжити урок · +${lesson.xpReward} XP</em>` : ''}</span>
            <span class="lesson-action">${visualState === 'current' ? arrowIcon() : visualState === 'done' ? '+XP' : ''}</span>
          </button>`}).join('')}
      </div>
      <section class="homework-route">
        <div class="section-head compact-head"><div><span class="section-kicker">ПІСЛЯ ЗАНЯТТЯ</span><h2>Домашня практика</h2></div><span class="tiny-badge">${homework.filter(item=>item.state!=='completed').length} АКТИВНІ</span></div>
        ${homework.map(item => `<button class="homework-row ${item.state}" data-homework="${item.id}"><span class="homework-status">${homeworkStateLabel(item.state)}</span><strong>${escapeHtml(item.title)}</strong><small>${item.latestSubmission?.review ? `${item.latestSubmission.review.score}/10 · ${effortLabel(item.latestSubmission.review.effort)}` : item.dueAt ? `До ${formatClassTime(item.dueAt,data.schedule.timezone)}` : 'Без дедлайну'}</small>${arrowIcon()}</button>`).join('')}
      </section>
      <section class="mentor-dock">
        ${portalMarkup('mini')}
        <div><span>ДОПОМОГА МЕНТОРА</span><strong>Потрібна підтримка?</strong><p>Забронюй коротку зустріч 1:1.</p></div>
        <button data-tab="profile" aria-label="Відкрити допомогу ментора">${arrowIcon()}</button>
      </section>
    </section>`;
}

function project() {
  const projectData = data.projects.find(item => item.status === 'active') ?? data.projects[0];
  if (!projectData) return projectEmpty();
  const tasks = projectData.tasks;
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
      <div class="section-head"><div><span class="section-kicker">СПРИНТ 01</span><h2>Збираємо основу</h2></div><button class="tiny-badge" id="editProject">РЕДАГУВАТИ</button></div>
      <div class="build-path">
        ${tasks.map(task => {
          const status = task.status === 'completed' ? 'done' : task.status === 'in_progress' || task.status === 'available' ? 'current' : 'locked';
          return `
          <article class="build-step ${status}" ${status === 'current' ? `data-task="${task.id}" data-project="${projectData.id}"` : ''}>
            <span class="build-marker">${status === 'done' ? stateIcon('done') : task.number}</span>
            <div><strong>${escapeHtml(task.title)}</strong><small>${status === 'done' ? 'Готово' : status === 'current' ? `Твій крок · +${task.xpReward} XP` : 'Далі'}</small></div>
            <span class="build-reward">${status === 'done' ? `+${task.xpReward} XP` : status === 'current' ? arrowIcon() : stateIcon('locked')}</span>
          </article>`}).join('')}
      </div>
      <section class="workspace-dock">
        <div class="workspace-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4M14 5l-4 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><span>CODE WORKSPACE</span><h3>Продовжити збірку</h3><p>Повна web-версія з кодом і preview.</p></div>
        <button class="primary-btn compact" id="openCode" ${projectData.workspaceUrl ? '' : 'disabled'}>Відкрити ${externalIcon()}</button>
      </section>
      <form class="project-editor" id="projectEditor" hidden><label>Назва<input name="title" value="${escapeHtml(projectData.title)}" maxlength="120" required></label><label>Короткий опис<textarea name="summary" maxlength="1000">${escapeHtml(projectData.summary)}</textarea></label><button class="primary-btn compact">Зберегти</button></form>
    </section>`;
}

function projectEmpty() {
  return `<section class="page project-page"><div class="page-title"><span class="section-kicker">STARTUP LAB</span><span class="zone-code">ZONE 03 · LAB</span><h1>Мій проєкт</h1><p>Тут ідея перетворюється на продукт.</p></div><section class="project-empty">${portalMarkup('medium lab-engine','01','START')}<h2>Запусти перший проєкт</h2><p>Опиши одну проблему та ідею рішення. Маршрут з’явиться автоматично.</p><form id="createProject"><label>Назва<input name="title" maxlength="120" required></label><label>Короткий опис<textarea name="summary" maxlength="1000"></textarea></label><button class="primary-btn">Створити проєкт ${arrowIcon()}</button></form></section></section>`;
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
      ${activeProject && !alreadyAdded ? `<button class="primary-btn portfolio-add" data-add-portfolio="${activeProject.id}">Додати ${escapeHtml(activeProject.title)} ${arrowIcon()}</button>` : ''}
      <div class="section-head"><div><span class="section-kicker">НАВИЧКИ</span><h2>Що вже вмієш</h2></div></div>
      <div class="skill-field">${(portfolioData?.skills ?? []).map(item=>`<article><span>LV ${item.level}</span><strong>${escapeHtml(item.title)}</strong><i><b style="width:${item.level*20}%"></b></i></article>`).join('')}</div>
    </section>`;
}

function homeworkPage() {
  const homework = currentHomework ?? data.homework?.[0];
  if (!homework) return `<section class="page homework-page"><button class="lesson-back" data-tab="learn">← Навчання</button><div class="page-title"><h1>Домашніх завдань поки немає</h1></div></section>`;
  const submission = homework.latestSubmission;
  const review = submission?.review;
  const canSubmit = !submission || submission.status === 'needs_revision' || submission.status === 'in_progress';
  return `<section class="page homework-page">
    <button class="lesson-back" data-tab="learn">← Навчання</button>
    <div class="page-title"><span class="section-kicker">HOMEWORK · ${homeworkStateLabel(homework.state)}</span><span class="zone-code">+${homework.xpReward} XP ЗА ЗАВЕРШЕННЯ</span><h1>${escapeHtml(homework.title)}</h1><p>${escapeHtml(homework.instructions)}</p></div>
    <section class="homework-brief"><div><span>ДЕДЛАЙН</span><strong>${homework.dueAt ? escapeHtml(formatClassTime(homework.dueAt,data.schedule.timezone)) : 'Без дедлайну'}</strong></div><div><span>ПОВ’ЯЗАНЕ ЗАНЯТТЯ</span><strong>${escapeHtml(homework.classTitle ?? 'Самостійна практика')}</strong></div></section>
    ${review ? `<section class="teacher-feedback ${review.status}"><div class="feedback-score"><strong>${review.score}</strong><small>/10</small></div><div><span>ВІДГУК ВИКЛАДАЧА</span><h2>${escapeHtml(effortLabel(review.effort))}</h2><p>${escapeHtml(review.feedback)}</p></div></section>` : ''}
    ${submission ? `<section class="attempt-history"><span>СПРОБА ${submission.attemptNumber}</span><strong>${homeworkStateLabel(submission.status)}</strong><p>${escapeHtml(submission.studentComment || submission.contentText)}</p></section>` : ''}
    ${canSubmit ? `<form class="homework-submit" id="homeworkSubmit" data-homework-id="${homework.id}"><span class="section-kicker">${submission?.status==='needs_revision'?'ДОПРАЦЮЙ І НАДІШЛИ ЩЕ РАЗ':'ТВОЯ РОБОТА'}</span><label>Результат<textarea name="contentText" maxlength="20000" required placeholder="Опиши, що зробив…"></textarea></label><label>Посилання HTTPS — за потреби<input name="contentUrl" type="url" inputmode="url" placeholder="https://…"></label><label>Коментар викладачу<textarea name="studentComment" maxlength="2000" placeholder="Що було складно або цікаво?"></textarea></label><button class="primary-btn">Надіслати роботу ${arrowIcon()}</button></form>` : '<p class="submission-confirmation">Роботу надіслано. Історія спроб збережена.</p>'}
  </section>`;
}

function ai() {
  const conversation = data.conversations[0];
  const projectData = data.projects.find(item => item.status === 'active');
  const lessonData = data.home.currentLesson;
  return `
    <section class="page ai-page">
      <header class="ai-header">
        <div class="ai-engine">${portalMarkup('small')}</div>
        <div><span class="section-kicker">AI CORE · ONLINE</span><h1>Питай. Думай.<br><em>Створюй.</em></h1></div>
      </header>
      <p class="ai-intro">Ментор уже знає твій урок і етап проєкту. Обери напрям або напиши своє питання.</p>
      <div class="suggestions">
        <button data-prompt="Допоможи мені перевірити мою ідею"><span>01</span>Перевірити ідею</button>
        <button data-prompt="Поясни тему простіше"><span>02</span>Пояснити тему</button>
        <button data-prompt="Підкажи, що робити далі з проєктом"><span>03</span>Наступний крок</button>
      </div>
      <div class="chat" id="chat" aria-live="polite">
        ${aiMessages.map(message => `<div class="message ${message.role === 'assistant' ? 'ai-msg' : 'user-msg'}">${message.role === 'assistant' ? `<div class="msg-avatar">${svgIcon('ai')}</div>` : ''}<p>${escapeHtml(message.content)}</p></div>`).join('')}
        <div class="ai-context" aria-label="Контекст AI ментора синхронізовано"><span>КОНТЕКСТ ПІДКЛЮЧЕНО</span><div><b>УРОК ${lessonData?.number ?? '—'}</b><i></i><em></em><i></i><b>MVP ${projectData?.completionPercent ?? 0}%</b></div><small>Ментор бачить твій поточний маршрут</small></div>
      </div>
      <form class="composer" id="composer" data-conversation="${conversation?.id ?? ''}">
        <button type="button" class="attach" aria-label="Додати файл">+</button>
        <input id="aiInput" autocomplete="off" aria-label="Повідомлення AI ментору" placeholder="Запитай про урок або проєкт…">
        <button class="send" aria-label="Надіслати">${arrowIcon()}</button>
      </form>
      <p class="ai-note">AI допомагає думати, але не робить проєкт замість тебе.</p>
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
        <button><span class="link-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span><span><strong>Сповіщення</strong><small>Уроки та дедлайни</small></span>${arrowIcon()}</button>
        <button id="openMentorBooking"><span class="link-icon">1:1</span><span><strong>Допомога ментора</strong><small>${escapeHtml(profileData.mentor?.displayName ?? 'Обери зручний час')}</small></span>${arrowIcon()}</button>
      </div>
      <section class="mentor-booking" id="mentorBooking" hidden><div class="section-head compact-head"><div><span class="section-kicker">MENTOR 1:1</span><h2>Забронювати зустріч</h2></div></div><div class="mentor-slots"><p class="empty-inline">Завантажуємо доступний час…</p></div></section>
    </section>`;
}

function lessonPage() {
  if (!currentLesson) return `<section class="page lesson-page"><div class="page-title"><h1>Урок не знайдено</h1></div><button class="primary-btn" data-tab="learn">До маршруту</button></section>`;
  const lesson = currentLesson;
  return `<section class="page lesson-page">
    <button class="lesson-back" data-tab="learn">← Маршрут</button>
    <div class="page-title"><span class="section-kicker">УРОК ${lesson.number} · ${escapeHtml(lesson.moduleTitle)}</span><span class="zone-code">${lesson.estimatedMinutes} ХВ · +${lesson.xpReward} XP</span><h1>${escapeHtml(lesson.title)}</h1><p>${escapeHtml(lesson.summary)}</p></div>
    <section class="lesson-console"><span>КЛЮЧОВА ІДЕЯ</span><h2>${escapeHtml(lesson.content.conceptName)}</h2><p>${escapeHtml(lesson.content.explanation)}</p></section>
    <section class="lesson-section"><span class="section-kicker">ПРИКЛАДИ</span>${lesson.content.examples.map(example => `<article><i></i><p>${escapeHtml(example)}</p></article>`).join('')}</section>
    <section class="lesson-task"><span class="section-kicker">ТВІЙ ХІД</span><h2>${escapeHtml(lesson.content.task.prompt)}</h2><p>${escapeHtml(lesson.content.task.hint)}</p></section>
    <section class="lesson-next"><div><span>ДАЛІ</span><p>${escapeHtml(lesson.content.nextStep)}</p></div>${lesson.state === 'completed' ? `<button class="primary-btn" data-tab="learn">Повернутися</button>` : `<button class="primary-btn" id="completeLesson" data-lesson="${lesson.id}">Завершити · +${lesson.xpReward} XP ${arrowIcon()}</button>`}</section>
  </section>`;
}

function arrowIcon() {
  return '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function externalIcon() {
  return '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h9v9M19 5l-9 9M18 13v6H5V6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

const templates = { home, learn, project, portfolio, profile, lesson: lessonPage, homework: homeworkPage, ai };

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
  view.innerHTML = `<section class="system-state"><div class="state-signal"></div><span>SYNC</span><h1>${escapeHtml(label)}</h1><p>Ще мить — з’єднуємо прогрес, проєкт і AI ментора.</p></section>`;
}

function errorView(message) {
  view.innerHTML = `<section class="system-state error-state"><div class="state-signal"></div><span>CONNECTION</span><h1>Не вдалося увійти</h1><p>${escapeHtml(message)}</p><button class="primary-btn" id="retryBoot">Спробувати ще раз</button></section>`;
  document.querySelector('#retryBoot')?.addEventListener('click', initialize);
}

async function refreshData() {
  data = await api.bootstrap();
  firstName = data.home.viewer.firstName;
  document.querySelector('.avatar').textContent = firstName[0]?.toUpperCase() || 'A';
  updateNotificationBell();
}

async function openLesson(id, updateHistory = true) {
  loadingView('Відкриваємо урок');
  try {
    currentLesson = await api.lesson(id);
    render('lesson', updateHistory);
  } catch (error) {
    errorView(error.message);
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
  const next = templates[tab] ? tab : 'home';
  clearTimeout(renderTimer);
  view.classList.add('leaving');

  renderTimer = setTimeout(() => {
    active = next;
    view.innerHTML = templates[active]();
    document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.tab === active));
    document.querySelector('.app-shell')?.scrollTo({ top: 0, behavior: 'auto' });
    view.classList.remove('leaving');
    wirePage();

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
    element.onclick = event => { event.stopPropagation(); openHomework(element.dataset.homework); };
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
    try { await api.completeLesson(button.dataset.lesson, crypto.randomUUID()); await refreshData(); currentLesson = await api.lesson(button.dataset.lesson); render('lesson', false); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });

  const form = document.querySelector('#composer');
  if (form) {
    const input = document.querySelector('#aiInput');
    const chat = document.querySelector('#chat');
    const submit = async text => {
      if (!text?.trim()) return;
      chat.querySelector('.ai-context')?.remove();
      chat.insertAdjacentHTML('beforeend', `<div class="message user-msg"><p>${escapeHtml(text.trim())}</p></div>`);
      input.value = '';
      chat.scrollTop = chat.scrollHeight;
      input.disabled = true;
      try {
        const result = await api.sendMessage(form.dataset.conversation, text.trim(), crypto.randomUUID());
        aiMessages.push(result.userMessage, result.assistantMessage);
        if (!document.body.contains(chat)) return;
        chat.insertAdjacentHTML('beforeend', `<div class="message ai-msg"><div class="msg-avatar">${svgIcon('ai')}</div><p>${escapeHtml(result.assistantMessage.content)}</p></div>`);
        chat.scrollTop = chat.scrollHeight;
      } catch (error) {
        chat.insertAdjacentHTML('beforeend', `<div class="message ai-msg error-message"><p>${escapeHtml(error.message)}</p></div>`);
      } finally { input.disabled = false; input.focus(); }
    };
    form.onsubmit = event => {
      event.preventDefault();
      submit(input.value);
    };
    document.querySelectorAll('[data-prompt]').forEach(button => {
      button.onclick = () => submit(button.dataset.prompt);
    });
  }

  const createForm = document.querySelector('#createProject');
  createForm?.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(createForm); const button = createForm.querySelector('button'); button.disabled = true;
    try { await api.createProject({ title: values.get('title'), summary: values.get('summary') }); await refreshData(); render('project', false); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });
  document.querySelector('#editProject')?.addEventListener('click', () => { document.querySelector('#projectEditor').hidden = false; });
  const editor = document.querySelector('#projectEditor');
  editor?.addEventListener('submit', async event => {
    event.preventDefault(); const values = new FormData(editor); const projectData = data.projects.find(item => item.status === 'active') ?? data.projects[0];
    try { await api.updateProject(projectData.id, { title: values.get('title'), summary: values.get('summary') }); await refreshData(); render('project', false); }
    catch (error) { editor.querySelector('button').textContent = error.message; }
  });
  view.querySelectorAll('[data-task]').forEach(element => element.onclick = async () => {
    element.style.pointerEvents = 'none';
    try { await api.completeTask(element.dataset.project, element.dataset.task, crypto.randomUUID()); await refreshData(); render('project', false); }
    catch (error) { element.style.pointerEvents = ''; element.querySelector('small').textContent = error.message; }
  });

  document.querySelector('#openCode')?.addEventListener('click', () => {
    const url = (data.projects.find(item => item.status === 'active') ?? data.projects[0])?.workspaceUrl;
    if (!url) return;
    openExternal(url);
  });

  document.querySelector('[data-add-portfolio]')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Додаємо до колекції…';
    try { data.portfolio = await api.addToPortfolio(button.dataset.addPortfolio); render('portfolio', false); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  });

  const homeworkForm = document.querySelector('#homeworkSubmit');
  homeworkForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(homeworkForm);
    const contentUrl = String(values.get('contentUrl') ?? '').trim();
    const button = homeworkForm.querySelector('button'); button.disabled = true; button.textContent = 'Надсилаємо…';
    try {
      await api.submitHomework(homeworkForm.dataset.homeworkId, { contentText: String(values.get('contentText') ?? ''), ...(contentUrl ? { contentUrl } : {}), studentComment: String(values.get('studentComment') ?? '') });
      data.homework = await api.homework(); currentHomework = data.homework.find(item=>item.id===homeworkForm.dataset.homeworkId); data.home.homeworkDue = data.homework.find(item=>item.state!=='completed') ?? null; render('homework', false);
    } catch (error) { button.disabled = false; button.textContent = error.message; }
  });

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
    if (!data.conversations.length) data.conversations.push(await api.createConversation('Мій маршрут'));
    aiMessages = await api.messages(data.conversations[0].id);
    await renderFromLocation();
  } catch (error) {
    authError = error.message;
    errorView(authError);
  }
}

initialize();
