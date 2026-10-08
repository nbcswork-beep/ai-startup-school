import { currentProject, projectProgress, nextProjectStep, homeworkStatus, homeworkAction, sessions,
  nextSession, sessionStatus, newFeedback, meaningfulAchievements, safeHttpsUrl, safeAssetUrl } from './student-model.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);
const e = escapeHtml;
// Retain the application's existing arrow icons.
const arrow = '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const external = '<svg class="arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5h9v9M19 5l-9 9M18 13v6H5V6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const status = (label, key = '') => `<span class="work-status ${e(key)}"><span aria-hidden="true">${['completed', 'approved'].includes(key) ? '✓' : ['locked', 'not_started', 'cancelled', 'archived'].includes(key) ? '○' : '●'}</span>${e(label)}</span>`;
const timezone = data => data.schedule?.timezone ?? 'Europe/Kyiv';
const time = (value, data) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('uk-UA', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: timezone(data)
}).format(new Date(value)) : 'Час ще не визначено';
const title = (heading, description = '') => `<header class="work-page-head"><h1>${e(heading)}</h1>${description ? `<p>${e(description)}</p>` : ''}</header>`;
const empty = (heading, description = '') => `<div class="work-empty"><h2>${e(heading)}</h2>${description ? `<p>${e(description)}</p>` : ''}</div>`;
const taskLabel = task => ({ locked: 'Ще не відкрито', available: 'Не розпочато', in_progress: 'У роботі',
  pending_review: 'Очікує перевірки', needs_revision: 'Потрібне доопрацювання', completed: 'Підтверджено викладачем' })[task.status] ?? 'Статус уточнюється';

function progress(project) {
  const value = projectProgress(project);
  return `<div class="work-progress"><div><span>Прогрес проєкту</span><strong>${value.percent === null ? `${value.completed} / ${value.total} етапів` : `${value.percent}%`}</strong></div>
    ${value.percent === null ? '' : `<progress value="${value.percent}" max="100" aria-label="Прогрес проєкту: ${value.percent}%">${value.percent}%</progress>`}
    <small>Підтверджено викладачем: ${value.completed} з ${value.total} етапів</small></div>`;
}

function homeworkRow(item, data) {
  const action = homeworkAction(item);
  return `<article class="work-task-row">${status(homeworkStatus(item), item.state)}<h3>${e(item.title)}</h3>
    <p>${item.dueAt ? `До ${e(time(item.dueAt, data))}` : 'Без дедлайну'}</p>
    ${item.latestSubmission?.review?.feedback ? '<span class="work-feedback-label">Є відгук викладача</span>' : ''}
    <button class="text-link" data-homework="${e(item.id)}">${action ?? 'Переглянути надіслану роботу'} ${arrow}</button></article>`;
}

function nextClass(item, data, primary = false) {
  const join = safeHttpsUrl(item.meetingUrl);
  const lesson = data.learning.modules.flatMap(module => module.lessons).find(lesson => lesson.id === item.id);
  return `<section class="work-next-class"><span class="work-kicker">Наступне заняття</span>
    ${status(sessionStatus(item, timezone(data)), item.status)}<h2>${e(item.title)}</h2><p>${e(time(item.startsAt, data))}</p>
    ${item.teacherName ? `<small>${e(item.teacherName)} · ${e(item.durationMinutes)} хв</small>` : ''}
    ${join ? `<button class="${primary ? 'primary-btn' : 'secondary-btn'}" data-external="${e(join)}">Приєднатися до заняття ${external}</button>`
    : lesson && lesson.state !== 'locked' ? `<button class="${primary ? 'primary-btn' : 'secondary-btn'}" data-lesson="${e(lesson.id)}">Переглянути заняття ${arrow}</button>`
    : '<p class="work-muted">Посилання з’явиться перед заняттям.</p>'}</section>`;
}

export function homeView(data) {
  const project = currentProject(data), step = nextProjectStep(project), next = nextSession(data);
  const homework = (data.homework ?? []).filter(item => item.state !== 'completed');
  const feedback = newFeedback(data);
  return `<section class="page workspace-page workspace-home">
    <header class="work-greeting"><h1>Привіт, ${e(data.home.viewer.firstName)}</h1><p>Твій наступний крок — тут.</p></header>
    <section class="work-project-hero"><span class="work-kicker">Твій проєкт</span><h2>${e(project?.title ?? 'Проєкт ще не створено')}</h2>
      ${project ? `<p class="work-stage">Етап: <strong>${e(project.stage?.title || 'Ще не визначено')}</strong></p>${progress(project)}` : '<p>Почни з проблеми, яку хочеш вирішити.</p>'}
      <div class="work-next-step"><span class="work-kicker">Наступний крок</span><p>${e(step.text)}</p></div>
      <button class="primary-btn" data-tab="${project?.status === 'completed' ? 'portfolio' : 'project'}">${e(step.action)} ${arrow}</button>
    </section>
    <div class="work-home-operations">${next ? nextClass(next, data) : '<section class="work-operation-empty"><h2>Наступне заняття</h2><p>Викладач ще не запланував наступне заняття.</p><button class="text-link" data-tab="learn">Переглянути навчання ' + arrow + '</button></section>'}
    <section class="work-home-homework"><div class="work-section-head"><h2>Домашнє завдання</h2>${homework.length ? `<span>${homework.length} активних</span>` : ''}</div>
      ${homework.length ? homeworkRow(homework.find(item => item.state === 'needs_revision') ?? homework.find(item => ['not_started', 'in_progress'].includes(item.state)) ?? homework[0], data) : '<p class="work-muted">Активних завдань немає.</p>'}
      ${homework.length > 1 ? `<button class="text-link" data-tab="learn">Переглянути всі завдання ${arrow}</button>` : ''}</section>
    ${feedback.length ? `<section class="work-new-feedback"><span class="work-kicker">Новий відгук</span><h2>${e(feedback[0].title)}</h2><p>${e(feedback[0].description)}</p>
      <button class="secondary-btn" data-homework="${e(feedback[0].destination.homeworkId)}" data-feedback-read="${e(feedback[0].id)}">Переглянути відгук ${arrow}</button></section>` : ''}</div></section>`;
}

export function learningView(data) {
  const lessons = data.learning.modules.flatMap(module => module.lessons), all = sessions(data);
  const next = nextSession(data), current = lessons.find(item => ['current', 'available'].includes(item.state));
  const sorted = all.filter(item => item.id !== next?.id).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return `<section class="page workspace-page">${title('Навчання', 'Заняття, матеріали та домашні завдання.')}
    ${next ? nextClass(next, data, true) : current ? `<section class="work-next-class"><span class="work-kicker">Продовжити навчання</span><h2>${e(current.title)}</h2><button class="primary-btn" data-lesson="${e(current.id)}">Відкрити урок ${arrow}</button></section>` : empty('Наступне заняття ще не заплановано', 'Нові заняття з’являться після того, як їх додасть викладач.')}
    <section class="work-section"><div class="work-section-head"><h2>Заняття й матеріали</h2><span>${data.learning.course.completedLessons} / ${data.learning.course.totalLessons} зараховано</span></div>
      ${all.length ? sorted.map(item => { const lesson = lessons.find(lesson => lesson.id === item.id);
        return `<article class="work-lesson-row">${status(sessionStatus(item, timezone(data)), item.status)}<h3>${e(item.title)}</h3><p>${e(time(item.startsAt, data))}</p>
          ${lesson?.state === 'completed' ? '<small>Зараховано викладачем</small>' : lesson?.completionReview?.status === 'pending_review' ? '<small>Очікує підтвердження викладача</small>' : lesson?.state === 'locked' ? '<small>Матеріали відкриються після підтвердження попереднього уроку.</small>' : ''}
          ${lesson && lesson.state !== 'locked' ? `<button class="text-link" data-lesson="${e(lesson.id)}">Відкрити урок ${arrow}</button>` : ''}
          ${materials(item.materials)}</article>`;
      }).join('') || '<p class="work-muted">Після заняття тут залишаться його матеріали та статус.</p>' : lessons.map(lesson => `<article class="work-lesson-row">${status(lesson.state === 'completed' ? 'Зараховано' : lesson.state === 'locked' ? 'Ще не відкрито' : 'Матеріали доступні', lesson.state)}<h3>${e(lesson.title)}</h3>${lesson.state !== 'locked' ? `<button class="text-link" data-lesson="${e(lesson.id)}">Відкрити урок ${arrow}</button>` : ''}</article>`).join('') || '<p class="work-muted">Занять ще немає. Викладач додасть їх для твоєї групи.</p>'}
    </section>
    <section class="work-section"><div class="work-section-head"><h2>Домашні завдання</h2></div>${data.homework?.length ? data.homework.map(item => homeworkRow(item, data)).join('') : '<p class="work-muted">Викладач ще не опублікував домашніх завдань.</p>'}</section>
    ${(data.recoveries ?? []).length ? `<section class="work-section"><h2>Наздогнати пропущене</h2>${data.recoveries.map(item => `<article class="work-lesson-row"><h3>${e(item.lessonTitle || item.title)}</h3><p>${e(item.description)}</p>${materials(item.materials)}${item.homework ? `<button class="secondary-btn" data-homework="${e(item.homework.id)}">Відкрити завдання ${arrow}</button>` : ''}${item.mentorSlotId ? `<button class="text-link" data-recovery-mentor="${e(item.mentorSlotId)}">Записатися до ментора ${arrow}</button>` : ''}</article>`).join('')}</section>` : ''}
  </section>`;
}

function materials(items = []) {
  return items.length ? `<div class="work-materials">${items.map(item => safeHttpsUrl(item.url) ? `<button class="secondary-btn" data-external="${e(safeHttpsUrl(item.url))}">Відкрити матеріал: ${e(item.title)} ${external}</button>` : `<span class="work-muted">${e(item.title)} · посилання ще немає</span>`).join('')}</div>` : '';
}

export function projectView(data) {
  const project = currentProject(data);
  if (!project) return `<section class="page workspace-page">${title('Твій проєкт', 'Почни з однієї проблеми та ідеї рішення.')}${empty('Проєкт ще не створено', 'Назву й короткий опис можна буде змінити.')}
    <form id="createProject" class="work-form"><label>Назва проєкту<input name="title" minlength="2" maxlength="120" required autocomplete="off"></label><label>Яку проблему ти хочеш вирішити?<textarea name="summary" maxlength="1000"></textarea></label><button class="primary-btn">Створити проєкт ${arrow}</button></form></section>`;
  const step = nextProjectStep(project), task = step.task;
  const actionable = project.status === 'active' && task && ['in_progress', 'available', 'needs_revision'].includes(task.status);
  return `<section class="page workspace-page workspace-project">${title('Твій проєкт')}
    <section class="work-project-hero"><div class="work-section-head"><span class="work-kicker">${project.status === 'completed' ? 'Завершений проєкт' : 'Поточний проєкт'}</span><button class="text-link" id="editProject">Змінити опис</button></div>
      <h2>${e(project.title)}</h2>${project.summary ? `<p>${e(project.summary)}</p>` : '<p class="work-muted">Опис ще не додано.</p>'}
      <p class="work-stage">Етап: <strong>${e(project.stage?.title || 'Ще не визначено')}</strong></p>${progress(project)}
      <div class="work-next-step"><span class="work-kicker">Наступний крок</span><p>${e(step.text)}</p></div>
      ${actionable ? `<button class="primary-btn" id="continueProject">${e(step.action)} ${arrow}</button>` : task?.status === 'pending_review' ? '<button class="secondary-btn" id="continueProject">Переглянути надіслану відповідь</button>' : project.status === 'completed' ? `<button class="primary-btn" data-tab="portfolio">Відкрити портфоліо ${arrow}</button>` : ''}
    </section>
    ${task && (actionable || task.status === 'pending_review') ? `<form class="work-form" id="projectStageSubmit" hidden data-project-id="${e(project.id)}" data-task-id="${e(task.id)}" data-version="${task.version ?? 1}"><h2>${e(task.title)}</h2><p>${e(task.description)}</p>${task.feedback ? `<blockquote class="work-feedback"><strong>Відгук викладача</strong><p>${e(task.feedback)}</p></blockquote>` : ''}<label>Твоя відповідь<textarea name="contentText" maxlength="20000" required ${actionable ? '' : 'disabled'}>${e(task.contentText)}</textarea></label><p class="work-muted">${actionable ? 'Наступний етап відкриється після підтвердження викладачем.' : 'Відповідь на перевірці. Повторно надсилати її не потрібно.'}</p>${actionable ? `<button class="primary-btn">Надіслати на перевірку ${arrow}</button>` : ''}</form>` : ''}
    <section class="work-section"><h2>Етапи проєкту</h2><ol class="work-stage-list">${project.tasks.map(task => `<li>${status(taskLabel(task), task.status)}<h3>${e(task.title)}</h3>${task.contentText || task.feedback ? `<details><summary>Переглянути відповідь${task.feedback ? ' і відгук' : ''}</summary>${task.contentText ? `<p class="work-preserve">${e(task.contentText)}</p>` : ''}${task.feedback ? `<blockquote class="work-feedback"><strong>Відгук викладача</strong><p>${e(task.feedback)}</p></blockquote>` : ''}</details>` : ''}</li>`).join('')}</ol></section>
    <section class="work-section"><h2>Продукт і робочий простір</h2>${safeHttpsUrl(project.workspaceUrl) ? `<button class="secondary-btn" id="openCode">Відкрити робочий простір ${external}</button>` : '<p class="work-muted">Посилання ще не додано. Збережи посилання на свій продукт у нотатках нижче.</p>'}${project.tags?.length ? `<p class="work-muted">Технології: ${project.tags.map(e).join(', ')}</p>` : ''}</section>
    <section class="work-section"><h2>Нотатки та результати</h2>${(project.notes ?? []).map(note => `<article class="work-note">${note.contentText ? `<p class="work-preserve">${e(note.contentText)}</p>` : ''}${safeHttpsUrl(note.contentUrl) ? `<button class="text-link" data-external="${e(safeHttpsUrl(note.contentUrl))}">Відкрити посилання проєкту ${external}</button>` : ''}${(note.replies ?? []).map(reply => `<blockquote class="work-feedback"><strong>${e(reply.teacherName)}</strong><p>${e(reply.contentText)}</p></blockquote>`).join('')}</article>`).join('') || '<p class="work-muted">Тут можна зберігати ідеї, результати та посилання.</p>'}
      <form class="work-form work-note-form" id="projectNoteForm" data-project-id="${e(project.id)}" data-version="${project.notes?.length ?? 0}"><label>Нотатка<textarea name="contentText" maxlength="20000" placeholder="Ідея, результат чи питання до викладача…"></textarea></label><label>Посилання на продукт або результат — за потреби<input type="url" inputmode="url" name="contentUrl" maxlength="2048" pattern="https://.*" placeholder="https://…"></label><button class="secondary-btn">Зберегти нотатку</button></form>
    </section><form class="work-form" id="projectEditor" data-project-id="${e(project.id)}" hidden><h2>Опис проєкту</h2><label>Назва<input name="title" value="${e(project.title)}" minlength="2" maxlength="120" required></label><label>Короткий опис<textarea name="summary" maxlength="1000">${e(project.summary)}</textarea></label><button class="secondary-btn">Зберегти опис</button></form></section>`;
}

export function portfolioView(data) {
  const portfolio = data.portfolio, entries = portfolio?.projects ?? [];
  const ready = (data.projects ?? []).find(project => project.status === 'completed' && !entries.some(item => item.projectId === project.id));
  return `<section class="page workspace-page">${title('Портфоліо', 'Результати, які ти вже можеш показати.')}<p class="work-muted">${portfolio?.visibility === 'shared' ? 'Для цього портфоліо налаштовано спільний доступ.' : 'Приватне портфоліо: доступ визначає школа.'}</p>
    ${entries.length ? `<div class="work-portfolio-list">${entries.map(item => { const actual = data.projects.find(project => project.id === item.projectId);
      const completed = actual ? actual.status === 'completed' : Boolean(item.completionDate);
      const cover = safeAssetUrl(item.coverPath), demo = safeHttpsUrl(item.demoUrl);
      return `<article class="work-result">${cover ? `<img class="work-cover" src="${e(cover)}" alt="Обкладинка проєкту ${e(item.title)}" loading="lazy">` : ''}${status(completed ? 'Завершено' : demo ? 'Доступний результат' : 'Додано до портфоліо', completed ? 'completed' : 'active')}<h2>${e(item.title)}</h2><p>${e(item.shortDescription)}</p>
        ${item.technologies?.length ? `<small>Технології: ${[...new Set(item.technologies)].map(e).join(', ')}</small>` : ''}${item.reflection ? `<blockquote class="work-preserve">${e(item.reflection)}</blockquote>` : ''}${item.learned ? `<p>${e(item.learned)}</p>` : ''}${demo ? `<button class="secondary-btn" data-external="${e(demo)}">Відкрити продукт ${external}</button>` : '<p class="work-muted">Посилання на продукт ще не додано.</p>'}
        ${(item.screenshots ?? []).filter(safeAssetUrl).length ? `<div class="work-screenshots">${item.screenshots.filter(safeAssetUrl).map((url, index) => `<img src="${e(safeAssetUrl(url))}" alt="Скріншот ${index + 1} проєкту ${e(item.title)}" loading="lazy">`).join('')}</div>` : ''}</article>`;
    }).join('')}</div>` : empty('Тут з’являться твої завершені проєкти.', 'Працюй над поточним проєктом. Коли результат буде готовий, додай його сюди.')}
    ${ready ? `<button class="primary-btn" data-add-portfolio="${e(ready.id)}">Додати завершений проєкт: ${e(ready.title)} ${arrow}</button>` : `<button class="${entries.length ? 'text-link' : 'primary-btn'}" data-tab="project">Відкрити поточний проєкт ${arrow}</button>`}</section>`;
}

export function profileView(data) {
  const profile = data.profile, viewer = profile.viewer, achievements = meaningfulAchievements(data);
  return `<section class="page workspace-page">${title('Профіль')}<section class="work-profile"><div class="big-avatar">${e(Array.from(viewer.firstName || 'У')[0])}</div><div><h2>${e(viewer.firstName)}</h2><p>${viewer.group ? `Група: ${e(viewer.group.name)}${viewer.group.status === 'archived' ? ' · Архів' : ''}` : 'Групу ще не призначено.'}</p></div></section>
    <section class="work-section"><h2>Навчальний прогрес</h2><dl class="work-stats"><div><dt>Зараховано уроків</dt><dd>${e(profile.lessonCount)}</dd></div><div><dt>Проєктів</dt><dd>${e(profile.projectCount)}</dd></div><div><dt>Досвід</dt><dd>${e(viewer.xp)} XP</dd></div></dl><p class="work-muted">XP зберігає навчальні досягнення. Прогрес проєкту показано на сторінці проєкту.</p></section>
    <section class="work-section"><h2>Досягнення проєкту</h2>${achievements.length ? achievements.map(item => `<article class="work-achievement">${status('Отримано', 'completed')}<h3>Перші підтверджені етапи</h3><p>Викладач підтвердив два етапи твого проєкту.</p></article>`).join('') : '<p class="work-muted">Тут з’являться досягнення за підтверджені кроки проєкту.</p>'}</section>
    <section class="work-section"><h2>Підтримка</h2><div class="profile-links"><button id="openNotificationsFromProfile"><span><strong>Переглянути сповіщення</strong><small>Заняття, завдання й відгуки</small></span>${arrow}</button><button id="openMentorBooking"><span><strong>Записатися до ментора</strong><small>${e(profile.mentor?.displayName || 'Обери зручний час')}</small></span>${arrow}</button></div>
    <section class="mentor-booking" id="mentorBooking" hidden><h2>Забронювати зустріч</h2><div class="mentor-slots"><p class="work-muted">Завантажуємо доступний час…</p></div></section></section></section>`;
}

export function homeworkView(data, homework) {
  if (!homework) return `<section class="page workspace-page"><button class="lesson-back" data-tab="learn">← Повернутися до навчання</button>${empty('Завдання недоступне', 'Викладач міг зняти його з публікації або змінити групу.')}</section>`;
  const submission = homework.latestSubmission, review = submission?.review;
  const canSubmit = !homework.withdrawn && ['not_started', 'in_progress', 'needs_revision'].includes(homework.state);
  return `<section class="page workspace-page"><button class="lesson-back" data-tab="learn">← Повернутися до навчання</button>${status(homeworkStatus(homework), homework.state)}${title(homework.title, homework.instructions)}
    <dl class="work-brief"><div><dt>Дедлайн</dt><dd>${homework.dueAt ? e(time(homework.dueAt, data)) : 'Без дедлайну'}</dd></div>${homework.classTitle ? `<div><dt>Пов’язане заняття</dt><dd>${e(homework.classTitle)}</dd></div>` : ''}</dl>${materials(homework.resources)}
    ${review ? `<section class="work-feedback"><h2>Відгук викладача</h2><p>${e(review.feedback || 'Викладач перевірив роботу без текстового коментаря.')}</p><small>Оцінка: ${e(review.score)} / 10</small></section>` : ''}
    ${submission ? `<details class="work-attempt"><summary>Переглянути надіслану роботу · спроба ${e(submission.attemptNumber)}</summary><p class="work-preserve">${e(submission.contentText)}</p>${safeHttpsUrl(submission.contentUrl) ? `<button class="text-link" data-external="${e(safeHttpsUrl(submission.contentUrl))}">Відкрити посилання роботи ${external}</button>` : ''}${submission.studentComment ? `<p class="work-preserve">Твій коментар: ${e(submission.studentComment)}</p>` : ''}</details>` : ''}
    ${homework.withdrawn ? '<p class="work-feedback" role="status">Завдання більше не активне для твоєї групи. Надсилання недоступне.</p>' : ''}
    ${canSubmit || homework.withdrawn ? `<form class="work-form" id="homeworkSubmit" data-homework-id="${e(homework.id)}"><h2>${homework.state === 'needs_revision' ? 'Допрацюй відповідь' : 'Твоя робота'}</h2><label>Результат<textarea name="contentText" maxlength="20000" required ${canSubmit ? '' : 'disabled'} placeholder="Опиши, що зробив…">${e(submission?.contentText)}</textarea></label><label>Посилання — за потреби<input name="contentUrl" type="url" inputmode="url" pattern="https://.*" maxlength="2048" placeholder="https://…" value="${e(submission?.contentUrl)}" ${canSubmit ? '' : 'disabled'}></label><label>Коментар викладачу<textarea name="studentComment" maxlength="2000" ${canSubmit ? '' : 'disabled'}>${e(submission?.studentComment)}</textarea></label><button class="primary-btn" ${canSubmit ? '' : 'disabled'}>${homework.state === 'needs_revision' ? 'Надіслати зміни' : 'Здати роботу'} ${arrow}</button></form>` : `<p class="work-feedback" role="status">${homework.state === 'completed' ? 'Роботу завершено. Відгук і надіслана відповідь збережені.' : review ? 'Відгук збережено. Очікуй на рішення викладача.' : 'Роботу надіслано. Очікуй на перевірку викладача.'}</p>`}</section>`;
}

export function lessonView(data, lesson) {
  if (!lesson) return `<section class="page workspace-page"><button class="lesson-back" data-tab="learn">← Повернутися до навчання</button>${empty('Урок недоступний', 'Викладач міг змінити або скасувати заняття.')}</section>`;
  const session = sessions(data).find(item => item.id === lesson.id), review = lesson.completionReview;
  const completed = lesson.state === 'completed', pending = review?.status === 'pending_review';
  return `<section class="page workspace-page"><button class="lesson-back" data-tab="learn">← Повернутися до навчання</button>${session ? status(sessionStatus(session, timezone(data)), session.status) : ''}${title(lesson.title, lesson.summary)}
    ${session ? `<p class="work-muted">${e(time(session.startsAt, data))} · ${e(session.durationMinutes)} хв</p>${materials(session.materials)}` : ''}
    ${lesson.content.explanation ? `<section class="work-section"><h2>${e(lesson.content.conceptName || 'Ключова ідея')}</h2><p class="work-preserve">${e(lesson.content.explanation)}</p></section>` : ''}
    ${lesson.content.examples?.length ? `<section class="work-section"><h2>Приклади</h2>${lesson.content.examples.map(item => `<p class="work-preserve">${e(item)}</p>`).join('')}</section>` : ''}
    ${lesson.content.task?.prompt ? `<section class="work-section"><h2>Практика</h2><p>${e(lesson.content.task.prompt)}</p>${lesson.content.task.hint ? `<p class="work-muted">${e(lesson.content.task.hint)}</p>` : ''}</section>` : ''}
    ${review?.feedback ? `<section class="work-feedback"><h2>Відгук викладача</h2><p>${e(review.feedback)}</p></section>` : ''}
    ${lesson.content.nextStep ? `<p class="work-muted">${e(lesson.content.nextStep)}</p>` : ''}
    ${completed ? '<p class="work-feedback" role="status">Урок зараховано викладачем.</p>' : pending ? '<p class="work-feedback" role="status">Очікує підтвердження викладача.</p>' : lesson.state !== 'locked' ? `<button class="primary-btn" id="completeLesson" data-lesson="${e(lesson.id)}">Надіслати на підтвердження ${arrow}</button>` : ''}
    ${(data.homework ?? []).filter(item => item.classSessionId === lesson.id).length ? `<section class="work-section"><h2>Домашня практика</h2>${data.homework.filter(item => item.classSessionId === lesson.id).map(item => homeworkRow(item, data)).join('')}</section>` : ''}</section>`;
}
