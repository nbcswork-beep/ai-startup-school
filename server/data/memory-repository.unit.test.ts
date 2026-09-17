import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { DEV_IDS, SEEDED_LESSONS } from './seed.js';

describe('student domain invariants', () => {
  it('maps repeat Telegram logins to one internal user', async () => {
    const repository = new MemoryRepository();
    const identity = { telegramId: '998877', firstName: 'Оля', languageCode: 'uk' };
    const first = await repository.resolveTelegramUser(identity);
    const second = await repository.resolveTelegramUser(identity);
    expect(second.id).toBe(first.id);
  });
  it('awards lesson XP only once even with different retries', async () => {
    const repository = new MemoryRepository();
    const before = (await repository.getHome(DEV_IDS.user)).viewer.xp;
    const first = await repository.completeLesson(DEV_IDS.user, SEEDED_LESSONS[2]!.id, 'complete-attempt-1');
    const second = await repository.completeLesson(DEV_IDS.user, SEEDED_LESSONS[2]!.id, 'complete-attempt-2');
    expect(first.awardedXp).toBe(120);
    expect(second.awardedXp).toBe(0);
    expect(second.home.viewer.xp).toBe(before + 120);
  });
  it('awards a data-driven achievement when a new student completes a lesson', async () => {
    const repository = new MemoryRepository();
    const student = await repository.resolveTelegramUser({ telegramId: '445566', firstName: 'Леся' });
    const result = await repository.completeLesson(student.id, SEEDED_LESSONS[0]!.id, 'first-lesson-completion');
    const achievements = await repository.listAchievements(student.id);
    expect(result.awardedXp).toBe(80);
    expect(achievements.find(item => item.code === 'first-spark')?.earned).toBe(true);
  });
  it('derives project completion from completed task weights', async () => {
    const repository = new MemoryRepository();
    const project = (await repository.listProjects(DEV_IDS.user))[0]!;
    const current = project.tasks.find(task => task.status === 'in_progress')!;
    const result = await repository.completeProjectTask(DEV_IDS.user, project.id, current.id, 'project-task-attempt-1');
    expect(result?.awardedXp).toBe(160);
    expect(result?.project.completionPercent).toBe(80);
    expect(result?.project.tasks[3]?.status).toBe('in_progress');
  });
  it('does not expose another student conversation', async () => {
    const repository = new MemoryRepository();
    const other = await repository.resolveTelegramUser({ telegramId: '112233', firstName: 'Іра' });
    expect(await repository.getConversation(other.id, DEV_IDS.conversation)).toBeNull();
  });
});
