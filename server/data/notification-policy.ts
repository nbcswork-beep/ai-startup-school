import type { PilotNotification, PilotRuntimeState } from './pilot-runtime-store.js';

/**
 * Safe, non-identifying reason codes stored on a notification so an administrator can tell why a
 * message was not delivered. They never carry credentials or Telegram API payloads.
 */
export type NotificationSkipReason =
  | 'REMINDER_WINDOW_EXPIRED'
  | 'CLASS_CANCELLED'
  | 'CLASS_RESCHEDULED'
  | 'HOMEWORK_ALREADY_SUBMITTED'
  | 'HOMEWORK_ALREADY_REVIEWED'
  | 'HOMEWORK_RESCHEDULED'
  | 'RECIPIENT_INACTIVE'
  | 'TELEGRAM_BINDING_MISSING'
  | 'GUARDIAN_RELATION_REVOKED'
  | 'STUDENT_INACTIVE'
  | 'ENTITY_MISSING'
  | 'STALE_UNVERIFIED';

/** Types whose message text embeds a mutable time and therefore must be stamp-verified before sending. */
const STAMPED_TYPES = new Set([
  'student_class_24h', 'student_class_1h',
  'student_homework_assigned', 'student_homework_deadline', 'student_homework_overdue'
]);

export function requiresEntityStamp(type: string): boolean {
  return STAMPED_TYPES.has(type);
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/**
 * How far back a run may reach when it has no watermark yet (first ever run, or a state restored
 * from backup). Bounded so a cold start never floods the queue with historic events.
 */
export const FIRST_RUN_LOOKBACK_MS = DAY;

/** Hard cap on catch-up reach, so a scheduler outage measured in weeks cannot resurrect old events. */
export const MAX_CATCH_UP_MS = 7 * DAY;

/**
 * Grace added behind the last run. Absorbs backdated events (homework published with an earlier
 * publishAt) and events landing in the same instant as a previous pass, both of which a strict
 * watermark would drop forever.
 */
export const CATCH_UP_OVERLAP_MS = 6 * HOUR;

/**
 * Per-type relevance window.
 *
 * `dueAt` is when the message should have gone out; `expiresAt` is the moment after which sending
 * it would be wrong rather than merely late. A worker that runs late still delivers anything whose
 * window is open, which is what makes catch-up safe: lateness alone never drops a message, and
 * staleness alone never sends a misleading one.
 */
export interface NotificationWindow {
  dueAt: number;
  expiresAt: number;
}

export function classReminderWindow(startsAt: string, kind: '24h' | '1h'): NotificationWindow {
  const start = Date.parse(startsAt);
  return kind === '24h'
    // "Tomorrow you have a lesson" stops being true once the lesson is within the hour.
    ? { dueAt: start - 24 * HOUR, expiresAt: start - HOUR }
    // "Starting in an hour" is only catchable until the lesson actually begins.
    : { dueAt: start - HOUR, expiresAt: start };
}

export function homeworkAssignedWindow(publishAt: string, dueAt: string | null): NotificationWindow {
  const published = Date.parse(publishAt);
  return { dueAt: published, expiresAt: dueAt ? Date.parse(dueAt) : published + 7 * DAY };
}

export function homeworkDeadlineWindow(due: string): NotificationWindow {
  const deadline = Date.parse(due);
  // Catch-up is allowed for as long as the deadline itself is still ahead.
  return { dueAt: deadline - 24 * HOUR, expiresAt: deadline };
}

export function homeworkOverdueWindow(due: string): NotificationWindow {
  const deadline = Date.parse(due);
  return { dueAt: deadline, expiresAt: deadline + 7 * DAY };
}

export function reviewedWindow(reviewedAt: string): NotificationWindow {
  const at = Date.parse(reviewedAt);
  return { dueAt: at, expiresAt: at + 7 * DAY };
}

export function absenceWindow(confirmedAt: string): NotificationWindow {
  const at = Date.parse(confirmedAt);
  return { dueAt: at, expiresAt: at + 3 * DAY };
}

export function sessionChangeWindow(changedAt: string, startsAt: string): NotificationWindow {
  const at = Date.parse(changedAt);
  // Telling a parent about a change is pointless once the lesson slot has passed, but a change made
  // at the last minute still deserves a couple of hours of delivery room.
  return { dueAt: at, expiresAt: Math.max(Date.parse(startsAt), at + 2 * HOUR) };
}

export function weeklyDigestWindow(dueAt: number): NotificationWindow {
  // A weekly summary must survive a scheduler that is hours late.
  return { dueAt, expiresAt: dueAt + 2 * DAY };
}

/**
 * Fingerprint of the entity a notification was built from. If the entity moves, the queued message
 * no longer describes reality, so the stored copy is discarded rather than delivered with a stale
 * time. The replacement is enqueued under a new idempotency key that embeds the same stamp.
 */
export function entityStamp(state: PilotRuntimeState, type: string, relatedEntityId: string | null): string | null {
  if (!relatedEntityId) return null;
  if (type.startsWith('student_class_') || type.startsWith('guardian_session_')) {
    const session = state.classSessions.find(item => item.id === relatedEntityId);
    return session ? `${session.startsAt}|${session.status}` : null;
  }
  if (type === 'student_homework_deadline' || type === 'student_homework_overdue' || type === 'student_homework_assigned') {
    const homework = state.homework.find(item => item.id === relatedEntityId);
    return homework ? `${homework.dueAt ?? ''}|${homework.publishAt ?? ''}|${homework.status}` : null;
  }
  return null;
}

function latestSubmission(state: PilotRuntimeState, studentId: string, homeworkId: string) {
  return state.submissions
    .filter(item => item.studentId === studentId && item.homeworkId === homeworkId)
    .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
}

/** Recomputes the relevance window for a queued notification from the current state. */
export function currentWindow(state: PilotRuntimeState, notification: Pick<PilotNotification, 'type' | 'relatedEntityId' | 'dueAt' | 'expiresAt'>): NotificationWindow | null {
  const id = notification.relatedEntityId;
  if (notification.type === 'student_class_24h' || notification.type === 'student_class_1h') {
    const session = id ? state.classSessions.find(item => item.id === id) : undefined;
    if (!session) return null;
    return classReminderWindow(session.startsAt, notification.type === 'student_class_24h' ? '24h' : '1h');
  }
  if (notification.type === 'student_homework_deadline') {
    const homework = id ? state.homework.find(item => item.id === id) : undefined;
    if (!homework?.dueAt) return null;
    return homeworkDeadlineWindow(homework.dueAt);
  }
  if (notification.type === 'student_homework_overdue') {
    const homework = id ? state.homework.find(item => item.id === id) : undefined;
    if (!homework?.dueAt) return null;
    return homeworkOverdueWindow(homework.dueAt);
  }
  return { dueAt: Date.parse(notification.dueAt), expiresAt: Date.parse(notification.expiresAt) };
}

export type DeliveryDecision = { deliver: true } | { deliver: false; reason: NotificationSkipReason };

const DELIVER: DeliveryDecision = { deliver: true };
const skip = (reason: NotificationSkipReason): DeliveryDecision => ({ deliver: false, reason });

/**
 * Last gate before a message leaves the system. Runs against live state, so anything that happened
 * between queueing and delivery — a reschedule, a cancellation, a submission, a revoked guardian
 * link — is honoured here rather than in the frozen copy of the message.
 */
export function evaluateDelivery(state: PilotRuntimeState, notification: PilotNotification, now: Date): DeliveryDecision {
  const nowMs = now.getTime();
  const recipient = state.directory[notification.recipientUserId];
  if (!recipient || recipient.status !== 'active') return skip('RECIPIENT_INACTIVE');
  if (!recipient.telegramId) return skip('TELEGRAM_BINDING_MISSING');

  const studentId = notification.safeMetadata.studentId;
  if (studentId) {
    const student = state.directory[studentId];
    if (!student || student.status !== 'active') return skip('STUDENT_INACTIVE');
    const linked = state.guardianRelations.some(link =>
      link.guardianId === notification.recipientUserId && link.studentId === studentId && link.status === 'active');
    if (!linked) return skip('GUARDIAN_RELATION_REVOKED');
  }

  if (requiresEntityStamp(notification.type)) {
    const stamp = entityStamp(state, notification.type, notification.relatedEntityId);
    if (stamp === null) return skip('ENTITY_MISSING');
    // A queued message carries a frozen time. Without a stamp that still matches the live entity we
    // cannot prove that time is current, so the copy is discarded instead of risking a wrong time.
    if (notification.entityStamp === null || notification.entityStamp === undefined) return skip('STALE_UNVERIFIED');
    if (stamp !== notification.entityStamp) {
      if (notification.type.startsWith('student_class_')) {
        const session = state.classSessions.find(item => item.id === notification.relatedEntityId);
        return skip(session?.status === 'cancelled' ? 'CLASS_CANCELLED' : 'CLASS_RESCHEDULED');
      }
      return skip('HOMEWORK_RESCHEDULED');
    }
  }

  if (notification.type.startsWith('student_class_')) {
    const session = state.classSessions.find(item => item.id === notification.relatedEntityId);
    if (!session) return skip('ENTITY_MISSING');
    if (session.status === 'cancelled') return skip('CLASS_CANCELLED');
  }

  if (notification.type === 'student_homework_deadline' || notification.type === 'student_homework_overdue') {
    const submission = latestSubmission(state, notification.recipientUserId, notification.relatedEntityId ?? '');
    if (submission?.review) return skip('HOMEWORK_ALREADY_REVIEWED');
    if (submission) return skip('HOMEWORK_ALREADY_SUBMITTED');
  }

  const window = currentWindow(state, notification);
  if (!window) return skip('ENTITY_MISSING');
  if (nowMs > window.expiresAt) return skip('REMINDER_WINDOW_EXPIRED');
  return DELIVER;
}

/**
 * Oldest instant this run will reach back to.
 *
 * Deliberately not a strict "everything since the last run" watermark: an event can be backdated
 * (homework published with an earlier publishAt) or land in the same second as a previous pass, and
 * a strict watermark would drop it forever. Once-only delivery is guaranteed by the persistent
 * idempotency key instead, so the horizon only has to stop a cold start from resurrecting history.
 */
export function catchUpSince(lastRunAt: string | null | undefined, now: Date): number {
  const nowMs = now.getTime();
  const parsed = lastRunAt ? Date.parse(lastRunAt) : Number.NaN;
  if (!Number.isFinite(parsed)) return nowMs - FIRST_RUN_LOOKBACK_MS;
  // Anchored to the previous run so the reach only ever grows with real downtime. A horizon that
  // widened on its own would let a run resurrect events an earlier run had already aged out.
  return Math.min(nowMs, Math.max(parsed - CATCH_UP_OVERLAP_MS, nowMs - MAX_CATCH_UP_MS));
}

/**
 * A candidate is queued when it has fallen due, is still within its relevance window, and is not
 * older than the catch-up horizon. Lateness alone never drops it; staleness always does.
 */
export function shouldEnqueue(window: NotificationWindow, horizon: number, now: Date): boolean {
  const nowMs = now.getTime();
  return window.dueAt <= nowMs && window.dueAt >= horizon && nowMs <= window.expiresAt;
}
