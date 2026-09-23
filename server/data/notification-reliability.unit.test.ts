import { describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '../auth/session-store.js';
import { NotificationWorker, type NotificationSender } from '../services/telegram-notification-service.js';
import type { NotificationDeliveryDto } from '../types/domain.js';
import { MemoryRepository } from './memory-repository.js';
import { MemoryPilotRuntimeStore, RedisRestPilotRuntimeStore, type PilotRuntimeStore } from './pilot-runtime-store.js';
import { PILOT, PILOT_TEACHERS, SEEDED_LESSONS } from './seed.js';

const ADMIN = '14000000-0000-4000-8000-000000000001';
const TEACHER = PILOT_TEACHERS[0]!.id;
const COURSE = '20000000-0000-4000-8000-000000000001';
const HOUR = 3_600_000;
const DAY = 86_400_000;

class CaptureSender implements NotificationSender {
  readonly deliveries: NotificationDeliveryDto[] = [];
  failures = 0;
  constructor(private readonly mode: 'ok' | 'fail' = 'ok') {}
  async send(notification: NotificationDeliveryDto) {
    this.deliveries.push(notification);
    if (this.mode === 'fail') { this.failures += 1; return { sent: false as const, errorCode: 'TELEGRAM_TEMPORARY', retryable: true }; }
    return { sent: true as const };
  }
  typesFor(userId: string) { return this.deliveries.filter(item => item.recipientUserId === userId).map(item => item.type); }
}

/** Upstash REST stand-in so catch-up can be exercised against the production-equivalent CAS store. */
class UpstashRestEmulator {
  readonly strings = new Map<string, string>();
  fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const command = JSON.parse(String(init?.body)) as string[];
    const op = command[0]?.toUpperCase();
    if (op === 'GET') return Response.json({ result: this.strings.get(command[1]!) ?? null });
    if (op === 'SET') { this.strings.set(command[1]!, command[2]!); return Response.json({ result: 'OK' }); }
    if (op === 'EVAL') {
      const script = command[1] ?? '';
      if (script.includes("redis.call('EXISTS', KEYS[1]) == 0")) {
        const key = command[3]!;
        if (!this.strings.has(key)) this.strings.set(key, command[4]!);
        return Response.json({ result: this.strings.get(key)! });
      }
      if (script.includes('current ~= ARGV[1]')) {
        const [key, current, next] = [command[3]!, command[4]!, command[5]!];
        if (this.strings.get(key) !== current) return Response.json({ result: 0 });
        this.strings.set(key, next);
        return Response.json({ result: 1 });
      }
    }
    return Response.json({ error: `unsupported ${op}` }, { status: 400 });
  };
}

async function fixture(store?: PilotRuntimeStore) {
  const runtime = store ?? new MemoryPilotRuntimeStore();
  const repository = new MemoryRepository(undefined, { runtimeStore: runtime, sessionStore: new MemorySessionStore(), requireSeededTelegramIdentity: true });
  const student = await repository.adminCreateStudent(ADMIN, { firstName: 'Реальний', lastName: 'Учень', groupId: PILOT.groupId, telegramId: '777001001', status: 'active' }, 'c1');
  const guardian = await repository.adminCreateGuardian(ADMIN, { firstName: 'Реальна', lastName: 'Мама', telegramId: '777001002', studentIds: [String(student.id)], status: 'active' }, 'c2');
  // Production syncs the directory in the auth middleware before any handler runs; do the same here.
  await repository.getAdminWorkspace(ADMIN);
  return { runtime, repository, studentId: String(student.id), guardianId: String(guardian.id) };
}

async function reasonsFor(runtime: PilotRuntimeStore, type: string) {
  return (await runtime.read()).notifications.filter(item => item.type === type).map(item => ({ status: item.status, reason: item.errorCode }));
}

describe('catch-up: a late worker still delivers what is still relevant', () => {
  async function scenario(delayHours: number) {
    const { repository, runtime, studentId, guardianId } = await fixture();
    const t0 = new Date();
    // A lesson tomorrow, homework published now with a deadline in three days, one absence.
    const session = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття', lessonId: SEEDED_LESSONS[0]!.id,
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const homework = await repository.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'ДЗ', instructions: 'зроби',
      publishAt: t0.toISOString(), dueAt: new Date(t0.getTime() + 3 * DAY).toISOString(), xpReward: 10, status: 'published'
    });
    const past = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Минуле заняття',
      startsAt: new Date(t0.getTime() - 2 * HOUR).toISOString(), endsAt: new Date(t0.getTime() - HOUR).toISOString()
    });
    await repository.confirmAttendance(TEACHER, past.id, studentId, 'absent');

    const sender = new CaptureSender();
    const worker = new NotificationWorker(repository, sender, 0, 19);
    const result = await worker.run(new Date(t0.getTime() + delayHours * HOUR));
    return { sender, result, studentId, guardianId, runtime, sessionId: session.id, homeworkId: homework.id };
  }

  it('worker +5 minutes delivers everything due', async () => {
    const { sender, studentId, guardianId } = await scenario(5 / 60);
    expect(sender.typesFor(studentId)).toEqual(expect.arrayContaining(['student_class_24h', 'student_homework_assigned']));
    expect(sender.typesFor(guardianId)).toContain('guardian_absent_lesson');
  });

  it('worker +3 hours still delivers them — the old 2h window no longer drops events', async () => {
    const { sender, studentId, guardianId } = await scenario(3);
    expect(sender.typesFor(studentId)).toEqual(expect.arrayContaining(['student_class_24h', 'student_homework_assigned']));
    expect(sender.typesFor(guardianId)).toContain('guardian_absent_lesson');
  });

  it('worker +24 hours keeps what is still meaningful and drops what is not', async () => {
    const { sender, studentId, guardianId, sessionId } = await scenario(24);
    // This lesson has now started, so "tomorrow you have a lesson" is correctly withheld for it.
    expect(sender.deliveries.some(item => item.type === 'student_class_24h' && item.relatedEntityId === sessionId)).toBe(false);
    // Homework is still open and the absence still matters, so both are delivered late.
    expect(sender.typesFor(studentId)).toContain('student_homework_assigned');
    expect(sender.typesFor(guardianId)).toContain('guardian_absent_lesson');
  });

  it('records why an expired reminder was withheld', async () => {
    const { runtime } = await scenario(24);
    const reasons = await reasonsFor(runtime, 'student_class_24h');
    // Either never queued (window already shut) or queued and skipped with a stated reason.
    for (const entry of reasons) expect(entry.status === 'skipped' ? entry.reason : 'REMINDER_WINDOW_EXPIRED').toBe('REMINDER_WINDOW_EXPIRED');
  });

  it('a 1h reminder is catchable until the lesson starts and never after', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Скоро',
      startsAt: new Date(t0.getTime() + HOUR).toISOString(), endsAt: new Date(t0.getTime() + 2 * HOUR).toISOString()
    });
    const early = new CaptureSender();
    await new NotificationWorker(repository, early, 0, 19).run(new Date(t0.getTime() + 30 * 60_000));
    expect(early.typesFor(studentId)).toContain('student_class_1h');

    const { repository: r2, studentId: s2 } = await fixture();
    await r2.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Скоро',
      startsAt: new Date(t0.getTime() + HOUR).toISOString(), endsAt: new Date(t0.getTime() + 2 * HOUR).toISOString()
    });
    const late = new CaptureSender();
    await new NotificationWorker(r2, late, 0, 19).run(new Date(t0.getTime() + 2 * HOUR));
    expect(late.typesFor(s2)).not.toContain('student_class_1h');
  });
});

describe('duplicate worker invocation', () => {
  it('two runs at the same instant never send the same message twice', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const sender = new CaptureSender();
    const worker = new NotificationWorker(repository, sender, 0, 19);
    const first = await worker.run(t0);
    const second = await worker.run(t0);
    expect(first.sent).toBeGreaterThan(0);
    expect(second).toEqual({ claimed: 0, sent: 0, failed: 0 });
    const keys = sender.deliveries.map(item => `${item.type}:${item.relatedEntityId}:${item.recipientUserId}`);
    expect(keys.length).toBe(new Set(keys).size);
    expect(sender.typesFor(studentId).filter(type => type === 'student_class_24h')).toHaveLength(1);
  });

  it('two runs interleaved in parallel still claim each message once', async () => {
    const { repository } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const [a, b] = await Promise.all([
      repository.prepareNotificationBatch(t0, 0, 19, 50),
      repository.prepareNotificationBatch(t0, 0, 19, 50)
    ]);
    const ids = [...a, ...b].map(item => item.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('rescheduled and cancelled classes', () => {
  it('never sends a reminder carrying the old time after a reschedule', async () => {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    const originalStart = new Date(t0.getTime() + DAY);
    const session = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: originalStart.toISOString(), endsAt: new Date(originalStart.getTime() + HOUR).toISOString()
    });
    // Queue the reminder, but hold delivery back by failing the send.
    const holding = new CaptureSender('fail');
    await new NotificationWorker(repository, holding, 0, 19).run(t0);
    expect(holding.typesFor(studentId)).toContain('student_class_24h');

    const newStart = new Date(t0.getTime() + 8 * DAY);
    await repository.rescheduleClass(TEACHER, session.id, { startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + HOUR).toISOString() });

    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    const stale = after.deliveries.filter(item => item.type === 'student_class_24h' && item.text.includes('05.10'));
    expect(stale).toHaveLength(0);
    const skipped = (await runtime.read()).notifications.filter(item => item.type === 'student_class_24h' && item.status === 'skipped');
    expect(skipped.map(item => item.errorCode)).toContain('CLASS_RESCHEDULED');
  });

  it('issues a correctly timed reminder for the new slot, without duplicating', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    const session = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const sender = new CaptureSender();
    const worker = new NotificationWorker(repository, sender, 0, 19);
    await worker.run(t0);

    const newStart = new Date(t0.getTime() + 3 * DAY);
    await repository.rescheduleClass(TEACHER, session.id, { startsAt: newStart.toISOString(), endsAt: new Date(newStart.getTime() + HOUR).toISOString() });
    // 24h before the new slot the replacement reminder goes out, exactly once.
    await worker.run(new Date(newStart.getTime() - DAY));
    const reminders = sender.deliveries.filter(item => item.type === 'student_class_24h' && item.relatedEntityId === session.id);
    expect(reminders).toHaveLength(2);
    const expectedDay = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' }).format(newStart);
    expect(reminders.at(-1)!.text).toContain(expectedDay);
    expect(sender.typesFor(studentId).filter(type => type === 'student_class_24h')).toHaveLength(2);
  });

  it('withholds the ordinary reminder for a cancelled class but still tells the guardian', async () => {
    const { repository, runtime, studentId, guardianId } = await fixture();
    const t0 = new Date();
    const session = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const holding = new CaptureSender('fail');
    await new NotificationWorker(repository, holding, 0, 19).run(t0);
    await repository.updateTeacherClass(TEACHER, session.id, { status: 'cancelled' });

    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(after.typesFor(studentId)).not.toContain('student_class_24h');
    expect(after.typesFor(guardianId)).toContain('guardian_session_cancelled');
    const skipped = (await runtime.read()).notifications.filter(item => item.type === 'student_class_24h' && item.status === 'skipped');
    expect(skipped.map(item => item.errorCode)).toContain('CLASS_CANCELLED');
  });
});

describe('homework reminders respect current submission state', () => {
  async function queuedDeadline() {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    const homework = await repository.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'ДЗ', instructions: 'зроби',
      publishAt: new Date(t0.getTime() - DAY).toISOString(), dueAt: new Date(t0.getTime() + 12 * HOUR).toISOString(),
      xpReward: 10, status: 'published'
    });
    const holding = new CaptureSender('fail');
    await new NotificationWorker(repository, holding, 0, 19).run(t0);
    expect(holding.typesFor(studentId)).toContain('student_homework_deadline');
    return { repository, runtime, studentId, homeworkId: homework.id, t0 };
  }

  it('suppresses a queued deadline reminder once the work is submitted', async () => {
    const { repository, runtime, studentId, homeworkId, t0 } = await queuedDeadline();
    await repository.submitHomework(studentId, homeworkId, { contentText: 'готово' });
    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(after.typesFor(studentId)).not.toContain('student_homework_deadline');
    expect((await reasonsFor(runtime, 'student_homework_deadline')).map(item => item.reason)).toContain('HOMEWORK_ALREADY_SUBMITTED');
  });

  it('suppresses it once the work has been reviewed', async () => {
    const { repository, runtime, studentId, homeworkId, t0 } = await queuedDeadline();
    const submission = await repository.submitHomework(studentId, homeworkId, { contentText: 'готово' });
    await repository.reviewHomework(TEACHER, submission.id, { score: 9, effort: 'high_effort', status: 'completed', feedback: 'добре' });
    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(after.typesFor(studentId)).not.toContain('student_homework_deadline');
    expect((await reasonsFor(runtime, 'student_homework_deadline')).map(item => item.reason)).toContain('HOMEWORK_ALREADY_REVIEWED');
  });

  it('never queues a deadline reminder for work that is already in', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    const homework = await repository.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'ДЗ', instructions: 'зроби',
      publishAt: new Date(t0.getTime() - DAY).toISOString(), dueAt: new Date(t0.getTime() + 12 * HOUR).toISOString(),
      xpReward: 10, status: 'published'
    });
    await repository.submitHomework(studentId, homework.id, { contentText: 'готово' });
    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(t0);
    expect(sender.typesFor(studentId)).not.toContain('student_homework_deadline');
  });

  it('sends overdue only while the work is genuinely missing', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    await repository.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Прострочене', instructions: 'зроби',
      publishAt: new Date(t0.getTime() - 3 * DAY).toISOString(), dueAt: new Date(t0.getTime() - HOUR).toISOString(),
      xpReward: 10, status: 'published'
    });
    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(t0);
    expect(sender.typesFor(studentId)).toContain('student_homework_overdue');

    const { repository: r2, studentId: s2 } = await fixture();
    const homework = await r2.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Здане', instructions: 'зроби',
      publishAt: new Date(t0.getTime() - 3 * DAY).toISOString(), dueAt: new Date(t0.getTime() - HOUR).toISOString(),
      xpReward: 10, status: 'published'
    });
    await r2.submitHomework(s2, homework.id, { contentText: 'встиг' });
    const quiet = new CaptureSender();
    await new NotificationWorker(r2, quiet, 0, 19).run(t0);
    expect(quiet.typesFor(s2)).not.toContain('student_homework_overdue');
  });
});

describe('weekly digest follows the persistent directory', () => {
  const sunday19Kyiv = new Date('2026-10-11T16:00:00.000Z');

  it('reaches a student created through Admin, with no dependency on the seeded pilot list', async () => {
    const { repository, studentId, guardianId } = await fixture();
    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(sunday19Kyiv);
    const digest = sender.deliveries.find(item => item.recipientUserId === guardianId && item.type === 'guardian_weekly_digest');
    expect(digest).toBeDefined();
    expect(digest!.text).toContain('Реальний');
    expect(digest!.callbackData).toBe(`parent:student:${studentId}`);
  });

  it('generates teacher reports for Admin-created students too', async () => {
    const { repository, runtime, studentId } = await fixture();
    await repository.generateTeacherReports(TEACHER, PILOT.groupId, '2026-10-05', '2026-10-11');
    const reports = (await runtime.read()).teacherReports;
    expect(reports.some(report => report.studentId === studentId)).toBe(true);
    expect(reports.find(report => report.studentId === studentId)!.studentFirstName).toContain('Реальний');
  });

  it('covers one guardian with several children, and several guardians of one child', async () => {
    const { repository, studentId, guardianId } = await fixture();
    const second = await repository.adminCreateStudent(ADMIN, { firstName: 'Друга', lastName: 'Дитина', groupId: PILOT.groupId, telegramId: '777001003', status: 'active' }, 'c3');
    await repository.adminLinkGuardian(ADMIN, guardianId, String(second.id), 'c4');
    const otherGuardian = await repository.adminCreateGuardian(ADMIN, { firstName: 'Другий', lastName: 'Батько', telegramId: '777001004', studentIds: [studentId], status: 'active' }, 'c5');

    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(sunday19Kyiv);
    const digests = sender.deliveries.filter(item => item.type === 'guardian_weekly_digest');
    expect(digests.filter(item => item.recipientUserId === guardianId)).toHaveLength(2);
    expect(digests.filter(item => item.recipientUserId === String(otherGuardian.id))).toHaveLength(1);
  });

  it('excludes an archived student and a revoked relation', async () => {
    const { repository, studentId, guardianId } = await fixture();
    const archived = await repository.adminCreateStudent(ADMIN, { firstName: 'Архівна', lastName: 'Дитина', groupId: PILOT.groupId, telegramId: '777001005', status: 'active' }, 'c6');
    await repository.adminLinkGuardian(ADMIN, guardianId, String(archived.id), 'c7');
    await repository.adminSetAccountStatus(ADMIN, String(archived.id), 'archived', 'left the school', 'c8');
    await repository.adminUnlinkGuardian(ADMIN, guardianId, studentId, 'c9');

    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(sunday19Kyiv);
    expect(sender.deliveries.filter(item => item.type === 'guardian_weekly_digest')).toHaveLength(0);
  });

  it('skips a guardian with no Telegram binding', async () => {
    const { repository } = await fixture();
    const student = await repository.adminCreateStudent(ADMIN, { firstName: 'Тиха', lastName: 'Дитина', groupId: PILOT.groupId, telegramId: '777001006', status: 'active' }, 'c10');
    const silent = await repository.adminCreateGuardian(ADMIN, { firstName: 'Без', lastName: 'Телеграма', studentIds: [String(student.id)], status: 'active' }, 'c11');
    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(sunday19Kyiv);
    expect(sender.deliveries.some(item => item.recipientUserId === String(silent.id))).toBe(false);
  });

  it('survives a scheduler that is hours late', async () => {
    for (const lateHours of [3, 10, 30]) {
      const { repository, guardianId } = await fixture();
      const worker = new NotificationWorker(repository, new CaptureSender(), 0, 19);
      // A running scheduler, then an outage that spans the digest instant, then recovery.
      await worker.run(new Date(sunday19Kyiv.getTime() - HOUR));
      const sender = new CaptureSender();
      await new NotificationWorker(repository, sender, 0, 19).run(new Date(sunday19Kyiv.getTime() + lateHours * HOUR));
      const digest = sender.deliveries.find(item => item.recipientUserId === guardianId && item.type === 'guardian_weekly_digest');
      expect(digest, `digest lost when the worker was ${lateHours}h late`).toBeDefined();
    }
  });

  it('stops catching up once the digest is genuinely stale', async () => {
    const { repository, guardianId } = await fixture();
    const sender = new CaptureSender();
    await new NotificationWorker(repository, sender, 0, 19).run(new Date(sunday19Kyiv.getTime() + 5 * DAY));
    expect(sender.deliveries.some(item => item.recipientUserId === guardianId && item.type === 'guardian_weekly_digest')).toBe(false);
  });
});

describe('recipient state at delivery time', () => {
  it('uses the current Telegram binding, never the one captured at queue time', async () => {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const holding = new CaptureSender('fail');
    await new NotificationWorker(repository, holding, 0, 19).run(t0);
    expect(holding.deliveries.find(item => item.recipientUserId === studentId)!.recipientTelegramId).toBe('777001001');

    const version = (await runtime.read()).directory[studentId]!.version;
    await repository.adminSetTelegramBinding(ADMIN, studentId, '777009999', version, 'c-rebind');
    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    const resent = after.deliveries.find(item => item.recipientUserId === studentId);
    expect(resent?.recipientTelegramId).toBe('777009999');
  });

  it('stops delivering to a deactivated recipient and says why', async () => {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const holding = new CaptureSender('fail');
    await new NotificationWorker(repository, holding, 0, 19).run(t0);
    await repository.adminSetAccountStatus(ADMIN, studentId, 'disabled', 'paused', 'c-off');

    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(after.deliveries.some(item => item.recipientUserId === studentId)).toBe(false);
    expect((await reasonsFor(runtime, 'student_class_24h')).map(item => item.reason)).toContain('RECIPIENT_INACTIVE');
  });

  it('stops guardian messages once the relation is revoked', async () => {
    const { repository, runtime, studentId, guardianId } = await fixture();
    const t0 = new Date();
    const past = await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Минуле',
      startsAt: new Date(t0.getTime() - 2 * HOUR).toISOString(), endsAt: new Date(t0.getTime() - HOUR).toISOString()
    });
    await repository.confirmAttendance(TEACHER, past.id, studentId, 'absent');
    const holding = new CaptureSender('fail');
    // The attendance record is stamped as it is written, so the run must be after that instant.
    await new NotificationWorker(repository, holding, 0, 19).run(new Date(t0.getTime() + 60_000));
    expect(holding.typesFor(guardianId)).toContain('guardian_absent_lesson');

    await repository.adminUnlinkGuardian(ADMIN, guardianId, studentId, 'c-unlink');
    const after = new CaptureSender();
    await new NotificationWorker(repository, after, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(after.deliveries.some(item => item.recipientUserId === guardianId)).toBe(false);
    expect((await reasonsFor(runtime, 'guardian_absent_lesson')).map(item => item.reason)).toContain('GUARDIAN_RELATION_REVOKED');
  });
});

describe('delivery failures', () => {
  it('retries safely with backoff and stops at the attempt cap', async () => {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const sender = new CaptureSender('fail');
    const worker = new NotificationWorker(repository, sender, 0, 19);
    // Backoff is 5/10/20/40/80 minutes, so six passes 90 minutes apart exhaust the attempt cap
    // while the lesson is still a day away and the reminder is therefore still relevant.
    let at = t0;
    for (let index = 0; index < 6; index += 1) {
      await worker.run(at);
      at = new Date(at.getTime() + 90 * 60_000);
    }
    const record = (await runtime.read()).notifications.find(item => item.type === 'student_class_24h' && item.recipientUserId === studentId);
    expect(record?.attempts).toBeLessThanOrEqual(5);
    expect(record?.status).toBe('failed');
    expect(record?.errorCode).toBe('TELEGRAM_TEMPORARY');
    // Retries never duplicate: every attempt targets the same queued record.
    const attemptsForRecord = sender.deliveries.filter(item => item.id === record!.id);
    expect(attemptsForRecord.length).toBe(record!.attempts);
    expect(new Set(attemptsForRecord.map(item => item.id)).size).toBe(1);
  });

  it('a recovered Telegram delivers the still-relevant message on the next run', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString()
    });
    const failing = new CaptureSender('fail');
    await new NotificationWorker(repository, failing, 0, 19).run(t0);
    const recovered = new CaptureSender();
    const result = await new NotificationWorker(repository, recovered, 0, 19).run(new Date(t0.getTime() + 11 * 60_000));
    expect(result.sent).toBeGreaterThan(0);
    expect(recovered.typesFor(studentId)).toContain('student_class_24h');
  });
});

describe('production-equivalent Upstash store', () => {
  it('catches up across a scheduler outage and stays idempotent through CAS', async () => {
    const redis = new UpstashRestEmulator();
    vi.stubGlobal('fetch', redis.fetch);
    try {
      const store = new RedisRestPilotRuntimeStore('https://upstash.test', 'token', 'aiss:production:sessions:v1:pilot-runtime:v1', { bootstrapPolicy: 'seed' });
      const { repository, studentId, guardianId } = await fixture(store);
      const t0 = new Date();
      await repository.createHomework(TEACHER, {
        groupId: PILOT.groupId, courseId: COURSE, title: 'ДЗ', instructions: 'зроби',
        publishAt: t0.toISOString(), dueAt: new Date(t0.getTime() + 3 * DAY).toISOString(), xpReward: 10, status: 'published'
      });
      const past = await repository.createClassSession(TEACHER, {
        groupId: PILOT.groupId, courseId: COURSE, title: 'Минуле',
        startsAt: new Date(t0.getTime() - 2 * HOUR).toISOString(), endsAt: new Date(t0.getTime() - HOUR).toISOString()
      });
      await repository.confirmAttendance(TEACHER, past.id, studentId, 'absent');

      // The scheduler misses its window entirely and only fires six hours later.
      const sender = new CaptureSender();
      const worker = new NotificationWorker(repository, sender, 0, 19);
      const late = await worker.run(new Date(t0.getTime() + 6 * HOUR));
      expect(late.sent).toBeGreaterThan(0);
      expect(sender.typesFor(studentId)).toContain('student_homework_assigned');
      expect(sender.typesFor(guardianId)).toContain('guardian_absent_lesson');

      // A second fire in the same hour changes nothing.
      const repeat = await worker.run(new Date(t0.getTime() + 6 * HOUR + 60_000));
      expect(repeat).toEqual({ claimed: 0, sent: 0, failed: 0 });

      const state = await store.read();
      expect(state.notificationRuntime.lastRunAt).toBeTruthy();
      const keys = state.notifications.map(item => item.idempotencyKey);
      expect(keys.length).toBe(new Set(keys).size);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('observability', () => {
  it('surfaces a skip reason and the worker heartbeat to an administrator', async () => {
    const { repository, studentId } = await fixture();
    const t0 = new Date();
    const homework = await repository.createHomework(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'ДЗ', instructions: 'зроби',
      publishAt: new Date(t0.getTime() - DAY).toISOString(), dueAt: new Date(t0.getTime() + 12 * HOUR).toISOString(),
      xpReward: 10, status: 'published'
    });
    await new NotificationWorker(repository, new CaptureSender('fail'), 0, 19).run(t0);
    await repository.submitHomework(studentId, homework.id, { contentText: 'готово' });
    await new NotificationWorker(repository, new CaptureSender(), 0, 19).run(new Date(t0.getTime() + 11 * 60_000));

    const workspace = await repository.getAdminWorkspace(ADMIN);
    const skipped = workspace.notifications.find(item => item.category === 'student_homework_deadline' && item.status === 'skipped');
    expect(skipped?.reason).toBe('HOMEWORK_ALREADY_SUBMITTED');
    expect(workspace.health.notificationWorker).toBeDefined();
    expect(workspace.health.notificationWorker!.label).toMatch(/запуск|мовчить|жодного/);
  });

  it('never records a secret in a notification row', async () => {
    const { repository, runtime, studentId } = await fixture();
    const t0 = new Date();
    await repository.createClassSession(TEACHER, {
      groupId: PILOT.groupId, courseId: COURSE, title: 'Заняття',
      startsAt: new Date(t0.getTime() + DAY).toISOString(), endsAt: new Date(t0.getTime() + DAY + HOUR).toISOString(),
      meetingUrl: 'https://meet.example.test/room'
    });
    await new NotificationWorker(repository, new CaptureSender('fail'), 0, 19).run(t0);
    const serialized = JSON.stringify((await runtime.read()).notifications);
    for (const forbidden of ['botToken', 'CRON_SECRET', 'passwordHash', 'refreshToken', 'UPSTASH', 'Bearer ']) {
      expect(serialized, `leaked ${forbidden}`).not.toContain(forbidden);
    }
    expect(serialized).toContain(studentId);
  });
});
