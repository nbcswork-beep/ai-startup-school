import type {
  AuthUser,
  ClassSessionDto,
  HomeworkSubmissionDto,
  PortfolioDto,
  TeacherHomeworkDto,
  TeacherPrivateNoteDto,
  TeacherWorkspaceDto,
  ParentContactCategory
} from '../types/domain.js';
import { PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_HOMEWORK, SEEDED_LESSONS } from './seed.js';
import { AppError } from '../errors/app-error.js';

export type PilotDirectoryRole = 'student' | 'guardian' | 'teacher' | 'mentor' | 'admin';
export interface PilotDirectoryPerson {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  roles: PilotDirectoryRole[];
  status: AuthUser['status'];
  groupId: string | null;
  email: string | null;
  phone: string | null;
  telegramId: string | null;
  passwordHash: string | null;
  activationTokenHash: string | null;
  activationExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface PilotGuardianRelation {
  id: string;
  guardianId: string;
  studentId: string;
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

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
  updatedAt: string;
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

export interface PilotNotification {
  id:string;
  recipientUserId:string;
  recipientTelegramId:string;
  type:string;
  relatedEntityId:string|null;
  scheduledFor:string;
  sentAt:string|null;
  status:'pending'|'processing'|'sent'|'failed'|'skipped';
  attempts:number;
  lastAttemptAt:string|null;
  nextAttemptAt:string|null;
  idempotencyKey:string;
  safeMetadata:{text:string;buttonText?:string;buttonUrl?:string;callbackData?:string;studentId?:string;weekKey?:string};
  errorCode:string|null;
  /** When this message should have gone out. */
  dueAt:string;
  /** After this instant sending would be misleading rather than merely late. */
  expiresAt:string;
  /** Fingerprint of the source entity, so a reschedule invalidates the frozen copy. */
  entityStamp:string|null;
}

export interface PilotNotificationRuntime {
  /** Watermark of the last worker pass; catch-up reaches back to it. */
  lastRunAt:string|null;
  lastClaimedCount:number;
}

export interface PilotParentContactRequest {
  id:string;
  guardianId:string;
  studentId:string;
  category:ParentContactCategory;
  message:string;
  status:'new'|'resolved';
  createdAt:string;
  resolvedAt:string|null;
}

export interface PilotClassSession extends ClassSessionDto {
  groupId: string;
  groupName: string;
  lessonId: string | null;
  teacherNotes: string;
  changedAt?: string | null;
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
  schemaVersion: 3;
  directory: Record<string, PilotDirectoryPerson>;
  telegramBindings: Record<string, string>;
  guardianRelations: PilotGuardianRelation[];
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
  notifications: PilotNotification[];
  notificationRuntime: PilotNotificationRuntime;
  parentContactRequests: PilotParentContactRequest[];
}

export interface PilotRuntimeStatus {
  /** Namespace the state is addressed by. Never contains credentials. */
  namespace: string;
  /** False when the backing key does not exist yet. */
  initialized: boolean;
  sizeBytes: number | null;
}

export interface PilotRuntimeStore {
  /** Namespace this store addresses. Safe to log and to embed in a snapshot. */
  readonly namespace: string;
  read(): Promise<PilotRuntimeState>;
  mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T>;
  status(): Promise<PilotRuntimeStatus>;
  /** Overwrites the whole state. Only recovery tooling calls this. */
  replace(next: PilotRuntimeState): Promise<void>;
}

/**
 * Bootstrap behaviour when the backing key is absent.
 * - `seed` writes the development seed (correct locally and for a fresh preview).
 * - `require` fails loudly, so a production deployment never presents the demo seed as real
 *   school data after the state key is lost.
 */
export type RuntimeBootstrapPolicy = 'seed' | 'require';

export class RuntimeStateMissingError extends AppError {
  constructor(namespace: string) {
    super(
      'RUNTIME_STATE_MISSING',
      503,
      'Стан школи недоступний. Зверніться до адміністратора.',
      {
        namespace,
        operatorMessage:
          `Pilot runtime state is missing at "${namespace}" and this deployment refuses to seed demo data over it. `
          + 'Restore the most recent snapshot with "npm run runtime:restore -- --file <snapshot.json> --confirm-restore", '
          + 'or set ALLOW_RUNTIME_STATE_BOOTSTRAP=true for one deploy to intentionally start a brand new school.'
      }
    );
    this.name = 'RuntimeStateMissingError';
  }
}

function relativeIso(days: number, hour: number, minute = 0): string {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function createPilotRuntimeState(): PilotRuntimeState {
  const timestamp = '2026-09-21T00:00:00.000Z';
  const nameParts = (value: string) => { const parts=value.trim().split(/\s+/); return { lastName:parts.shift()??'', firstName:parts.join(' ') }; };
  const directory: Record<string, PilotDirectoryPerson> = {};
  for (const student of PILOT_STUDENTS) {
    const names=nameParts(student.fullName);
    directory[student.id]={id:student.id,firstName:names.firstName,lastName:names.lastName,displayName:student.fullName,roles:['student'],status:'active',groupId:PILOT.groupId,email:null,phone:null,telegramId:null,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:timestamp,updatedAt:timestamp,version:1};
  }
  for (const teacher of PILOT_TEACHERS) {
    const names=nameParts(teacher.fullName);
    directory[teacher.id]={id:teacher.id,firstName:names.firstName,lastName:names.lastName,displayName:teacher.fullName,roles:teacher.key==='maksym'?['teacher','mentor','admin']:['teacher'],status:'active',groupId:null,email:null,phone:null,telegramId:null,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:timestamp,updatedAt:timestamp,version:1};
  }
  directory['13000000-0000-4000-8000-000000000001']={id:'13000000-0000-4000-8000-000000000001',firstName:'Тестовий',lastName:'Опікун',displayName:'Тестовий опікун',roles:['guardian'],status:'active',groupId:null,email:null,phone:null,telegramId:null,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:timestamp,updatedAt:timestamp,version:1};
  directory['14000000-0000-4000-8000-000000000001']={id:'14000000-0000-4000-8000-000000000001',firstName:'Адміністратор',lastName:'',displayName:'Адміністратор',roles:['admin'],status:'active',groupId:null,email:null,phone:null,telegramId:null,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:timestamp,updatedAt:timestamp,version:1};
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
    schemaVersion: 3,
    directory,
    telegramBindings: {},
    guardianRelations: [{id:'92000000-0000-4000-8000-000000000001',guardianId:'13000000-0000-4000-8000-000000000001',studentId:PILOT_STUDENTS[0]!.id,status:'active',createdAt:timestamp,updatedAt:timestamp}],
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
    securityEvents: [],
    notifications: [],
    notificationRuntime: { lastRunAt: null, lastClaimedCount: 0 },
    parentContactRequests: []
  };
}

export function migratePilotRuntimeState(input: PilotRuntimeState | (Partial<PilotRuntimeState> & { schemaVersion?: number })): PilotRuntimeState {
  const seed=createPilotRuntimeState();
  const state=input as PilotRuntimeState;
  state.directory={...seed.directory,...(state.directory??{})};
  state.telegramBindings=state.telegramBindings??{};
  state.guardianRelations=state.guardianRelations??seed.guardianRelations;
  state.notifications=state.notifications??[];
  state.notificationRuntime=state.notificationRuntime??{lastRunAt:null,lastClaimedCount:0};
  // Notifications queued before relevance windows existed keep their original schedule. They carry
  // no entity stamp, so a reschedulable one cannot be proven current and is withheld at delivery
  // (STALE_UNVERIFIED) rather than risking a message with a stale time.
  for(const notification of state.notifications as Array<Partial<PilotNotification>&{scheduledFor:string}>){
    notification.dueAt??=notification.scheduledFor;
    notification.expiresAt??=new Date(Date.parse(notification.scheduledFor)+7*86_400_000).toISOString();
    notification.entityStamp??=null;
  }
  state.parentContactRequests=state.parentContactRequests??[];
  state.userStatus=state.userStatus??seed.userStatus;
  for(const person of Object.values(state.directory)){
    person.status=state.userStatus[person.id]??person.status;
    state.userStatus[person.id]=person.status;
  }
  for(const projects of Object.values(state.projects??{}))for(const project of projects)project.updatedAt??='2026-09-21T00:00:00.000Z';
  state.schemaVersion=3;
  return state;
}

export class MemoryPilotRuntimeStore implements PilotRuntimeStore {
  private state: PilotRuntimeState;
  readonly namespace: string;

  constructor(initialState: PilotRuntimeState = createPilotRuntimeState(), namespace = 'memory:pilot-runtime') {
    this.state = structuredClone(initialState);
    this.namespace = namespace;
  }

  async read(): Promise<PilotRuntimeState> {
    return structuredClone(migratePilotRuntimeState(this.state));
  }

  async mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T> {
    const next = migratePilotRuntimeState(structuredClone(this.state));
    const result = mutation(next);
    this.state = next;
    return structuredClone(result);
  }

  async status(): Promise<PilotRuntimeStatus> {
    return { namespace: this.namespace, initialized: true, sizeBytes: JSON.stringify(this.state).length };
  }

  async replace(next: PilotRuntimeState): Promise<void> {
    this.state = migratePilotRuntimeState(structuredClone(next));
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

export interface RedisRestPilotRuntimeStoreOptions {
  bootstrapPolicy?: RuntimeBootstrapPolicy;
  maxRetries?: number;
}

export class RedisRestPilotRuntimeStore implements PilotRuntimeStore {
  private readonly client: RedisRestClient;
  private readonly key: string;
  private readonly bootstrapPolicy: RuntimeBootstrapPolicy;
  private readonly maxRetries: number;

  constructor(url: string, token: string, prefix: string, options: RedisRestPilotRuntimeStoreOptions = {}) {
    this.client = new RedisRestClient(url, token);
    this.key = `${prefix}:state`;
    this.bootstrapPolicy = options.bootstrapPolicy ?? 'seed';
    this.maxRetries = options.maxRetries ?? 12;
  }

  get namespace(): string {
    return this.key;
  }

  private async readRaw(): Promise<string> {
    const existing = await this.client.command<string | null>(['GET', this.key]);
    if (existing !== null && existing !== undefined) return existing;
    if (this.bootstrapPolicy === 'require') throw new RuntimeStateMissingError(this.key);
    const initial = JSON.stringify(createPilotRuntimeState());
    return this.client.command<string>(['EVAL', INITIALIZE_SCRIPT, 1, this.key, initial]);
  }

  async status(): Promise<PilotRuntimeStatus> {
    const raw = await this.client.command<string | null>(['GET', this.key]);
    const present = raw !== null && raw !== undefined;
    return { namespace: this.key, initialized: present, sizeBytes: present ? raw.length : null };
  }

  async replace(next: PilotRuntimeState): Promise<void> {
    await this.client.command(['SET', this.key, JSON.stringify(migratePilotRuntimeState(structuredClone(next)))]);
  }

  async read(): Promise<PilotRuntimeState> {
    return migratePilotRuntimeState(JSON.parse(await this.readRaw()) as PilotRuntimeState);
  }

  async mutate<T>(mutation: (state: PilotRuntimeState) => T): Promise<T> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const currentRaw = await this.readRaw();
      const next = migratePilotRuntimeState(JSON.parse(currentRaw) as PilotRuntimeState);
      const result = mutation(next);
      const updated = await this.client.command<number>(['EVAL', COMPARE_AND_SET_SCRIPT, 1, this.key, currentRaw, JSON.stringify(next)]);
      if (updated === 1) return structuredClone(result);
    }
    throw new AppError('PERSISTENCE_CONFLICT', 409, 'Дані змінилися паралельно. Оновіть сторінку та повторіть дію.');
  }
}
