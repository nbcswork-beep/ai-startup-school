const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready(); tg.expand();
  try { tg.setHeaderColor('#1818f5'); tg.setBackgroundColor('#1010d8'); } catch {}
}
const user = tg?.initDataUnsafe?.user;
const firstName = user?.first_name || 'Максим';
const nav=[['home','⌂','Головна'],['learn','◫','Навчання'],['project','◇','Проєкт'],['ai','✦','AI'],['profile','◎','Профіль']];
const lessons=[
 {n:'01',title:'AI — не магія',meta:'Пройдено',status:'done',icon:'✦'},
 {n:'02',title:'Як говорити з AI',meta:'Пройдено',status:'done',icon:'◌'},
 {n:'03',title:'AI може помилятися',meta:'Сьогодні · 17 хв',status:'current',icon:'!'},
 {n:'04',title:'Проблема → ідея',meta:'Відкриється завтра',status:'locked',icon:'◇'},
 {n:'05',title:'Перший MVP',meta:'Наступний тиждень',status:'locked',icon:'↗'}
];
const app=document.querySelector('#app');
app.innerHTML=`
<div class="app-shell">
 <div class="ambient ambient-a"></div><div class="ambient ambient-b"></div>
 <header class="topbar">
  <button class="brand" data-tab="home"><span class="brand-symbol">AI</span><span class="brand-name">STARTUP<br><b>SCHOOL</b></span></button>
  <div class="top-actions"><button class="icon-btn notification">◉<i></i></button><button class="avatar" data-tab="profile">${firstName[0]?.toUpperCase()||'M'}</button></div>
 </header>
 <main id="view" class="view"></main>
 <nav class="bottom-nav">${nav.map(([id,icon,label])=>`<button class="nav-item" data-tab="${id}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`).join('')}</nav>
</div>`;
const view=document.querySelector('#view');
let active='home';

function home(){return `
<section class="page home-page">
 <div class="eyebrow">ДОБРОГО ДНЯ, ${firstName.toUpperCase()} <span>✦</span></div>
 <section class="hero-card">
  <div class="portal-orbit orbit-1"></div><div class="portal-orbit orbit-2"></div><div class="hero-glow"></div>
  <div class="hero-copy"><span class="pill purple">ТВІЙ ШЛЯХ</span><h1>Твоя ідея<br><em>стає проєктом.</em></h1><p>Сьогодні продовжуємо будувати те, що придумав саме ти.</p><button class="primary-btn" data-tab="learn">Продовжити навчання <b>→</b></button></div>
  <div class="portal-core"><div class="portal-ring ring-a"></div><div class="portal-ring ring-b"></div><div class="portal-center">AI</div></div>
  <div class="float-chip chip-code">&lt;/&gt;</div><div class="float-chip chip-ai">✦</div><div class="float-chip chip-idea">💡</div>
 </section>
 <div class="section-head"><div><span class="section-kicker">СЬОГОДНІ</span><h2>Твій наступний крок</h2></div><span class="tiny-badge">3 / 8</span></div>
 <section class="today-card"><div class="lesson-art"><span>!</span><div class="mini-orbit"></div></div><div class="today-content"><span class="status-dot">УРОК 03</span><h3>AI може помилятися</h3><p>Навчись перевіряти відповіді AI і не вестися на впевнений тон.</p><div class="progress-row"><div class="progress"><i style="width:36%"></i></div><span>36%</span></div></div><button class="round-arrow" data-tab="learn">→</button></section>
 <div class="stats-grid"><article class="stat-card yellow"><span>⚡</span><strong>4</strong><small>дні поспіль</small></article><article class="stat-card cyan"><span>◇</span><strong>2</strong><small>проєкти</small></article><article class="stat-card pink"><span>✦</span><strong>640</strong><small>XP</small></article></div>
 <div class="section-head compact"><div><span class="section-kicker">ПРОЄКТ</span><h2>Ти зараз будуєш</h2></div><button class="text-link" data-tab="project">Відкрити →</button></div>
 <section class="project-preview" data-tab="project"><div class="project-gradient"></div><div class="project-top"><span class="pill yellow-pill">MVP</span><span>62%</span></div><div class="project-icon">↗</div><h3>Smart Study Planner</h3><p>AI-помічник, який складає план навчання під твої цілі.</p><div class="milestones"><i class="done"></i><i class="done"></i><i class="done"></i><i></i><i></i></div></section>
</section>`}

function learn(){return `
<section class="page"><div class="page-title"><span class="section-kicker">ТВІЙ МАРШРУТ</span><h1>Навчання</h1><p>Не дивись уроки. Створюй разом із ними.</p></div>
<section class="module-hero"><span class="pill yellow-pill">МОДУЛЬ 01</span><h2>AI Foundations</h2><p>Як думати разом з AI, ставити правильні питання і перевіряти результат.</p><div class="module-bottom"><div class="progress big"><i style="width:42%"></i></div><b>42%</b></div></section>
<div class="lesson-list">${lessons.map(x=>`<button class="lesson-row ${x.status}"><span class="lesson-num">${x.n}</span><span class="lesson-bubble">${x.icon}</span><span class="lesson-text"><strong>${x.title}</strong><small>${x.meta}</small></span><span class="lesson-state">${x.status==='done'?'✓':x.status==='current'?'→':'⌁'}</span></button>`).join('')}</div>
<section class="mentor-tip"><div class="mentor-orb">AI</div><div><span>AI МЕНТОР</span><strong>Застряг на уроці?</strong><p>Постав питання — я поясню без готової відповіді.</p></div><button data-tab="ai">→</button></section></section>`}

function project(){return `
<section class="page"><div class="page-title"><span class="section-kicker">STARTUP LAB</span><h1>Мій проєкт</h1><p>Від проблеми до продукту — крок за кроком.</p></div>
<section class="project-main-card"><div class="project-main-glow"></div><div class="project-status"><span class="pill yellow-pill">MVP · ACTIVE</span><span>62%</span></div><div class="project-logo">SP</div><h2>Smart Study Planner</h2><p>AI-помічник, який допомагає школярам планувати навчання без хаосу.</p><div class="tag-row"><span>AI</span><span>Web</span><span>Education</span></div><div class="progress big"><i style="width:62%"></i></div></section>
<div class="section-head compact"><div><span class="section-kicker">СПРИНТ</span><h2>Що робимо зараз</h2></div><span class="tiny-badge">3 / 5</span></div>
<div class="task-stack"><article class="task done"><button>✓</button><div><strong>Сформулювати проблему</strong><small>Готово</small></div><span>+80 XP</span></article><article class="task done"><button>✓</button><div><strong>Описати користувача</strong><small>Готово</small></div><span>+100 XP</span></article><article class="task active"><button>03</button><div><strong>Зібрати перший прототип</strong><small>Твій поточний крок</small></div><span>→</span></article><article class="task"><button>04</button><div><strong>Показати 3 людям</strong><small>Далі</small></div><span>⌁</span></article></div>
<section class="build-card"><div class="code-lines"><i></i><i></i><i></i><i></i></div><div><span>CODE WORKSPACE</span><h3>Відкрити проєкт</h3><p>Код, preview та AI-помічник у повній web-версії.</p></div><button class="primary-btn small" id="openCode">Відкрити <b>↗</b></button></section></section>`}

function ai(){return `
<section class="page ai-page"><div class="ai-header"><div class="ai-orb"><span>✦</span></div><div><span class="section-kicker">ТВІЙ AI МЕНТОР</span><h1>Питай. Думай.<br>Створюй.</h1></div></div>
<div class="suggestions"><button data-prompt="Допоможи мені перевірити мою ідею">Перевірити ідею <span>◇</span></button><button data-prompt="Поясни тему простіше">Пояснити тему <span>◌</span></button><button data-prompt="Підкажи, що робити далі з проєктом">Наступний крок <span>→</span></button></div>
<div class="chat" id="chat"><div class="message ai-msg"><div class="msg-avatar">✦</div><p>Привіт, ${firstName}! Я знаю, що ти зараз працюєш над <b>Smart Study Planner</b>. Чим допомогти?</p></div></div>
<form class="composer" id="composer"><button type="button" class="attach">＋</button><input id="aiInput" autocomplete="off" placeholder="Запитай про урок або проєкт…" /><button class="send">↑</button></form><p class="ai-note">AI допомагає думати, але не робить проєкт замість тебе.</p></section>`}

function profile(){return `
<section class="page profile-page"><div class="profile-head"><div class="big-avatar">${firstName[0]?.toUpperCase()||'M'}<i></i></div><h1>${firstName}</h1><p>Junior Creator · Level 4</p><div class="xp-pill"><span>✦</span> 640 XP</div></div>
<section class="level-card"><div class="level-top"><div><span>НАСТУПНИЙ РІВЕНЬ</span><strong>Builder → Creator</strong></div><b>640 / 900 XP</b></div><div class="progress big"><i style="width:71%"></i></div></section>
<div class="section-head compact"><div><span class="section-kicker">ДОСЯГНЕННЯ</span><h2>Твоя колекція</h2></div></div>
<div class="badges"><article><span>⚡</span><strong>First Spark</strong><small>Перша ідея</small></article><article><span>◇</span><strong>Builder</strong><small>Перший MVP</small></article><article><span>✦</span><strong>AI Explorer</strong><small>50 запитів</small></article><article class="locked"><span>♛</span><strong>Demo Day</strong><small>Ще попереду</small></article></div>
<div class="settings-list"><button><span>◉</span><div><strong>Сповіщення</strong><small>Уроки, дедлайни, відповіді</small></div><b>→</b></button><button><span>⌁</span><div><strong>Мій ментор</strong><small>Наступна 1:1 зустріч</small></div><b>→</b></button></div></section>`}

const templates={home,learn,project,ai,profile};
function render(tab,push=true){active=templates[tab]?tab:'home';view.classList.add('leaving');setTimeout(()=>{view.innerHTML=templates[active]();document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.tab===active));view.classList.remove('leaving');wirePage();if(push)history.replaceState({},'',`#${active}`);haptic('selection')},100)}
function haptic(type='impact'){try{if(!tg?.HapticFeedback)return;if(type==='selection')tg.HapticFeedback.selectionChanged();else tg.HapticFeedback.impactOccurred('light')}catch{}}
function wirePage(){document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>render(el.dataset.tab));const form=document.querySelector('#composer');if(form){const input=document.querySelector('#aiInput'),chat=document.querySelector('#chat');const submit=text=>{if(!text?.trim())return;chat.insertAdjacentHTML('beforeend',`<div class="message user-msg"><p>${escapeHtml(text.trim())}</p></div>`);input.value='';chat.scrollTop=chat.scrollHeight;setTimeout(()=>{chat.insertAdjacentHTML('beforeend','<div class="message ai-msg"><div class="msg-avatar">✦</div><p>Добре. Я не дам готову відповідь одразу. Спочатку: <b>який результат ти хочеш отримати?</b></p></div>');chat.scrollTop=chat.scrollHeight},450)};form.onsubmit=e=>{e.preventDefault();submit(input.value)};document.querySelectorAll('[data-prompt]').forEach(btn=>btn.onclick=()=>submit(btn.dataset.prompt))}document.querySelector('#openCode')?.addEventListener('click',()=>alert('Тут відкриватиметься Code Workspace.'))}
function escapeHtml(str){return str.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]))}
document.addEventListener('click',e=>{const t=e.target.closest('[data-tab]');if(t&&!t.closest('#view'))render(t.dataset.tab)});
const initial=location.hash.replace('#','');render(templates[initial]?initial:'home',false);
