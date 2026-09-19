import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';
import { PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_HOMEWORK } from './seed.js';

const bindings = Object.fromEntries(PILOT_STUDENTS.map((student, index) => [student.key, String(900000001 + index)]));

describe('pilot operational data', () => {
  it('binds all four Telegram identities to separate seeded students', async () => {
    const repository = new MemoryRepository(undefined, {
      telegramBindingsJson: JSON.stringify(bindings),
      requireSeededTelegramIdentity: true
    });

    const identities = await Promise.all(PILOT_STUDENTS.map((student, index) => repository.resolveTelegramUser({
      telegramId: String(900000001 + index),
      firstName: 'Telegram name must not replace the operational profile'
    })));

    expect(identities.map(identity => identity.id)).toEqual(PILOT_STUDENTS.map(student => student.id));
    expect(new Set(identities.map(identity => identity.id)).size).toBe(4);
    await expect(repository.resolveTelegramUser({ telegramId: '999999999', firstName: 'Unknown' }))
      .rejects.toMatchObject({ code: 'TELEGRAM_ACCOUNT_NOT_LINKED', statusCode: 403 });
  });

  it('exposes the pilot curriculum, homework, Meet URL and correct name scopes', async () => {
    const repository = new MemoryRepository();
    const yuliia = PILOT_STUDENTS.find(student => student.key === 'yuliia')!;
    const studentProfile = await repository.getProfile(yuliia.id);
    const learning = await repository.getLearning(yuliia.id);
    const schedule = await repository.getSchedule(yuliia.id);
    const homework = await repository.listHomework(yuliia.id);
    const teacher = await repository.getTeacherWorkspace(PILOT_TEACHERS[0]!.id);
    const admin = await repository.getAdminWorkspace('14000000-0000-4000-8000-000000000001');

    expect(studentProfile.viewer.firstName).toBe('🐭💗 Мишка');
    expect(learning.course.totalLessons).toBe(8);
    expect(homework.map(item => item.instructions)).toEqual([...SEEDED_HOMEWORK]);
    expect(homework).toHaveLength(7);
    expect(schedule.nextClass?.meetingUrl).toBe(PILOT.meetingUrl);
    expect(schedule.upcoming).toHaveLength(8);
    expect(teacher.students.map(student => student.firstName)).toContain('Прохуренко Юлія');
    expect(admin.students.map(student => student.name)).toContain('Прохуренко Юлія');
    expect(admin.teachers.map(item => item.name)).toEqual(['Анохін Максим', 'Кривич Вадим']);
  });
});
