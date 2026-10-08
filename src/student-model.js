// Read-only presentation of the existing Student API. No academic state is stored here.
export function currentProject(data) {
  return data?.projects?.find(project => project.status === 'active')
    ?? data?.projects?.find(project => project.status === 'completed') ?? null;
}

export function projectProgress(project) {
  const tasks = project?.tasks ?? [];
  const completed = tasks.filter(task => task.status === 'completed').length;
  const weights = tasks.map(task => task.weight);
  const confirmedWeight = tasks.filter(task => task.status === 'completed').reduce((sum, task) => sum + task.weight, 0);
  const reliable = tasks.length > 0 && weights.every(weight => Number.isFinite(weight) && weight >= 0)
    && Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) < 0.001
    && Number.isFinite(project.completionPercent) && project.completionPercent >= 0 && project.completionPercent <= 100
    && Math.abs(confirmedWeight - project.completionPercent) < 0.001;
  return { percent: reliable ? project.completionPercent : null, completed, total: tasks.length };
}

export function nextProjectStep(project) {
  if (!project) return { task: null, text: 'Проєкт ще не створено.', action: 'Створити проєкт' };
  if (project.status === 'completed') return { task: null, text: 'Проєкт завершено. Додай результат до портфоліо.', action: 'Відкрити портфоліо' };
  const task = project.tasks?.find(item => item.status !== 'completed') ?? null;
  if (task?.status === 'pending_review') return { task, text: 'Відповідь на перевірці. Викладач відкриє наступний етап після підтвердження.', action: 'Переглянути проєкт' };
  if (task?.status === 'needs_revision') return { task, text: task.feedback || task.description || 'Переглянь відгук викладача й допрацюй відповідь.', action: 'Внести зміни' };
  if (task && ['available', 'in_progress'].includes(task.status)) return { task, text: task.description || task.title, action: 'Продовжити проєкт' };
  return { task: null, text: 'Наступний крок ще не визначено.', action: 'Переглянути проєкт' };
}

export function homeworkStatus(homework) {
  if (homework?.withdrawn) return 'Завдання більше не активне';
  if (homework?.state === 'submitted' && homework.latestSubmission?.review) return 'Є відгук викладача';
  return ({ not_started: 'Не розпочато', in_progress: 'У роботі', submitted: 'Очікує перевірки',
    needs_revision: 'Потрібне доопрацювання', completed: 'Завершено' })[homework?.state] ?? 'Статус уточнюється';
}

export function homeworkAction(homework) {
  if (homework?.state === 'needs_revision') return 'Внести зміни';
  if (homework?.latestSubmission?.review) return 'Переглянути відгук';
  return ({ not_started: 'Почати завдання', in_progress: 'Продовжити завдання',
    needs_revision: 'Внести зміни', completed: 'Переглянути роботу' })[homework?.state] ?? null;
}

export function sessions(data) {
  const schedule = data?.schedule ?? {};
  return [...new Map([...(schedule.upcoming ?? []), ...(schedule.past ?? []), ...(schedule.thisWeek ?? []),
    ...(schedule.today ?? []), ...(schedule.nextClass ? [schedule.nextClass] : [])].map(item => [item.id, item])).values()];
}

function dateKey(value, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function sessionStatus(session, timezone = 'Europe/Kyiv', now = Date.now()) {
  if (session.status === 'cancelled') return 'Скасовано';
  if (session.status === 'archived') return 'Архів';
  if (session.status === 'completed') return 'Завершено';
  if (session.status === 'in_progress') return 'Триває зараз';
  const today = dateKey(session.startsAt, timezone) === dateKey(now, timezone);
  if (session.status === 'rescheduled') return today ? 'Сьогодні · перенесено' : 'Перенесено';
  if (session.status === 'scheduled') return today ? 'Сьогодні' : 'Майбутнє';
  return 'Статус уточнюється';
}

export function nextSession(data) {
  return sessions(data).filter(item => ['scheduled', 'rescheduled', 'in_progress'].includes(item.status)
    && Date.parse(item.endsAt) >= Date.now()).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] ?? null;
}

export function newFeedback(data) {
  const homeworkIds = new Set((data?.homework ?? []).map(item => item.id));
  return (data?.notifications?.items ?? []).filter(item => !item.readAt && item.type.includes('homework_reviewed')
    && homeworkIds.has(item.destination?.homeworkId));
}

export function meaningfulAchievements(data) {
  // The existing builder event means two project stages were approved. Other legacy
  // achievements are lesson/AI events or lack an awarding event; preserve them in storage.
  const confirmedProject = (data?.projects ?? []).some(project =>
    (project.tasks ?? []).filter(task => task.status === 'completed' && task.reviewedBy).length >= 2);
  return confirmedProject ? (data?.profile?.achievements ?? []).filter(item => item.code === 'builder' && item.earned) : [];
}

export function safeHttpsUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function safeAssetUrl(value) {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  return safeHttpsUrl(value);
}
