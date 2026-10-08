import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { MemoryPilotRuntimeStore } from './pilot-runtime-store.js';
import { DEV_IDS, PILOT, PILOT_TEACHERS } from './seed.js';
import { homeView, learningView, projectView, portfolioView, profileView, homeworkView, lessonView } from '../../src/student-views.js';
import { currentProject, projectProgress, homeworkAction, nextSession, sessionStatus, newFeedback, safeHttpsUrl, safeAssetUrl } from '../../src/student-model.js';

const student = DEV_IDS.user, teacher = PILOT_TEACHERS[1]!.id;
const fixture = () => {
  const runtime = new MemoryPilotRuntimeStore();
  return { runtime, repo: new MemoryRepository(undefined, { runtimeStore: runtime }) };
};
async function snapshot(repo: MemoryRepository) {
  const [home, learning, projects, profile, schedule, homework, portfolio, notifications] = await Promise.all([
    repo.getHome(student), repo.getLearning(student), repo.listProjects(student), repo.getProfile(student),
    repo.getSchedule(student), repo.listHomework(student), repo.getPortfolio(student), repo.listStudentNotifications(student)
  ]);
  return { home, learning, projects, profile, schedule, homework, portfolio, notifications, recoveries: [] };
}
async function classSession(repo: MemoryRepository) {
  const start = new Date(Date.now() + 7 * 86400000), end = new Date(start.getTime() + 90 * 60000);
  return repo.createClassSession(teacher, { groupId: PILOT.groupId, courseId: DEV_IDS.course,
    title: 'Заняття для перевірки', startsAt: start.toISOString(), endsAt: end.toISOString() });
}

describe('Student workspace uses Teacher-managed academic state', () => {
  it('shows honest empty states without gamified or invented student content', async () => {
    const { repo } = fixture(), data = await snapshot(repo);
    expect(homeView(data)).toContain('Проєкт ще не створено');
    expect(homeView(data)).toContain('Активних завдань немає');
    expect(projectView(data)).toContain('Створити проєкт');
    expect(learningView(data)).toContain('Занять ще немає');
    expect(portfolioView(data)).toContain('Тут з’являться твої завершені проєкти');
    expect(homeworkView(data, null)).toContain('Завдання недоступне');
    expect(lessonView(data, null)).toContain('Урок недоступний');
    for (const render of [homeView, learningView, projectView, portfolioView]) {
      expect(render(data)).not.toMatch(/\bXP\b|Level|640|Homework Helper|Юля|AI Explorer/);
    }
    expect(profileView(data)).not.toMatch(/Level|Creator|Launcher|дні серії|Критичне мислення/);
  });

  it('keeps Home and Project progress independent from XP and in sync with approval', async () => {
    const { repo, runtime } = fixture();
    const project = await repo.createProject(student, { title: 'Мій справжній продукт', summary: 'Перевіряю проблему користувача' });
    await runtime.mutate(state => { state.xp[student] = 640; });
    await repo.submitProjectTask(student, project.id, project.tasks[0]!.id, { contentText: 'Проблема конкретної людини', expectedVersion: 1 });
    const pending = await snapshot(repo);
    expect(projectProgress(currentProject(pending)).percent).toBe(0);
    expect(projectView(pending)).not.toContain('Надіслати на перевірку');
    expect(homeView(pending)).toContain('Відповідь на перевірці');
    await repo.reviewProjectTask(teacher, student, project.id, project.tasks[0]!.id,
      { expectedVersion: 2, decision: 'approved', feedback: 'Підтверджено' }, 'workspace-approval');
    const approved = await snapshot(repo);
    expect(projectProgress(currentProject(approved))).toMatchObject({ percent: 35, completed: 1, total: 4 });
    for (const render of [homeView, projectView]) {
      expect(render(approved)).toContain('35%');
      expect(render(approved)).toContain(approved.projects[0]!.stage.title);
      expect(render(approved)).not.toMatch(/\bXP\b/);
    }
  });

  it('retains returned project answers and teacher feedback instead of opening a later stage', async () => {
    const { repo } = fixture(), project = await repo.createProject(student, { title: 'Продукт', summary: '' });
    await repo.submitProjectTask(student, project.id, project.tasks[0]!.id, { contentText: 'Моя перша відповідь', expectedVersion: 1 });
    await repo.reviewProjectTask(teacher, student, project.id, project.tasks[0]!.id,
      { expectedVersion: 2, decision: 'needs_revision', feedback: 'Додай результати інтерв’ю' }, 'workspace-return');
    const data = await snapshot(repo), html = projectView(data);
    expect(html).toContain('Внести зміни');
    expect(html).toContain('Моя перша відповідь');
    expect(html).toContain('Додай результати інтерв’ю');
    expect(projectProgress(data.projects[0]).percent).toBe(0);
    expect(data.projects[0]!.tasks[1]!.status).toBe('locked');
  });

  it('reflects teacher title/time/material changes and never promotes a cancelled class', async () => {
    const { repo } = fixture(), session = await classSession(repo);
    await repo.updateTeacherClass(teacher, session.id, { title: 'Оновлена назва' });
    await repo.addClassMaterial(teacher, session.id,
      { kind: 'document', title: 'Файл викладача', url: 'https://example.org/material' });
    const start = new Date(Date.now() + 14 * 86400000), end = new Date(start.getTime() + 90 * 60000);
    await repo.rescheduleClass(teacher, session.id, { startsAt: start.toISOString(), endsAt: end.toISOString(), reason: 'Перенесення' });
    const data = await snapshot(repo), next = nextSession(data);
    expect(next).toMatchObject({ title: 'Оновлена назва', startsAt: start.toISOString(), status: 'rescheduled' });
    expect(homeView(data)).toContain('Оновлена назва');
    expect(lessonView(data, await repo.getLesson(student, session.id))).toContain('Файл викладача');
    await repo.updateTeacherClass(teacher, session.id, { status: 'cancelled' });
    const cancelled = await snapshot(repo);
    expect(nextSession(cancelled)).toBeNull();
    expect(learningView(cancelled)).not.toContain(`data-lesson="${session.id}"`);
    expect(sessionStatus({ ...session, status: 'cancelled' })).toBe('Скасовано');
  });

  it('uses homework resources and session IDs, follows review states and removes unpublished work', async () => {
    const { repo } = fixture(), session = await classSession(repo);
    const task = await repo.createHomework(teacher, { groupId: PILOT.groupId, courseId: DEV_IDS.course,
      classSessionId: session.id, title: 'Завдання викладача', instructions: 'Перевір гіпотезу', status: 'draft', xpReward: 0,
      resources: [{ kind: 'document', title: 'Шаблон дослідження', url: 'https://example.org/template' }] });
    await repo.publishHomework(teacher, task.id, new Date().toISOString());
    let data = await snapshot(repo), homework = data.homework.find(item => item.id === task.id)!;
    expect(homework.classSessionId).toBe(session.id);
    expect(homeworkView(data, homework)).toContain('Шаблон дослідження');
    expect(lessonView(data, await repo.getLesson(student, session.id))).toContain('Завдання викладача');
    expect(homeView(data)).toContain('Почати завдання');
    const submission = await repo.submitHomework(student, task.id, { contentText: 'Мій результат', studentComment: 'Перша спроба' });
    data = await snapshot(repo); homework = data.homework.find(item => item.id === task.id)!;
    expect(homeworkView(data, homework)).toContain('Очікує перевірки');
    expect(homeworkView(data, homework)).not.toContain('id="homeworkSubmit"');
    await repo.reviewHomework(teacher, submission.id, { score: 4, effort: 'high_effort', status: 'reviewed', feedback: 'Відгук без остаточного рішення' });
    data = await snapshot(repo); homework = data.homework.find(item => item.id === task.id)!;
    expect(homeworkView(data, homework)).toContain('Є відгук викладача');
    expect(homeworkView(data, homework)).not.toContain('Очікуй на перевірку');
    await repo.reviewHomework(teacher, submission.id, { score: 4, effort: 'high_effort', status: 'needs_revision', feedback: 'Потрібні докази' });
    data = await snapshot(repo); homework = data.homework.find(item => item.id === task.id)!;
    expect(homeworkAction(homework)).toBe('Внести зміни');
    expect(homeworkView(data, homework)).toContain('Мій результат</textarea>');
    expect(homeworkView(data, homework)).toContain('Потрібні докази');
    await repo.updateHomework(teacher, task.id, { expectedVersion: 2, status: 'unpublished' }, 'workspace-unpublish');
    data = await snapshot(repo);
    expect(homeView(data)).not.toContain('Завдання викладача');
    expect(learningView(data)).not.toContain('Завдання викладача');
    expect(homeworkView(data, { ...homework, withdrawn: true })).toContain('Надсилання недоступне');
  });

  it('preserves existing portfolio entries without mislabeling an active project as finished', async () => {
    const { repo } = fixture(), project = await repo.createProject(student, { title: 'Результат у роботі', summary: 'Опис' });
    await repo.addProjectToPortfolio(student, project.id, { reflection: 'Збережена рефлексія' });
    const data = await snapshot(repo);
    data.portfolio.projects[0]!.completionDate = '2026-01-01';
    const html = portfolioView(data);
    expect(html).toContain('Результат у роботі');
    expect(html).toContain('Збережена рефлексія');
    expect(html).not.toContain('>Завершено<');
    expect(html).not.toContain('data-add-portfolio');
    expect(html).not.toContain('LV 3');
  });

  it('shows the existing Builder award only when actual teacher confirmations support its description', async () => {
    const { repo, runtime } = fixture();
    await runtime.mutate(state => { state.achievements[student] = ['builder', 'first-spark', 'ai-explorer', 'demo-day']; });
    expect(profileView(await snapshot(repo))).not.toContain('Перші підтверджені етапи');
    let project = await repo.createProject(student, { title: 'Підтверджений продукт', summary: '' });
    for (let index = 0; index < 2; index++) {
      const task = project.tasks[index]!;
      await repo.submitProjectTask(student, project.id, task.id, { contentText: 'Результат етапу', expectedVersion: task.version ?? 1 });
      await repo.reviewProjectTask(teacher, student, project.id, task.id,
        { expectedVersion: (task.version ?? 1) + 1, decision: 'approved', feedback: '' }, 'workspace-award-' + index);
      project = (await repo.listProjects(student))[0]!;
    }
    const html = profileView(await snapshot(repo));
    expect(html).toContain('Перші підтверджені етапи');
    expect(html).not.toMatch(/First Spark|AI Explorer|Demo Day|2026-09-15/);
    expect((await runtime.read()).achievements[student]).toEqual(['builder', 'first-spark', 'ai-explorer', 'demo-day']);
  });
});

describe('workspace presentation does not fabricate or trust unrelated data', () => {
  it('falls back to stage counts when weighted progress cannot be verified', () => {
    expect(projectProgress({ tasks: [{ status: 'completed', weight: 50 }], completionPercent: 60 }))
      .toEqual({ percent: null, completed: 1, total: 1 });
    expect(currentProject({ projects: [{ status: 'archived', title: 'Архів' }] })).toBeNull();
  });
  it('shows new feedback only for unread notifications with a visible homework destination', () => {
    const one = { id: 'one', type: 'student_homework_reviewed', destination: { homeworkId: 'visible' }, readAt: null };
    const data = { homework: [{ id: 'visible' }], notifications: { items: [one,
      { ...one, id: 'read', readAt: '2026-01-01' }, { ...one, id: 'withdrawn', destination: { homeworkId: 'hidden' } }] } };
    expect(newFeedback(data).map(item => item.id)).toEqual(['one']);
  });
  it('escapes long Ukrainian text and rejects executable or credential-bearing links', async () => {
    const { repo } = fixture(), data = await snapshot(repo);
    data.home.viewer.firstName = '<img src=x onerror=alert(1)>ДовгеІм’я'.repeat(4);
    expect(homeView(data)).toContain('&lt;img');
    expect(homeView(data)).not.toContain('<img src=x');
    for (const url of ['javascript:alert(1)', 'http://example.org', 'https://user:password@example.org']) expect(safeHttpsUrl(url)).toBeNull();
    expect(safeAssetUrl('//example.org/cover.png')).toBeNull();
    expect(safeAssetUrl('/brand/cover.png')).toBe('/brand/cover.png');
  });
});
