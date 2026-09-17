const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor('#070a2b');
    tg.setBackgroundColor('#070a2b');
  } catch {}
}

const user = tg?.initDataUnsafe?.user;
const firstName = user?.first_name || 'Максим';
const WORKSPACE_URL = 'https://ai-startup.school/workspace';

const icons = {
  home: '<path d="M4 11.2 12 4l8 7.2v8.3a.5.5 0 0 1-.5.5h-5v-5.5h-5V20h-5a.5.5 0 0 1-.5-.5z"/>',
  learn: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H20v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 5.5v15A2.5 2.5 0 0 0 7.5 23H20" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  project: '<path d="M5 19V8l7-4 7 4v11l-7 4z"/><path d="m8.5 13 2.2 2.2 4.8-5" fill="none" stroke="currentColor" stroke-width="2"/>',
  ai: '<path d="M12 2.7 14.1 8l5.2 2.1-5.2 2.1L12 17.5l-2.1-5.3-5.2-2.1L9.9 8z"/><path d="m18.7 16 .8 2.1 2.1.8-2.1.9-.8 2.1-.9-2.1-2.1-.9 2.1-.8z"/>',
  profile: '<path d="M12 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M4.5 22a7.5 7.5 0 0 1 15 0z"/>'
};

const nav = [
  ['home', 'Головна'],
  ['learn', 'Навчання'],
  ['project', 'Проєкт'],
  ['ai', 'AI'],
  ['profile', 'Профіль']
];

const lessons = [
  { n: '01', title: 'AI — не магія', meta: 'Пройдено', status: 'done' },
  { n: '02', title: 'Як говорити з AI', meta: 'Пройдено', status: 'done' },
  { n: '03', title: 'AI може помилятися', meta: 'Сьогодні · 17 хв', status: 'current' },
  { n: '04', title: 'Проблема → ідея', meta: 'Відкриється завтра', status: 'locked' },
  { n: '05', title: 'Перший MVP', meta: 'Наступний тиждень', status: 'locked' }
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
        <button class="icon-btn notification" aria-label="Сповіщення">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><i></i>
        </button>
        <button class="avatar" data-tab="profile" aria-label="Відкрити профіль">${firstName[0]?.toUpperCase() || 'M'}</button>
      </div>
    </header>
    <main id="view" class="view"></main>
    <nav class="bottom-nav" aria-label="Головна навігація">
      ${nav.map(([id, label]) => `<button class="nav-item" data-tab="${id}"><span class="nav-icon">${svgIcon(id)}</span><span class="nav-label">${label}</span></button>`).join('')}
    </nav>
  </div>`;

const view = document.querySelector('#view');
let active = 'home';
let renderTimer;

function home() {
  return `
    <section class="page home-page">
      <div class="eyebrow">ДОБРОГО ДНЯ, ${firstName.toUpperCase()} <span></span></div>
      <section class="home-hero">
        <div class="hero-copy">
          <span class="coordinate">ТВІЙ ШЛЯХ · 03/08</span>
          <h1>Твоя ідея<br><em>стає проєктом.</em></h1>
          <p>Крок за кроком: від першої думки до продукту, який працює.</p>
          <button class="primary-btn" data-tab="learn">Продовжити навчання ${arrowIcon()}</button>
        </div>
        <div class="hero-engine-wrap">${portalMarkup('large')}</div>
        <div class="hero-progress" aria-label="Прогрес курсу 42 відсотки"><span>КУРС</span><strong>42%</strong><i><b style="width:42%"></b></i></div>
      </section>

      <section class="next-step" data-tab="learn">
        <div class="step-index"><small>УРОК</small><strong>03</strong></div>
        <div class="step-copy"><span>НАСТУПНИЙ КРОК</span><h2>AI може помилятися</h2><p>Навчись перевіряти відповіді, а не довіряти впевненому тону.</p></div>
        <button class="round-arrow" data-tab="learn" aria-label="Відкрити урок">${arrowIcon()}</button>
      </section>

      <div class="signal-strip" aria-label="Твоя статистика">
        <div><span class="signal-mark bolt">ϟ</span><strong>4</strong><small>дні поспіль</small></div>
        <div><span class="signal-mark">02</span><strong>2</strong><small>проєкти</small></div>
        <div><span class="signal-mark">XP</span><strong>640</strong><small>досвід</small></div>
      </div>

      <div class="section-head"><div><span class="section-kicker">STARTUP LAB</span><h2>Ти зараз будуєш</h2></div><button class="text-link" data-tab="project">До проєкту ${arrowIcon()}</button></div>
      <section class="project-preview" data-tab="project">
        <div class="preview-rail"><i class="done"></i><i class="done"></i><i class="done"></i><i></i><i></i></div>
        <div class="preview-copy"><span>MVP · ЕТАП 3 З 5</span><h3>Smart Study Planner</h3><p>Зібрати перший прототип</p></div>
        <div class="preview-progress"><strong>62%</strong><span>створено</span></div>
      </section>
    </section>`;
}

function learn() {
  return `
    <section class="page learn-page">
      <div class="page-title"><span class="section-kicker">ТВІЙ МАРШРУТ</span><span class="zone-code">ZONE 02 · ROUTE</span><h1>Навчання</h1><p>Кожен урок рухає твій проєкт уперед.</p></div>
      <section class="module-overview">
        <div class="module-number">01</div>
        <div><span>ПОТОЧНИЙ МОДУЛЬ</span><h2>AI Foundations</h2><p>Думай разом з AI, став правильні питання й перевіряй результат.</p></div>
        <div class="module-progress"><strong>42%</strong><span><i style="height:42%"></i></span></div>
      </section>
      <div class="journey-label"><span>ТВОЯ ТРАЄКТОРІЯ</span><b>3 / 8 уроків</b></div>
      <div class="lesson-journey">
        ${lessons.map(lesson => `
          <button class="lesson-node ${lesson.status}" ${lesson.status === 'locked' ? 'aria-disabled="true"' : ''}>
            <span class="lesson-marker">${stateIcon(lesson.status)}</span>
            <span class="lesson-copy"><small>${lesson.n} · ${lesson.status === 'current' ? 'ЗАРАЗ' : lesson.meta.toUpperCase()}</small><strong>${lesson.title}</strong>${lesson.status === 'current' ? '<em>Продовжити урок · +120 XP</em>' : ''}</span>
            <span class="lesson-action">${lesson.status === 'current' ? arrowIcon() : lesson.status === 'done' ? '+XP' : ''}</span>
          </button>`).join('')}
      </div>
      <section class="mentor-dock">
        ${portalMarkup('mini')}
        <div><span>AI МЕНТОР</span><strong>Застряг на маршруті?</strong><p>Розберемо складне питання разом.</p></div>
        <button data-tab="ai" aria-label="Запитати AI ментора">${arrowIcon()}</button>
      </section>
    </section>`;
}

function project() {
  const tasks = [
    ['01', 'Сформулювати проблему', 'Готово', 'done', '+80 XP'],
    ['02', 'Описати користувача', 'Готово', 'done', '+100 XP'],
    ['03', 'Зібрати перший прототип', 'Твій крок · +160 XP', 'current', ''],
    ['04', 'Показати 3 людям', 'Далі', 'locked', '']
  ];
  return `
    <section class="page project-page">
      <div class="page-title"><span class="section-kicker">STARTUP LAB</span><span class="zone-code">ZONE 03 · LAB</span><h1>Мій проєкт</h1><p>Тут ідея перетворюється на продукт.</p></div>
      <section class="project-engine">
        <div class="lab-readout"><span>BUILD CHANNEL</span><strong>ПРОТОТИП</strong><div><i class="done"></i><i class="done"></i><i class="active"></i><i></i><i></i></div></div>
        <div class="project-engine-art">${portalMarkup('medium lab-engine', '03', 'BUILD')}<span class="stage-index">03</span></div>
        <div class="project-engine-copy"><span>MVP · В РОБОТІ</span><h2>Smart Study<br>Planner</h2><p>AI-помічник для навчання без хаосу.</p></div>
        <div class="project-meter"><div><span>ГОТОВНІСТЬ</span><strong>62%</strong></div><i><b style="width:62%"></b></i></div>
      </section>
      <div class="stage-tags"><span>AI</span><i></i><span>WEB</span><i></i><span>EDUCATION</span></div>
      <div class="section-head"><div><span class="section-kicker">СПРИНТ 01</span><h2>Збираємо основу</h2></div><span class="tiny-badge">3 / 5</span></div>
      <div class="build-path">
        ${tasks.map(([number, title, meta, status, reward]) => `
          <article class="build-step ${status}">
            <span class="build-marker">${status === 'done' ? stateIcon('done') : number}</span>
            <div><strong>${title}</strong><small>${meta}</small></div>
            <span class="build-reward">${reward || (status === 'current' ? arrowIcon() : stateIcon('locked'))}</span>
          </article>`).join('')}
      </div>
      <section class="workspace-dock">
        <div class="workspace-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 8-4 4 4 4M15 8l4 4-4 4M14 5l-4 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <div><span>CODE WORKSPACE</span><h3>Продовжити збірку</h3><p>Повна web-версія з кодом і preview.</p></div>
        <button class="primary-btn compact" id="openCode">Відкрити ${externalIcon()}</button>
      </section>
    </section>`;
}

function ai() {
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
        <div class="message ai-msg"><div class="msg-avatar">${svgIcon('ai')}</div><p>Привіт, ${firstName}! Бачу, ти збираєш <b>Smart Study Planner</b>. З чого почнемо?</p></div>
        <div class="ai-context" aria-label="Контекст AI ментора синхронізовано"><span>КОНТЕКСТ ПІДКЛЮЧЕНО</span><div><b>УРОК 03</b><i></i><em></em><i></i><b>MVP 62%</b></div><small>Ментор бачить твій поточний маршрут</small></div>
      </div>
      <form class="composer" id="composer">
        <button type="button" class="attach" aria-label="Додати файл">+</button>
        <input id="aiInput" autocomplete="off" aria-label="Повідомлення AI ментору" placeholder="Запитай про урок або проєкт…">
        <button class="send" aria-label="Надіслати">${arrowIcon()}</button>
      </form>
      <p class="ai-note">AI допомагає думати, але не робить проєкт замість тебе.</p>
    </section>`;
}

function profile() {
  const achievements = [
    ['spark', 'First Spark', 'Перша ідея', '01'],
    ['build', 'Builder', 'Перший MVP', '02'],
    ['explore', 'AI Explorer', '50 запитів', '03'],
    ['locked', 'Demo Day', 'Ще попереду', '04']
  ];
  return `
    <section class="page profile-page">
      <div class="profile-head">
        <div class="profile-orbit"><div class="big-avatar">${firstName[0]?.toUpperCase() || 'M'}</div><i></i><b></b></div>
        <span class="profile-level">CREATOR · LEVEL 4</span><h1>${firstName}</h1><p>Будуєш ідеї, які працюють.</p>
      </div>
      <section class="level-track">
        <div><span>НАСТУПНИЙ РІВЕНЬ</span><strong>Builder → Creator</strong></div><b>640 <small>/ 900 XP</small></b>
        <i><em style="width:71%"></em></i>
      </section>
      <div class="profile-stats"><div><strong>12</strong><small>уроків</small></div><div><strong>2</strong><small>проєкти</small></div><div><strong>4</strong><small>дні серії</small></div></div>
      <div class="section-head"><div><span class="section-kicker">АРТЕФАКТИ</span><h2>Твоя колекція</h2></div><span class="tiny-badge">3 / 8</span></div>
      <div class="artifacts">
        ${achievements.map(([type, title, meta, number]) => `<article class="artifact ${type}"><span class="artifact-number">A-${number}</span><div class="artifact-glyph"><i></i>${artifactIcon(type)}</div><span class="artifact-state">${type === 'locked' ? 'НЕ ВІДКРИТО' : 'ЗНАЙДЕНО'}</span><strong>${title}</strong><small>${meta}</small></article>`).join('')}
      </div>
      <div class="profile-links">
        <button><span class="link-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></span><span><strong>Сповіщення</strong><small>Уроки та дедлайни</small></span>${arrowIcon()}</button>
        <button><span class="link-icon">1:1</span><span><strong>Мій ментор</strong><small>Наступна зустріч</small></span>${arrowIcon()}</button>
      </div>
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

const templates = { home, learn, project, ai, profile };

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

    if (updateHistory && location.hash !== `#${active}`) history.pushState({ tab: active }, '', `#${active}`);
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

  const form = document.querySelector('#composer');
  if (form) {
    const input = document.querySelector('#aiInput');
    const chat = document.querySelector('#chat');
    const submit = text => {
      if (!text?.trim()) return;
      chat.querySelector('.ai-context')?.remove();
      chat.insertAdjacentHTML('beforeend', `<div class="message user-msg"><p>${escapeHtml(text.trim())}</p></div>`);
      input.value = '';
      chat.scrollTop = chat.scrollHeight;
      setTimeout(() => {
        if (!document.body.contains(chat)) return;
        chat.insertAdjacentHTML('beforeend', `<div class="message ai-msg"><div class="msg-avatar">${svgIcon('ai')}</div><p>Добре. Почнімо з головного: <b>який результат ти хочеш отримати?</b></p></div>`);
        chat.scrollTop = chat.scrollHeight;
      }, 450);
    };
    form.onsubmit = event => {
      event.preventDefault();
      submit(input.value);
    };
    document.querySelectorAll('[data-prompt]').forEach(button => {
      button.onclick = () => submit(button.dataset.prompt);
    });
  }

  document.querySelector('#openCode')?.addEventListener('click', () => {
    if (tg?.openLink) tg.openLink(WORKSPACE_URL);
    else window.open(WORKSPACE_URL, '_blank', 'noopener,noreferrer');
  });
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-tab]');
  if (target && !target.closest('#view')) render(target.dataset.tab);
});

function renderFromLocation() {
  const requested = location.hash.replace('#', '');
  const next = templates[requested] ? requested : 'home';
  if (next !== active || !view.children.length) render(next, false);
}

window.addEventListener('popstate', renderFromLocation);
window.addEventListener('hashchange', renderFromLocation);
renderFromLocation();
