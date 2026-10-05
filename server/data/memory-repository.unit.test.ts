import {createAssignedRepository} from './assigned-pilot.test-fixture.js';
import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS, PILOT_TEACHERS, SEEDED_LESSONS } from './seed.js';

describe('student domain invariants', () => {
  it('maps repeat Telegram logins to one internal user', async () => {
    const repository = createAssignedRepository();
    const identity = { telegramId: '998877', firstName: 'Оля', languageCode: 'uk' };
    const first = await repository.resolveTelegramUser(identity);
    const second = await repository.resolveTelegramUser(identity);
    expect(second.id).toBe(first.id);
  });
  it('awards lesson XP only once even with different retries', async () => {
    const repository = createAssignedRepository();
    const before = (await repository.getHome(DEV_IDS.user)).viewer.xp;
    const first = await repository.completeLesson(DEV_IDS.user, SEEDED_LESSONS[0]!.id, 'complete-attempt-1');
    const second = await repository.completeLesson(DEV_IDS.user, SEEDED_LESSONS[0]!.id, 'complete-attempt-2');
    expect(first.awardedXp).toBe(0);
    const lesson=(await repository.getLearning(DEV_IDS.user)).modules[0]!.lessons[0]!;
    expect(lesson.completionReview?.status).toBe('pending_review');
    await repository.reviewLessonCompletion(PILOT_TEACHERS[1]!.id,lesson.id,DEV_IDS.user,{expectedVersion:1,decision:'approved',feedback:''},'approve');
    await expect(repository.reviewLessonCompletion(PILOT_TEACHERS[1]!.id,lesson.id,DEV_IDS.user,{expectedVersion:1,decision:'approved',feedback:''},'duplicate')).rejects.toMatchObject({statusCode:409});
    expect(second.awardedXp).toBe(0);
    expect((await repository.getHome(DEV_IDS.user)).viewer.xp).toBe(before + 80);
  });
  it('awards a data-driven achievement when a new student completes a lesson', async () => {
    const repository = createAssignedRepository();
    const student = await repository.resolveTelegramUser({ telegramId: '445566', firstName: 'Леся' });
    const result = await repository.completeLesson(student.id, SEEDED_LESSONS[0]!.id, 'first-lesson-completion');
    const lesson=(await repository.getLearning(student.id)).modules[0]!.lessons[0]!;
    await repository.reviewLessonCompletion(PILOT_TEACHERS[1]!.id,lesson.id,student.id,{expectedVersion:1,decision:'approved',feedback:''},'approve');
    const achievements = await repository.listAchievements(student.id);
    expect(result.awardedXp).toBe(0);
    expect(achievements.find(item => item.code === 'first-spark')?.earned).toBe(true);
  });
  it('derives project completion from completed task weights', async () => {
    const repository = createAssignedRepository();
    const project = await repository.createProject(DEV_IDS.user, { title: 'Пілотний продукт', summary: 'Перша версія' });
    const current = project.tasks.find(task => task.status === 'in_progress')!;
    await expect(repository.completeProjectTask(DEV_IDS.user,project.id,current.id,'project-task-attempt-1')).rejects.toMatchObject({statusCode:409});
    await repository.submitProjectTask(DEV_IDS.user,project.id,current.id,{contentText:'A real problem',expectedVersion:1});
    expect((await repository.listProjects(DEV_IDS.user))[0]?.completionPercent).toBe(0);
    await repository.reviewProjectTask(PILOT_TEACHERS[1]!.id,DEV_IDS.user,project.id,current.id,{expectedVersion:2,decision:'approved',feedback:''},'approve');
    const result=(await repository.listProjects(DEV_IDS.user))[0]!;
    expect(result.completionPercent).toBe(35);expect(result.tasks[1]?.status).toBe('in_progress');
  });
  it('does not expose another student conversation', async () => {
    const repository = createAssignedRepository();
    const other = await repository.resolveTelegramUser({ telegramId: '112233', firstName: 'Іра' });
    expect(await repository.getConversation(other.id, DEV_IDS.conversation)).toBeNull();
  });
});
