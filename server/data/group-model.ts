import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import { DEV_IDS, PILOT, PILOT_TEACHERS } from './seed.js';
import type { PilotClassSession, PilotRuntimeState } from './pilot-runtime-store.js';

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  academicYear: z.number().int().min(2000).max(2100),
  startsOn: z.string().date(),
  lessonCount: z.number().int().min(0).max(100).default(0),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(v => new Set(v).size === v.length),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  teacherId: z.string().uuid(),
  status: z.enum(['active', 'archived']).default('active')
}).strict();
export type GroupInput = z.infer<typeof groupInputSchema>;
export interface SchoolGroup extends GroupInput {
  id: string;
  teacherIds: string[];
  courseId: string;
  timezone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// Recognizable titles from the retired automatic group generator. Never create assignments from this catalog.
export const PILOT_SESSION_TITLES = [
  'Не починай з ідеї', 'Для кого це проблема?', 'Ідея стає гіпотезою',
  'Що саме будемо будувати?', 'AI пише код — відповідаєш ти',
  'Запусти й покажи', 'Цифри вже є. Не обмани себе', 'Що ми дізналися?'
];

export function legacyGroup(): SchoolGroup {
  return { id: PILOT.groupId, name: PILOT.groupName, academicYear: 2026,
    startsOn: '2026-09-21', lessonCount: 8, weekdays: [1], time: '17:00',
    teacherId: PILOT_TEACHERS[0].id, teacherIds: PILOT_TEACHERS.map(t => t.id),
    status: 'active', courseId: DEV_IDS.course, timezone: PILOT.timezone,
    version: 1, createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' };
}

export function isUpcomingSession(session: { status: string; endsAt: string }, now = Date.now()): boolean {
  return ['scheduled', 'rescheduled', 'in_progress'].includes(session.status) && Date.parse(session.endsAt) >= now;
}

// Resolve each occurrence in Kyiv, including transitions between summer and winter time.
export function zonedStart(date: string, time: string, timezone: string): string {
  if(!z.string().date().safeParse(date).success||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))throw new AppError('INVALID_GROUP_TIME',400,'Некоректна дата або час');
  const wall = Date.parse(`${date}T${time}:00Z`);
  let instant = wall;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(v => [v.type, v.value]));
    const shown = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (shown === wall) return new Date(instant).toISOString();
    instant += wall - shown;
  }
  throw new AppError('INVALID_GROUP_TIME', 400, 'Цей час недоступний через перехід на літній час. Оберіть інший час.');
}

export function groupDates(group: SchoolGroup): string[] {
  const dates: string[] = [];
  const day = new Date(`${group.startsOn}T12:00:00Z`);
  while (dates.length < group.lessonCount) {
    if (group.weekdays.includes(day.getUTCDay())) dates.push(zonedStart(day.toISOString().slice(0, 10), group.time, group.timezone));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

// Group metadata changes must never create, restore, cancel or reschedule lessons.
export function updateGroupSessionLabels(state: PilotRuntimeState, group: SchoolGroup): void {
  for (const session of state.classSessions.filter(s => s.groupId === group.id)) {
    session.groupName = group.name;
    session.teacherName = group.teacherIds.map(id => state.directory[id]?.displayName ?? '').filter(Boolean).join(', ');
  }
}
