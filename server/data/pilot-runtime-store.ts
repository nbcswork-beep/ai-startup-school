import type {
  AuthUser,
  ClassSessionDto,
  HomeworkSubmissionDto,
  PortfolioDto,
  TeacherHomeworkDto,
  TeacherPrivateNoteDto,
  TeacherWorkspaceDto
} from '../types/domain.js';
import { PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_HOMEWORK, SEEDED_LESSONS } from './seed.js';

export const PILOT_PORTFOLIO_IDS = Object.fromEntries(PILOT_STUDENTS.map((student, index) => [
  student.id,
  `81000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
])) as Record<string, string>;

export interface PilotLessonProgress {
  progressPercent: number;
  completedAt: string | null;
}

export interface PilotProject {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'completed' | 'archived';
  stagePosition: number;
  stageCode: string;
  stageTitle: string;
  tags: string[];
  workspaceUrl: string | null;
  tasks: Array<{
    id: string;
    number: string;
    title: string;
    description: string;
    status: 'locked' | 'available' | 'in_progress' | 'completed';
    xpReward: number;
    weight: number;
  }>;
}

export interface PilotClassSession extends ClassSessionDto {
  groupId: string;
  groupName: string;
  lessonId: string | null;
  teacherNotes: string;
}

export interface PilotHomeworkSubmission extends HomeworkSubmissionDto {
  studentId: string;
  homeworkId: string;
}

export interface PilotAttendanceRecord {
  id: string;
  sessionId: string;
  studentId: string;
  status: 'present' | 'late' | 'absent' | 'excused';
  note: string;
  confirmedAt: string;
}

export interface PilotRuntimeState {
  schemaVersion: 1;
  userStatus: Record<string, AuthUser['status']>;
  xp: Record<string, number>;
  streak: Record<string, number>;
  lessonProgress: Record<string, Record<string, PilotLessonProgress>>;
  projects: Record<string, PilotProject[]>;
  achievements: Record<string, string[]>;
  idempotencyKeys: string[];
  classSessions: PilotClassSession[];
  attendance: PilotAttendanceRecord[];
  homework: TeacherHomeworkDto[];
  submissions: PilotHomeworkSubmission[];
  portfolioProjects: Record<string, PortfolioDto['projects']>;
  portfolioVisibility: Record<string, 'private' | 'shareable' | 'public'>;
  teacherNotes: TeacherPrivateNoteDto[];
  teacherReports: TeacherWorkspaceDto['reports'];
  adminAuditEvents: Array<Record<string, unknown>>;
  securityEvents: Array<Record<string, unknown>>;
}

export interface PilotRuntimeStore {
  read(): Promise<PilotRuntimeState>;
  mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T>;
}

function relativeIso(days: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function createPilotRuntimeState(): PilotRuntimeState {
  const userStatus = Object.fromEntries([
    ...PILOT_STUDENTS.map(student => [student.id, 'active'] as const),
    ...PILOT_TEACHERS.map(teacher => [teacher.id, 'active'] as const),
    ['13000000-0000-4000-8000-000000000001', 'active'],
    ['14000000-0000-4000-8000-000000000001', 'active']
  ]) as Record<string, AuthUser['status']>;
  const studentRecord = <T>(factory: (studentId: string, index: number) => T): Record<string, T> =>
    Object.fromEntries(PILOT_STUDENTS.map((student, index) => [student.id, factory(student.id, index)]));
  const classSessions: PilotClassSession[] = SEEDED_LESSONS.map((lesson, index) => ({
    id: `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    groupId: PILOT.groupId,
    groupName: PILOT.groupName,
    lessonId: lesson.id,
    title: lesson.title,
    description: 'Живе групове заняття з практикою та роботою над проєктом.',
    startsAt: relativeIso(1 + index * 7, 17),
    endsAt: relativeIso(1 + index * 7, 18, 30),
    durationMinutes: 90,
    status: 'scheduled',
    meetingProvider: 'Google Meet',
    meetingUrl: PILOT.meetingUrl,
    courseTitle: PILOT.courseTitle,
    moduleTitle: PILOT.moduleTitle,
    lessonTitle: lesson.title,
    teacherName: 'Команда викладачів',
    teacherNotes: '',
    materials: []
  }));
  const homework: TeacherHomeworkDto[] = SEEDED_HOMEWORK.map((instructions, index) => ({
    id: `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    groupId: PILOT.groupId,
    groupName: PILOT.groupName,
    classSessionId: classSessions[index]!.id,
    title: `Домашнє завдання · заняття ${index + 1}`,
    instructions,
    publishAt: relativeIso(1 + index * 7, 18, 30),
    dueAt: relativeIso(7 + index * 7, 20),
    xpReward: SEEDED_LESSONS[index]!.xp,
    status: 'published',
    submissionCount: 0,
    reviewCount: 0,
    needsRevisionCount: 0,
    resources: []
  }));
  return {
    schemaVersion: 1,
    userStatus,
    xp: studentRecord(() => 0),
    streak: studentRecord(() => 0),
    lessonProgress: studentRecord(() => ({ [SEEDED_LESSONS[0]!.id]: { progressPercent: 0, completedAt: null } })),
    projects: studentRecord(() => []),
    achievements: studentRecord(() => []),
    idempotencyKeys: [],
    classSessions,
    attendance: [],
    homework,
    submissions: [],
    portfolioProjects: studentRecord(() => []),
    portfolioVisibility: Object.fromEntries(PILOT_STUDENTS.map(student => [PILOT_PORTFOLIO_IDS[student.id]!, 'private'])),
    teacherNotes: [],
    teacherReports: [],
    adminAuditEvents: [],
    securityEvents: []
  };
}

export class MemoryPilotRuntimeStore implements PilotRuntimeStore {
  private state: PilotRuntimeState;

  constructor(initialState: PilotRuntimeState = createPilotRuntimeState()) {
    this.state = structuredClone(initialState);
  }

  async read(): Promise<PilotRuntimeState> {
    return structuredClone(this.state);
  }

  async mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T> {
    const next = structuredClone(this.state);
    const result = mutation(next);
    this.state = next;
    return structuredClone(result);
  }
}

type RedisReply<T> = { result?: T; error?: string };

class RedisRestClient {
  constructor(private readonly url: string, private readonly token: string) {}

  async command<T>(command: Array<string | number>): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command.map(value => String(value))),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Pilot runtime storage request failed (${response.status})`);
    const payload = await response.json() as RedisReply<T>;
    if (payload.error) throw new Error('Pilot runtime storage command failed');
    return payload.result as T;
  }
}

const INITIALIZE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
  return ARGV[1]
end
return redis.call('GET', KEYS[1])`;

const COMPARE_AND_SET_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`;

export class RedisRestPilotRuntimeStore implements PilotRuntimeStore {
  private readonly client: RedisRestClient;
  private readonly key: string;

  constructor(url: string, token: string, prefix: string, private readonly maxRetries = 12) {
    this.client = new RedisRestClient(url, token);
    this.key = `${prefix}:state`;
  }

  private async readRaw(): Promise<string> {
    const initial = JSON.stringify(createPilotRuntimeState());
    return this.client.command<string>(['EVAL', INITIALIZE_SCRIPT, 1, this.key, initial]);
  }

  async read(): Promise<PilotRuntimeState> {
    return JSON.parse(await this.readRaw()) as PilotRuntimeState;
  }

  async mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const currentRaw = await this.readRaw();
      const next = JSON.parse(currentRaw) as PilotRuntimeState;
      const result = mutation(next);
      const updated = await this.client.command<number>(['EVAL', COMPARE_AND_SET_SCRIPT, 1, this.key, currentRaw, JSON.stringify(next)]);
      if (updated === 1) return structuredClone(result);
    }
    throw new Error('Pilot runtime storage contention exceeded retry limit');
  }
}
