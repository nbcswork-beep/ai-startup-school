import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { MemorySessionStore, type SessionStore } from '../auth/session-store.js';
import type { AppRepository } from './repository.js';
import { DEV_IDS, PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_HOMEWORK, SEEDED_LESSONS } from './seed.js';
import type {
  AchievementDto,
  AccessContext,
  AdminEntity,
  AdminExplorerPageDto,
  AdminSearchDto,
  AdminWorkspaceDto,
  AiContextDto,
  AiConversationDto,
  AiMessageDto,
  AuthUser,
  ClassSessionDto,
  EffortLevel,
  HomeDto,
  HomeworkSubmissionDto,
  HomeworkSummaryDto,
  LearningDto,
  LessonDto,
  LessonSummaryDto,
  NewSession,
  ProfileDto,
  PortfolioDto,
  ProjectDto,
  ProjectTaskDto,
  ScheduleDto,
  MentorBookingDto,
  MentorSlotDto,
  ParentReportDto,
  TeacherGroupDto,
  TeacherStudentDto,
  TeacherWorkspaceDto,
  TeacherSearchDto,
  TeacherPrivateNoteDto,
  TeacherHomeworkDto,
  RotationResult,
  TelegramIdentityInput
} from '../types/domain.js';

type LessonState = { progressPercent: number; completedAt: string | null };
type InternalProject = Omit<ProjectDto, 'completionPercent' | 'stage'> & { stagePosition: number; stageCode: string; stageTitle: string };
type InternalConversation = AiConversationDto & { summary: string; messages: AiMessageDto[]; clientMessageIds: Set<string> };

export interface MemoryRepositoryOptions {
  telegramBindingsJson?: string | undefined;
  requireSeededTelegramIdentity?: boolean;
  sessionStore?: SessionStore;
}

function relativeIso(days: number, hour: number, durationMinutes = 0): string {
  const date = new Date();
  date.setHours(hour, durationMinutes, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

const LEVELS = [
  { number: 1, title: 'Explorer', minXp: 0 },
  { number: 2, title: 'Maker', minXp: 200 },
  { number: 3, title: 'Builder', minXp: 400 },
  { number: 4, title: 'Creator', minXp: 600 },
  { number: 5, title: 'Launcher', minXp: 900 }
];

const STAGES = [
  { id: '31000000-0000-4000-8000-000000000001', code: 'idea', title: 'Ідея', position: 1 },
  { id: '31000000-0000-4000-8000-000000000002', code: 'plan', title: 'План', position: 2 },
  { id: DEV_IDS.stage, code: 'prototype', title: 'Прототип', position: 3 },
  { id: '31000000-0000-4000-8000-000000000004', code: 'design', title: 'Дизайн', position: 4 },
  { id: '31000000-0000-4000-8000-000000000005', code: 'test', title: 'Тест', position: 5 },
  { id: '31000000-0000-4000-8000-000000000006', code: 'launch', title: 'Запуск', position: 6 }
];

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryRepository implements AppRepository {
  private users = new Map<string, AuthUser>([
    ...PILOT_STUDENTS.map(student => [student.id, { id: student.id, displayName: student.fullName, status: 'active' as const }] as const),
    ...PILOT_TEACHERS.map(teacher => [teacher.id, { id: teacher.id, displayName: teacher.fullName, status: 'active' as const }] as const),
    ['13000000-0000-4000-8000-000000000001', { id: '13000000-0000-4000-8000-000000000001', displayName: 'Тестовий опікун', status: 'active' }],
    ['14000000-0000-4000-8000-000000000001', { id: '14000000-0000-4000-8000-000000000001', displayName: 'Адміністратор', status: 'active' }]
  ]);
  private roles = new Map<string, 'student'|'guardian'|'teacher'|'admin'>([
    ...PILOT_STUDENTS.map(student => [student.id, 'student' as const] as const),
    ...PILOT_TEACHERS.map(teacher => [teacher.id, teacher.key === 'maksym' ? 'admin' as const : 'teacher' as const] as const),
    ['13000000-0000-4000-8000-000000000001','guardian'],
    ['14000000-0000-4000-8000-000000000001','admin']
  ]);
  private studentDisplayNames = new Map<string, string>(PILOT_STUDENTS.map(student => [student.id, student.displayName]));
  private identities = new Map<string, string>();
  private readonly sessionStore: SessionStore;
  private xp = new Map<string, number>(PILOT_STUDENTS.map(student => [student.id, 0]));
  private streak = new Map<string, number>(PILOT_STUDENTS.map(student => [student.id, 0]));
  private lessonState = new Map<string, Map<string, LessonState>>(
    PILOT_STUDENTS.map(student => [
      student.id,
      new Map([[SEEDED_LESSONS[0]!.id, { progressPercent: 0, completedAt: null }]])
    ])
  );
  private projects = new Map<string, InternalProject[]>();
  private achievements = new Map<string, Set<string>>();
  private xpKeys = new Set<string>();
  private conversations = new Map<string, InternalConversation[]>();
  private homeworkSubmissions = new Map<string, HomeworkSubmissionDto[]>();
  private submissionHomeworkIds = new Map<string,string>();
  private portfolioProjects = new Map<string, PortfolioDto['projects']>();
  private mentorBookings = new Map<string, MentorBookingDto[]>();
  private classSessionOverrides = new Map<string, { startsAt?: string; endsAt?: string; status?: ClassSessionDto['status']; title?: string; description?: string; lessonId?: string | null; meetingUrl?: string | null; meetingProvider?: string | null; teacherNotes?: string }>();
  private classMaterials = new Map<string, ClassSessionDto['materials']>();
  private attendanceRecords = new Map<string, Map<string,{status:'present'|'late'|'absent'|'excused';note:string;confirmedAt:string}>>();
  private teacherHomeworkItems: TeacherHomeworkDto[] = [];
  private teacherNotes: TeacherPrivateNoteDto[] = [];
  private teacherMentorAvailability: TeacherWorkspaceDto['mentor']['availability'] = [];
  private teacherMentorBookings: TeacherWorkspaceDto['mentor']['bookings'] = [];
  private teacherReports: TeacherWorkspaceDto['reports'] = [];
  private createdClassSessions: ClassSessionDto[] = [];
  private portfolioVisibility = new Map<string,'private'|'shareable'|'public'>();
  private portfolioIds = new Map<string,string>(PILOT_STUDENTS.map((student, index) => [student.id, `81000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
  private guardianLinks = new Map<string,'active'|'revoked'>([['92000000-0000-4000-8000-000000000001','active']]);
  private adminAuditEvents: Array<Record<string,unknown>> = [];
  private securityEvents: Array<Record<string,unknown>> = [];
  private adminNotifications: Array<Record<string,unknown>> = [];
  private readonly requireSeededTelegramIdentity: boolean;

  constructor(private readonly workspaceUrl?: string, options: MemoryRepositoryOptions = {}) {
    this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    this.requireSeededTelegramIdentity = options.requireSeededTelegramIdentity ?? false;
    for (const student of PILOT_STUDENTS) {
      this.projects.set(student.id, []);
      this.achievements.set(student.id, new Set());
      this.conversations.set(student.id, []);
      this.homeworkSubmissions.set(student.id, []);
      this.portfolioProjects.set(student.id, []);
      this.mentorBookings.set(student.id, []);
      const portfolioId = this.portfolioIds.get(student.id)!;
      this.portfolioVisibility.set(portfolioId, 'private');
    }
    this.loadTelegramBindings(options.telegramBindingsJson);
    this.teacherHomeworkItems = SEEDED_HOMEWORK.map((instructions, index) => ({
      id: `73000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      groupId: PILOT.groupId,
      groupName: PILOT.groupName,
      classSessionId: `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
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
    this.teacherMentorAvailability = [{ id:'91000000-0000-4000-8000-000000000001', mentorId:PILOT.mentorId, startsAt:relativeIso(2,18), endsAt:relativeIso(2,18,30), timezone:PILOT.timezone, status:'open' }];
  }

  async ping(): Promise<void> {}

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const key = `telegram:${identity.telegramId}`;
    const existingId = this.identities.get(key);
    if (existingId) return this.requireUser(existingId);
    if (this.requireSeededTelegramIdentity) {
      throw new AppError('TELEGRAM_ACCOUNT_NOT_LINKED', 403, 'Telegram-акаунт ще не прив’язано до профілю учня');
    }
    const user: AuthUser = { id: randomUUID(), displayName: identity.firstName.slice(0, 60) || 'Учень', status: 'active' };
    this.users.set(user.id, user);
    this.roles.set(user.id, 'student');
    this.identities.set(key, user.id);
    this.xp.set(user.id, 0);
    this.streak.set(user.id, 0);
    this.lessonState.set(user.id, new Map([[SEEDED_LESSONS[0].id, { progressPercent: 0, completedAt: null }]]));
    this.projects.set(user.id, []);
    this.achievements.set(user.id, new Set());
    this.conversations.set(user.id, []);
    this.homeworkSubmissions.set(user.id, []);
    this.portfolioProjects.set(user.id, []);
    this.mentorBookings.set(user.id, []);
    this.studentDisplayNames.set(user.id, user.displayName);
    return structuredClone(user);
  }

  async getDevelopmentUser(userId: string): Promise<AuthUser | null> {
    return this.users.has(userId) ? structuredClone(this.requireUser(userId)) : null;
  }

  async getAuthUser(userId: string): Promise<AuthUser | null> {
    return this.users.has(userId) ? structuredClone(this.requireUser(userId)) : null;
  }

  async getWebAuthUser(userId: string): Promise<{ user: AuthUser; role: AccessContext['role'] } | null> {
    const user = await this.getAuthUser(userId);
    const role = this.roles.get(userId);
    return user && role ? { user, role } : null;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.sessionStore.create(session);
  }

  async rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult> {
    const result = await this.sessionStore.rotate(currentTokenHash, next, now);
    if (result.status !== 'ok') return result;
    return { status: 'ok', user: structuredClone(this.requireUser(result.session.userId)), session: result.session };
  }

  async revokeSession(refreshTokenHash: string, now: Date): Promise<boolean> {
    return this.sessionStore.revokeFamily(refreshTokenHash, now);
  }

  async getAccessContext(userId:string,sessionId:string):Promise<AccessContext>{
    const user=this.users.get(userId);
    return{role:this.roles.get(userId)??'student',status:user?.status??'disabled',sessionActive:await this.sessionStore.isActive(userId,sessionId,new Date())};
  }

  async getHome(userId: string): Promise<HomeDto> {
    const learning = await this.getLearning(userId);
    const projects = await this.listProjects(userId);
    const currentLesson = learning.modules.flatMap(module => module.lessons).find(lesson => lesson.state === 'current' || lesson.state === 'available') ?? null;
    const schedule = await this.getSchedule(userId);
    const homework = await this.listHomework(userId);
    return {
      viewer: this.viewer(userId),
      course: learning.course,
      currentLesson,
      projectCount: projects.length,
      currentProject: projects.find(project => project.status === 'active') ?? null,
      nextClass: schedule.nextClass,
      homeworkDue: homework.find(item => item.state !== 'completed') ?? null
    };
  }

  async getSchedule(userId: string): Promise<ScheduleDto> {
    this.requireRole(userId,'student');
    const session = (id: string, title: string, days: number, status: ScheduleDto['upcoming'][number]['status']) => {
      const override=this.classSessionOverrides.get(id); const startsAt=override?.startsAt??relativeIso(days,17); const endsAt=override?.endsAt??relativeIso(days,18,30); const currentStatus=override?.status??status;
      return { id, title:override?.title??title, description:override?.description??'Живе групове заняття з практикою та роботою над проєктом.', startsAt, endsAt, durationMinutes: Math.round((Date.parse(endsAt)-Date.parse(startsAt))/60000), status:currentStatus,
        meetingProvider:override?.meetingProvider??'Google Meet', meetingUrl:currentStatus==='cancelled'?null:(override?.meetingUrl??PILOT.meetingUrl), courseTitle:PILOT.courseTitle,moduleTitle:PILOT.moduleTitle,lessonTitle:override?.lessonId?SEEDED_LESSONS.find(item=>item.id===override.lessonId)?.title??title:title,teacherName:'Команда викладачів',materials:structuredClone(this.classMaterials.get(id)??[]) };
    };
    const upcoming = [...SEEDED_LESSONS.map((lesson,index)=>session(`71000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,lesson.title,1+index*7,'scheduled')),...this.createdClassSessions].filter(item=>new Date(item.endsAt)>=new Date()&&item.status!=='cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    return { timezone: PILOT.timezone, nextClass: upcoming[0] ?? null, today: upcoming.filter(item => new Date(item.startsAt).toDateString() === new Date().toDateString()), thisWeek: upcoming, upcoming, past: [] };
  }

  async listHomework(userId: string): Promise<HomeworkSummaryDto[]> {
    this.requireRole(userId,'student');
    const submissions = this.homeworkSubmissions.get(userId) ?? [];
    const latestFor=(homeworkId:string)=>submissions.filter(item=>this.submissionHomeworkIds.get(item.id)===homeworkId).sort((a,b)=>b.attemptNumber-a.attemptNumber)[0]??null;
    return SEEDED_HOMEWORK.map((instructions,index)=>{
      const id=`73000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
      const latest=latestFor(id);
      return {id,title:`Домашнє завдання · заняття ${index+1}`,instructions,publishedAt:relativeIso(1+index*7,18,30),dueAt:relativeIso(7+index*7,20),xpReward:SEEDED_LESSONS[index]!.xp,classTitle:SEEDED_LESSONS[index]!.title,state:latest?.status??'not_started',latestSubmission:latest};
    });
  }

  async submitHomework(userId: string, homeworkId: string, input: { contentText: string; contentUrl?: string; studentComment?: string }): Promise<HomeworkSubmissionDto> {
    const homework = await this.listHomework(userId);
    if (!homework.some(item => item.id === homeworkId)) throw new AppError('HOMEWORK_NOT_FOUND', 404, 'Домашнє завдання не знайдено');
    const attempts = this.homeworkSubmissions.get(userId) ?? [];
    const submission: HomeworkSubmissionDto = { id: randomUUID(), attemptNumber: attempts.filter(item => this.submissionHomeworkIds.get(item.id)===homeworkId).length + 1, submittedAt: nowIso(), studentComment: input.studentComment ?? '', contentText: input.contentText, contentUrl: input.contentUrl ?? null, status: 'submitted', review: null };
    attempts.push(submission);
    this.submissionHomeworkIds.set(submission.id,homeworkId);
    this.homeworkSubmissions.set(userId, attempts);
    return structuredClone(submission);
  }

  async getLearning(userId: string): Promise<LearningDto> {
    this.requireUser(userId);
    const state = this.lessonState.get(userId) ?? new Map();
    const firstIncompleteIndex = SEEDED_LESSONS.findIndex(lesson => (state.get(lesson.id)?.progressPercent ?? 0) < 100);
    const lessons: LessonSummaryDto[] = SEEDED_LESSONS.map((lesson, index) => {
      const progress = state.get(lesson.id)?.progressPercent ?? 0;
      const lessonState: LessonSummaryDto['state'] = progress === 100
        ? 'completed'
        : index === (firstIncompleteIndex < 0 ? SEEDED_LESSONS.length - 1 : firstIncompleteIndex)
          ? (progress > 0 ? 'current' : 'available')
          : 'locked';
      return {
        id: lesson.id,
        number: String(index + 1).padStart(2, '0'),
        title: lesson.title,
        summary: lesson.summary,
        estimatedMinutes: lesson.minutes,
        xpReward: lesson.xp,
        state: lessonState,
        progressPercent: progress
      };
    });
    const totalProgress = lessons.reduce((sum, lesson) => sum + lesson.progressPercent, 0);
    return {
      course: {
        id: DEV_IDS.course,
        title: PILOT.courseTitle,
        description: PILOT.courseDescription,
        progressPercent: Math.round(totalProgress / lessons.length),
        completedLessons: lessons.filter(lesson => lesson.state === 'completed').length,
        totalLessons: lessons.length
      },
      modules: [{
        id: DEV_IDS.module,
        number: '01',
        title: PILOT.moduleTitle,
        description: PILOT.moduleDescription,
        lessons
      }]
    };
  }

  async getLesson(userId: string, lessonId: string): Promise<LessonDto | null> {
    const learning = await this.getLearning(userId);
    const summary = learning.modules[0]?.lessons.find(lesson => lesson.id === lessonId);
    const sourceIndex = SEEDED_LESSONS.findIndex(lesson => lesson.id === lessonId);
    if (!summary || sourceIndex < 0) return null;
    if (summary.state === 'locked') throw new AppError('LESSON_LOCKED', 403, 'Цей урок ще не відкрито');
    const source = SEEDED_LESSONS[sourceIndex];
    if (!source) return null;
    return {
      ...summary,
      moduleTitle: PILOT.moduleTitle,
      content: JSON.parse(JSON.stringify(source.content)) as LessonDto['content'],
      nextLessonId: SEEDED_LESSONS[sourceIndex + 1]?.id ?? null
    };
  }

  async completeLesson(userId: string, lessonId: string, idempotencyKey: string): Promise<{ awardedXp: number; home: HomeDto }> {
    const lesson = await this.getLesson(userId, lessonId);
    if (!lesson) throw new AppError('LESSON_NOT_FOUND', 404, 'Урок не знайдено');
    const state = this.lessonState.get(userId) ?? new Map<string, LessonState>();
    this.lessonState.set(userId, state);
    const rewardKey = `lesson:${lessonId}:${idempotencyKey}`;
    let awardedXp = 0;
    if (!this.xpKeys.has(rewardKey) && state.get(lessonId)?.progressPercent !== 100) {
      state.set(lessonId, { progressPercent: 100, completedAt: nowIso() });
      this.xpKeys.add(rewardKey);
      this.xp.set(userId, (this.xp.get(userId) ?? 0) + lesson.xpReward);
      awardedXp = lesson.xpReward;
      this.bumpStreak(userId);
      if ((await this.getLearning(userId)).course.completedLessons >= 1) this.achievements.get(userId)?.add('first-spark');
    }
    return { awardedXp, home: await this.getHome(userId) };
  }

  async listProjects(userId: string): Promise<ProjectDto[]> {
    this.requireUser(userId);
    return (this.projects.get(userId) ?? []).map(project => this.projectDto(project));
  }

  async createProject(userId: string, input: { title: string; summary: string }): Promise<ProjectDto> {
    this.requireUser(userId);
    const project: InternalProject = {
      id: randomUUID(), title: input.title, summary: input.summary, status: 'active',
      stagePosition: 1, stageCode: 'idea', stageTitle: 'Ідея', tags: ['AI'], workspaceUrl: this.workspaceUrl ?? null,
      tasks: [
        { id: randomUUID(), number: '01', title: 'Сформулювати проблему', description: 'Опиши проблему конкретної людини.', status: 'in_progress', xpReward: 80, weight: 35 },
        { id: randomUUID(), number: '02', title: 'Описати користувача', description: 'Хто потребує рішення?', status: 'locked', xpReward: 100, weight: 25 },
        { id: randomUUID(), number: '03', title: 'Зібрати прототип', description: 'Перевір головний сценарій.', status: 'locked', xpReward: 160, weight: 25 },
        { id: randomUUID(), number: '04', title: 'Провести тест', description: 'Покажи рішення трьом людям.', status: 'locked', xpReward: 180, weight: 15 }
      ]
    };
    this.projects.get(userId)?.push(project);
    return this.projectDto(project);
  }

  async updateProject(userId: string, projectId: string, input: { title?: string; summary?: string }): Promise<ProjectDto | null> {
    const project = this.findProject(userId, projectId);
    if (!project) return null;
    if (input.title !== undefined) project.title = input.title;
    if (input.summary !== undefined) project.summary = input.summary;
    return this.projectDto(project);
  }

  async completeProjectTask(userId: string, projectId: string, taskId: string, idempotencyKey: string): Promise<{ awardedXp: number; project: ProjectDto } | null> {
    const project = this.findProject(userId, projectId);
    if (!project) return null;
    const taskIndex = project.tasks.findIndex(task => task.id === taskId);
    const task = project.tasks[taskIndex];
    if (!task) return null;
    if (task.status === 'locked') throw new AppError('TASK_LOCKED', 403, 'Це завдання ще не відкрито');
    const rewardKey = `project-task:${taskId}:${idempotencyKey}`;
    let awardedXp = 0;
    if (task.status !== 'completed' && !this.xpKeys.has(rewardKey)) {
      task.status = 'completed';
      this.xpKeys.add(rewardKey);
      this.xp.set(userId, (this.xp.get(userId) ?? 0) + task.xpReward);
      awardedXp = task.xpReward;
      this.bumpStreak(userId);
      const next = project.tasks[taskIndex + 1];
      if (next) next.status = 'in_progress';
      else project.status = 'completed';
      const completed = project.tasks.filter(item => item.status === 'completed').length;
      project.stagePosition = Math.min(STAGES.length, Math.max(1, completed + 1));
      const stage = STAGES[project.stagePosition - 1];
      if (stage) {
        project.stageCode = stage.code;
        project.stageTitle = stage.title;
      }
      if (completed >= 2) this.achievements.get(userId)?.add('builder');
    }
    return { awardedXp, project: this.projectDto(project) };
  }

  async getProfile(userId: string): Promise<ProfileDto> {
    const viewer = this.viewer(userId);
    const learning = await this.getLearning(userId);
    const projects = await this.listProjects(userId);
    const nextMin = viewer.level.nextMinXp;
    const range = nextMin === null ? 1 : nextMin - viewer.level.currentMinXp;
    const progress = nextMin === null ? 100 : Math.round(((viewer.xp - viewer.level.currentMinXp) / range) * 100);
    return {
      viewer,
      nextLevelProgressPercent: Math.max(0, Math.min(100, progress)),
      lessonCount: learning.course.completedLessons,
      projectCount: projects.length,
      achievements: await this.listAchievements(userId),
      mentor: { displayName: PILOT_TEACHERS[0].fullName, title: 'Ментор', avatarPath: null, nextMeetingAt: null }
    };
  }

  async listAchievements(userId: string): Promise<AchievementDto[]> {
    this.requireUser(userId);
    const earned = this.achievements.get(userId) ?? new Set();
    const definitions = [
      ['first-spark', 'First Spark', 'Перша завершена ідея', 'spark'],
      ['builder', 'Builder', 'Перші кроки MVP', 'build'],
      ['ai-explorer', 'AI Explorer', 'Діалог з AI ментором', 'explore'],
      ['demo-day', 'Demo Day', 'Завершений пітч', 'locked']
    ];
    return definitions.map(([code, title, description, style], index) => ({
      id: `50000000-0000-4000-8000-00000000000${index + 1}`,
      code: code ?? '', title: title ?? '', description: description ?? '', artifactStyleKey: style ?? 'locked',
      earned: earned.has(code ?? ''), awardedAt: earned.has(code ?? '') ? '2026-09-15T12:00:00.000Z' : null
    }));
  }

  async getPortfolio(userId: string): Promise<PortfolioDto> {
    this.requireRole(userId,'student');
    return {
      id: this.portfolioIds.get(userId)??`portfolio:${userId}`,
      title: 'Моє портфоліо',
      visibility: 'private',
      projects: structuredClone(this.portfolioProjects.get(userId) ?? []),
      skills: [
        { code: 'ai', title: 'AI', level: 3 },
        { code: 'critical-thinking', title: 'Критичне мислення', level: 2 },
        { code: 'product-thinking', title: 'Продуктове мислення', level: 2 },
        { code: 'presentation', title: 'Презентація', level: 1 }
      ]
    };
  }

  async addProjectToPortfolio(userId: string, projectId: string, input: { reflection?: string; learned?: string }): Promise<PortfolioDto> {
    const project = this.findProject(userId, projectId);
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 404, 'Проєкт не знайдено');
    const projects = this.portfolioProjects.get(userId) ?? [];
    if (!projects.some(item => item.projectId === projectId)) projects.push({
      id: randomUUID(), projectId, title: project.title, shortDescription: project.summary, reflection: input.reflection ?? '', learned: input.learned ?? '', skills: ['AI', 'Product thinking'], technologies: project.tags, demoUrl: project.workspaceUrl, coverPath: null, screenshots: [], completionDate: project.status === 'completed' ? new Date().toISOString().slice(0, 10) : null
    });
    this.portfolioProjects.set(userId, projects);
    return this.getPortfolio(userId);
  }

  async listMentorSlots(userId: string): Promise<MentorSlotDto[]> {
    this.requireRole(userId,'student');
    const booked = new Set((this.mentorBookings.get(userId) ?? []).filter(item => ['reserved', 'confirmed'].includes(item.status)).map(item => item.startsAt));
    return [2, 5].map((days, index) => {
      const startsAt = relativeIso(days, index ? 16 : 18);
      return { id: `91000000-0000-4000-8000-00000000000${index + 1}`, mentorId: PILOT.mentorId, mentorName: PILOT_TEACHERS[0].fullName, mentorTitle: 'Ментор', startsAt, endsAt: relativeIso(days, index ? 16 : 18, 30), timezone: PILOT.timezone, available: !booked.has(startsAt) };
    });
  }

  async bookMentorSlot(userId: string, availabilityId: string): Promise<MentorBookingDto> {
    const slot = (await this.listMentorSlots(userId)).find(item => item.id === availabilityId);
    if (!slot || !slot.available) throw new AppError('MENTOR_SLOT_UNAVAILABLE', 409, 'Цей час уже недоступний');
    const booking: MentorBookingDto = { id: randomUUID(), mentorId: slot.mentorId, mentorName: slot.mentorName, startsAt: slot.startsAt, endsAt: slot.endsAt, status: 'reserved', meetingUrl: null };
    const bookings = this.mentorBookings.get(userId) ?? [];
    bookings.push(booking);
    this.mentorBookings.set(userId, bookings);
    return structuredClone(booking);
  }

  async listTeacherGroups(userId: string): Promise<TeacherGroupDto[]> {
    this.requireRole(userId, 'teacher');
    return [{ id:PILOT.groupId,name:PILOT.groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:PILOT_STUDENTS.length,nextClassAt:relativeIso(1,17) }];
  }

  async listGroupStudents(userId: string, groupId: string): Promise<TeacherStudentDto[]> {
    this.requireRole(userId,'teacher');
    if(groupId!==PILOT.groupId) throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    return PILOT_STUDENTS.map(student=>({id:student.id,firstName:student.fullName,progressPercent:0,projectTitle:null}));
  }

  async createClassSession(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;title:string;description?:string;startsAt:string;endsAt:string;meetingUrl?:string;meetingProvider?:string}):Promise<ClassSessionDto>{
    this.requireRole(userId,'teacher'); if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    const created:ClassSessionDto={id:randomUUID(),title:input.title,description:input.description??'',startsAt:input.startsAt,endsAt:input.endsAt,durationMinutes:Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000),status:'scheduled',meetingProvider:input.meetingProvider??null,meetingUrl:input.meetingUrl??null,courseTitle:PILOT.courseTitle,moduleTitle:PILOT.moduleTitle,lessonTitle:input.lessonId?SEEDED_LESSONS.find(item=>item.id===input.lessonId)?.title??null:null,teacherName:this.requireUser(userId).displayName,materials:[]};
    this.createdClassSessions.push(created); return structuredClone(created);
  }
  async rescheduleClass(userId:string,sessionId:string,input:{startsAt:string;endsAt:string;reason?:string}):Promise<void>{this.requireRole(userId,'teacher');if(!this.teacherCanAccessSession(sessionId))throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');this.classSessionOverrides.set(sessionId,{...this.classSessionOverrides.get(sessionId),startsAt:input.startsAt,endsAt:input.endsAt,status:'rescheduled'});const created=this.createdClassSessions.find(item=>item.id===sessionId);if(created){created.startsAt=input.startsAt;created.endsAt=input.endsAt;created.durationMinutes=Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000);created.status='rescheduled';}}
  async confirmAttendance(userId:string,sessionId:string,studentId:string,status:'present'|'late'|'absent'|'excused',note?:string):Promise<void>{this.requireRole(userId,'teacher');if(!this.teacherCanAccessSession(sessionId)||!PILOT_STUDENTS.some(student=>student.id===studentId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const records=this.attendanceRecords.get(sessionId)??new Map();records.set(studentId,{status,note:note??'',confirmedAt:nowIso()});this.attendanceRecords.set(sessionId,records);}
  async createHomework(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;classSessionId?:string;title:string;instructions:string;publishAt?:string;dueAt?:string;xpReward:number;status:'draft'|'published';resources?:Array<{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}>}):Promise<HomeworkSummaryDto>{this.requireRole(userId,'teacher');if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');if(input.resources?.some(resource=>!resource.url.startsWith('https://')))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const id=randomUUID();this.teacherHomeworkItems.unshift({id,groupId:input.groupId,groupName:PILOT.groupName,classSessionId:input.classSessionId??null,title:input.title,instructions:input.instructions,publishAt:input.publishAt??null,dueAt:input.dueAt??null,xpReward:input.xpReward,status:input.status,submissionCount:0,reviewCount:0,needsRevisionCount:0,resources:(input.resources??[]).map(resource=>({id:randomUUID(),...resource}))});return{id,title:input.title,instructions:input.instructions,publishedAt:input.publishAt??'',dueAt:input.dueAt??null,xpReward:input.xpReward,classTitle:null,state:'not_started',latestSubmission:null};}
  async reviewHomework(userId:string,submissionId:string,input:{score:number;effort:EffortLevel;status:'reviewed'|'needs_revision'|'completed';feedback:string}):Promise<void>{this.requireRole(userId,'teacher');if(input.score<0||input.score>10||!Number.isInteger(input.score))throw new AppError('INVALID_SCORE',400,'Оцінка має бути цілим числом від 0 до 10');const submission=[...this.homeworkSubmissions.values()].flat().find(item=>item.id===submissionId);if(!submission)throw new AppError('SUBMISSION_FORBIDDEN',403,'Робота недоступна');submission.status=input.status==='needs_revision'?'needs_revision':input.status==='completed'?'completed':submission.status;submission.review={score:input.score,effort:input.effort,status:input.status,feedback:input.feedback,reviewedAt:nowIso()};}

  async getTeacherWorkspace(userId:string):Promise<TeacherWorkspaceDto>{
    this.requireRole(userId,'teacher');
    const groupId=PILOT.groupId; const groupName=PILOT.groupName;
    const groupStudents=await this.listGroupStudents(userId,groupId);
    const schedule=await this.getSchedule(DEV_IDS.user);
    const allSessions=[...schedule.upcoming,...schedule.past].map(item=>{
      const records=this.attendanceRecords.get(item.id)??new Map(); const override=this.classSessionOverrides.get(item.id);
      return {...item,groupId,groupName,lessonId:SEEDED_LESSONS.find(lesson=>lesson.title===item.lessonTitle)?.id??null,teacherNotes:override?.teacherNotes??'',materials:structuredClone(this.classMaterials.get(item.id)??item.materials),homeworkIds:this.teacherHomeworkItems.filter(homework=>homework.classSessionId===item.id).map(homework=>homework.id),attendance:groupStudents.map(student=>{const record=records.get(student.id);return{studentId:student.id,studentName:student.firstName,status:record?.status??null,suggestedStatus:null,note:record?.note??'',confirmedAt:record?.confirmedAt??null};})};
    });
    const submissions=[] as TeacherWorkspaceDto['submissions'];
    for(const [studentId,attempts] of this.homeworkSubmissions){
      const student=this.requireUser(studentId);
      for(const attempt of attempts){const homeworkId=this.submissionHomeworkIds.get(attempt.id);const homework=this.teacherHomeworkItems.find(item=>item.id===homeworkId);if(!homework)continue;submissions.push({id:attempt.id,homeworkId:homework.id,homeworkTitle:homework.title,groupId,groupName,studentId,studentName:student.displayName,attemptNumber:attempt.attemptNumber,submittedAt:attempt.submittedAt,studentComment:attempt.studentComment,contentText:attempt.contentText,contentUrl:attempt.contentUrl,status:attempt.status,review:structuredClone(attempt.review),attachments:[],previousAttempts:attempts.filter(item=>this.submissionHomeworkIds.get(item.id)===homework.id&&item.attemptNumber<attempt.attemptNumber).map(item=>structuredClone(item))});}
    }
    submissions.sort((a,b)=>Date.parse(b.submittedAt??'')-Date.parse(a.submittedAt??''));
    const students=[] as TeacherWorkspaceDto['students'];
    for(const student of groupStudents){
      const learning=await this.getLearning(student.id); const projects=await this.listProjects(student.id); const portfolio=await this.getPortfolio(student.id); const attempts=this.homeworkSubmissions.get(student.id)??[];const scores=attempts.flatMap(item=>item.review?[item.review.score]:[]);const effort=attempts.map(item=>item.review?.effort).find(Boolean)??null;
      const attendance=[...this.attendanceRecords.values()].map(records=>records.get(student.id)?.status).filter(Boolean); const reasons:string[]=[];
      if(attendance.filter(value=>value==='absent').length>=2)reasons.push('2 або більше пропущених занять');
      if(attempts.filter(item=>item.status==='needs_revision').length)reasons.push('Є робота на доопрацюванні');
      if(!projects.length)reasons.push('Ще немає активного проєкту');
      students.push({...student,groupId,groupName,courseTitle:learning.course.title,moduleTitle:learning.modules[0]?.title??'',xp:this.xp.get(student.id)??0,level:LEVELS.filter(level=>(this.xp.get(student.id)??0)>=level.minXp).at(-1)?.title??LEVELS[0]!.title,attendance:{present:attendance.filter(value=>value==='present').length,late:attendance.filter(value=>value==='late').length,absent:attendance.filter(value=>value==='absent').length,excused:attendance.filter(value=>value==='excused').length},homework:{assigned:this.teacherHomeworkItems.filter(item=>item.status==='published').length,submitted:attempts.length,needsRevision:attempts.filter(item=>item.status==='needs_revision').length,averageScore:scores.length?Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length*10)/10:null,effort:effort as EffortLevel|null},projects,portfolio,mentorBookings:structuredClone(this.mentorBookings.get(student.id)??[]),notes:structuredClone(this.teacherNotes.filter(note=>note.studentId===student.id)),attentionReasons:reasons,recentActivityAt:attempts.map(item=>item.submittedAt).filter(Boolean).sort().at(-1)??null});
    }
    const todayKey=new Date().toISOString().slice(0,10); const attention=students.filter(student=>student.attentionReasons.length).map(student=>({studentId:student.id,studentName:student.firstName,reasons:student.attentionReasons}));
    const teacher=PILOT_TEACHERS.find(item=>item.id===userId)??PILOT_TEACHERS[0];
    return{teacher:{id:userId,name:teacher.fullName,title:teacher.title,timezone:PILOT.timezone},metrics:{todayClasses:allSessions.filter(item=>item.startsAt.slice(0,10)===todayKey).length,awaitingReview:submissions.filter(item=>item.status==='submitted'&&!item.review).length,resubmitted:submissions.filter(item=>item.attemptNumber>1&&item.status==='submitted').length,mentorToday:this.teacherMentorBookings.filter(item=>item.startsAt.slice(0,10)===todayKey).length,reportsPending:this.teacherReports.filter(item=>['draft','ready_for_review'].includes(item.status)).length},groups:[{id:groupId,courseId:DEV_IDS.course,name:groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:groupStudents.length,nextClassAt:schedule.nextClass?.startsAt??null,scheduleLabel:'8 занять · розклад уточнюється',progressPercent:Math.round(groupStudents.reduce((sum,item)=>sum+item.progressPercent,0)/groupStudents.length),attendanceRate:0,recentHomework:this.teacherHomeworkItems[0]?.title??null}],sessions:allSessions,homework:structuredClone(this.teacherHomeworkItems),submissions,students,mentor:{mentorId:teacher.mentor?PILOT.mentorId:null,availability:teacher.mentor?structuredClone(this.teacherMentorAvailability):[],bookings:teacher.mentor?structuredClone(this.teacherMentorBookings):[]},reports:structuredClone(this.teacherReports),lessons:SEEDED_LESSONS.map(lesson=>({id:lesson.id,title:lesson.title,moduleTitle:PILOT.moduleTitle})),attention};
  }

  async searchTeacherScope(userId:string,query:string):Promise<TeacherSearchDto>{const data=await this.getTeacherWorkspace(userId);const term=query.trim().toLocaleLowerCase('uk');const includes=(value:string)=>value.toLocaleLowerCase('uk').includes(term);return{students:data.students.filter(item=>includes(item.firstName)).map(item=>({id:item.id,label:item.firstName,meta:item.groupName})),groups:data.groups.filter(item=>includes(item.name)||includes(item.courseTitle)).map(item=>({id:item.id,label:item.name,meta:item.courseTitle})),homework:data.homework.filter(item=>includes(item.title)).map(item=>({id:item.id,label:item.title,meta:item.groupName})),projects:data.students.flatMap(student=>student.projects.filter(project=>includes(project.title)).map(project=>({id:project.id,label:project.title,meta:student.firstName})))}};

  async updateTeacherClass(userId:string,sessionId:string,input:{title?:string;description?:string;lessonId?:string|null;meetingUrl?:string|null;meetingProvider?:string|null;teacherNotes?:string;status?:'scheduled'|'in_progress'|'completed'|'cancelled'}):Promise<void>{this.requireRole(userId,'teacher');if(!this.teacherCanAccessSession(sessionId))throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const override={...this.classSessionOverrides.get(sessionId),...input};this.classSessionOverrides.set(sessionId,override);const created=this.createdClassSessions.find(item=>item.id===sessionId);if(created){if(input.title!==undefined)created.title=input.title;if(input.description!==undefined)created.description=input.description;if(input.meetingUrl!==undefined)created.meetingUrl=input.meetingUrl;if(input.meetingProvider!==undefined)created.meetingProvider=input.meetingProvider;if(input.status!==undefined)created.status=input.status;}}
  async addClassMaterial(userId:string,sessionId:string,input:{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}):Promise<void>{this.requireRole(userId,'teacher');if(!this.teacherCanAccessSession(sessionId))throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(!input.url.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const materials=this.classMaterials.get(sessionId)??[];materials.push({id:randomUUID(),kind:input.kind,title:input.title,url:input.url});this.classMaterials.set(sessionId,materials);}
  async bulkConfirmAttendance(userId:string,sessionId:string,entries:Array<{studentId:string;status:'present'|'late'|'absent'|'excused';note?:string}>):Promise<void>{this.requireRole(userId,'teacher');if(!entries.length)throw new AppError('ATTENDANCE_EMPTY',400,'Додайте учнів');for(const entry of entries)await this.confirmAttendance(userId,sessionId,entry.studentId,entry.status,entry.note);}
  async publishHomework(userId:string,homeworkId:string,publishAt:string):Promise<void>{this.requireRole(userId,'teacher');const homework=this.teacherHomeworkItems.find(item=>item.id===homeworkId);if(!homework)throw new AppError('HOMEWORK_FORBIDDEN',403,'Домашня робота недоступна');if(homework.status!=='draft')throw new AppError('HOMEWORK_STATE',409,'Опублікувати можна лише чернетку');if(homework.dueAt&&Date.parse(homework.dueAt)<=Date.parse(publishAt))throw new AppError('INVALID_TIME',400,'Дедлайн має бути після публікації');homework.status='published';homework.publishAt=publishAt;}
  async createTeacherNote(userId:string,studentId:string,input:{category:'general'|'learning'|'project'|'mentoring';content:string}):Promise<TeacherPrivateNoteDto>{this.requireRole(userId,'teacher');if(!PILOT_STUDENTS.some(student=>student.id===studentId))throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');const timestamp=nowIso();const note={id:randomUUID(),studentId,category:input.category,content:input.content,createdAt:timestamp,updatedAt:timestamp};this.teacherNotes.unshift(note);return structuredClone(note);}
  async updatePortfolioItemAsTeacher(userId:string,portfolioProjectId:string,input:{title?:string|null;shortDescription?:string;reflection?:string;learned?:string}):Promise<void>{this.requireRole(userId,'teacher');const item=[...this.portfolioProjects.values()].flat().find(project=>project.id===portfolioProjectId);if(!item)throw new AppError('PORTFOLIO_FORBIDDEN',403,'Елемент портфоліо недоступний');if(input.title)item.title=input.title;if(input.shortDescription!==undefined)item.shortDescription=input.shortDescription;if(input.reflection!==undefined)item.reflection=input.reflection;if(input.learned!==undefined)item.learned=input.learned;}
  async createMentorAvailability(userId:string,input:{startsAt:string;endsAt:string;timezone:string;status:'open'|'blocked'}):Promise<void>{this.requireRole(userId,'teacher');if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний часовий інтервал');const overlaps=this.teacherMentorAvailability.some(item=>!['cancelled'].includes(item.status)&&Date.parse(item.startsAt)<Date.parse(input.endsAt)&&Date.parse(item.endsAt)>Date.parse(input.startsAt))||this.teacherMentorBookings.some(item=>['reserved','confirmed','rescheduled'].includes(item.status)&&Date.parse(item.startsAt)<Date.parse(input.endsAt)&&Date.parse(item.endsAt)>Date.parse(input.startsAt));if(overlaps)throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час перетинається з іншим вікном або зустріччю');this.teacherMentorAvailability.push({id:randomUUID(),mentorId:'60000000-0000-4000-8000-000000000001',...input});}
  async updateMentorBooking(userId:string,bookingId:string,input:{status:'confirmed'|'completed'|'cancelled'|'rescheduled'|'no_show';meetingUrl?:string|null;startsAt?:string;endsAt?:string}):Promise<void>{this.requireRole(userId,'teacher');const booking=this.teacherMentorBookings.find(item=>item.id===bookingId);if(!booking)throw new AppError('BOOKING_FORBIDDEN',403,'Бронювання недоступне');if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');if(input.status==='rescheduled'&&(!input.startsAt||!input.endsAt||Date.parse(input.endsAt)<=Date.parse(input.startsAt)))throw new AppError('INVALID_TIME',400,'Для переносу потрібен новий час');if(input.status==='rescheduled'&&this.teacherMentorBookings.some(item=>item.id!==bookingId&&['reserved','confirmed','rescheduled'].includes(item.status)&&Date.parse(item.startsAt)<Date.parse(input.endsAt!)&&Date.parse(item.endsAt)>Date.parse(input.startsAt!)))throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час зайнятий іншою зустріччю');booking.status=input.status;if(input.meetingUrl!==undefined)booking.meetingUrl=input.meetingUrl;if(input.startsAt)booking.startsAt=input.startsAt;if(input.endsAt)booking.endsAt=input.endsAt;}
  async generateTeacherReports(userId:string,groupId:string,periodStart:string,periodEnd:string):Promise<void>{this.requireRole(userId,'teacher');if(groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');for(const student of await this.listGroupStudents(userId,groupId)){if(this.teacherReports.some(report=>report.studentId===student.id&&report.periodStart===periodStart&&report.periodEnd===periodEnd))continue;this.teacherReports.push({id:randomUUID(),studentId:student.id,studentFirstName:student.firstName,groupId,groupName:PILOT.groupName,periodStart,periodEnd,payload:{classesScheduled:SEEDED_LESSONS.length,classesAttended:0,homeworkSubmitted:(this.homeworkSubmissions.get(student.id)??[]).length,project:student.projectTitle,projectProgress:student.progressPercent,xpEarned:0},teacherComment:'',status:'draft',approvedAt:null});}}
  async saveTeacherReport(userId:string,reportId:string,input:{teacherComment:string;status:'draft'|'ready_for_review'}):Promise<void>{this.requireRole(userId,'teacher');const report=this.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');report.teacherComment=input.teacherComment;report.status=input.status;}
  async approveTeacherReport(userId:string,reportId:string):Promise<void>{this.requireRole(userId,'teacher');const report=this.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');if(report.status!=='ready_for_review'||!report.teacherComment.trim())throw new AppError('REPORT_NOT_READY',409,'Звіт ще не готовий до підтвердження');report.status='approved';report.approvedAt=nowIso();}
  async listLinkedStudents(userId:string):Promise<TeacherStudentDto[]>{this.requireRole(userId,'guardian');return[{id:DEV_IDS.user,firstName:PILOT_STUDENTS[0].fullName,progressPercent:0,projectTitle:null}];}
  async listParentReports(userId:string,studentId:string):Promise<ParentReportDto[]>{this.requireRole(userId,'guardian');if(studentId!==DEV_IDS.user)throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');return structuredClone(this.teacherReports.filter(report=>report.studentId===studentId&&['approved','sent'].includes(report.status)).map(report=>({id:report.id,studentId:report.studentId,studentFirstName:PILOT_STUDENTS[0].fullName,periodStart:report.periodStart,periodEnd:report.periodEnd,payload:report.payload,teacherComment:report.teacherComment,status:report.status})));}

  async getAdminWorkspace(userId:string):Promise<AdminWorkspaceDto>{
    this.requireRole(userId,'admin');const teacher=await this.getTeacherWorkspace(userId);const now=Date.now();
    const students=teacher.students.map(student=>({id:student.id,name:student.firstName,status:this.users.get(student.id)?.status??'active',group:student.groupName,course:student.courseTitle,progress:student.progressPercent,xp:student.xp,level:student.level,streak:this.streak.get(student.id)??0,attendance:student.attendance,homework:student.homework,project:student.projectTitle,guardianLinked:false,telegramLinked:[...this.identities.values()].includes(student.id)}));
    const teachers=PILOT_TEACHERS.map(item=>({id:item.id,name:item.fullName,status:this.users.get(item.id)?.status,groups:1,upcomingClasses:teacher.sessions.filter(session=>Date.parse(session.startsAt)>now&&session.status!=='cancelled').length,classesTaught:teacher.sessions.filter(session=>session.status==='completed').length,reviews:teacher.submissions.filter(submission=>submission.review).length,mentor:item.mentor}));
    const guardians:Array<Record<string,unknown>>=[];
    const sessions=teacher.sessions.map(item=>({id:item.id,title:item.title,group:item.groupName,teacher:item.teacherName,lesson:item.lessonTitle,startsAt:item.startsAt,durationMinutes:item.durationMinutes,status:item.status,meetingProvider:item.meetingProvider,meetingUrl:item.meetingUrl,attendanceComplete:item.attendance.every(entry=>entry.status)}));
    const homework=teacher.homework.map(item=>({id:item.id,title:item.title,group:item.groupName,status:item.status,dueAt:item.dueAt,submissions:item.submissionCount,reviews:item.reviewCount,revisions:item.needsRevisionCount}));
    const projects=teacher.students.flatMap(student=>student.projects.map(project=>({id:project.id,studentId:student.id,student:student.firstName,title:project.title,stage:project.stage.title,progress:project.completionPercent,technologies:project.tags,status:project.status})));
    const portfolios=teacher.students.map(student=>({id:student.portfolio?.id??`portfolio:${student.id}`,studentId:student.id,student:student.firstName,title:student.portfolio?.title??'Портфоліо',visibility:student.portfolio?.id?this.portfolioVisibility.get(student.portfolio.id)??student.portfolio.visibility:'private',items:student.portfolio?.projects.length??0}));
    const activeSessions=(await this.sessionStore.listActive(new Date(now))).map(item=>({id:item.id,userId:item.userId,user:this.users.get(item.userId)?.displayName??'Користувач',role:this.roles.get(item.userId),provider:item.provider,createdAt:item.createdAt.toISOString(),expiresAt:item.expiresAt.toISOString(),status:'active'}));
    const reports=teacher.reports.map(item=>({...item,guardianRelationshipActive:this.guardianLinks.get('92000000-0000-4000-8000-000000000001')==='active'}));
    return{admin:{id:userId,name:this.requireUser(userId).displayName,role:'admin',mfaRequired:true},metrics:{activeStudents:students.filter(item=>item.status==='active').length,activeGroups:teacher.groups.length,teachers:teachers.length,upcomingClasses:sessions.filter(item=>Date.parse(String(item.startsAt))>now&&!['cancelled','completed'].includes(String(item.status))).length,classesToday:sessions.filter(item=>String(item.startsAt).slice(0,10)===new Date().toISOString().slice(0,10)).length,awaitingReview:teacher.metrics.awaitingReview,needsRevision:teacher.homework.reduce((sum,item)=>sum+item.needsRevisionCount,0),mentorBookings:teacher.mentor.bookings.length,attendanceIssues:teacher.students.reduce((sum,item)=>sum+item.attendance.absent+item.attendance.late,0),reportsAwaiting:reports.filter(item=>item.status==='ready_for_review').length,recentProjects:projects.length,portfolioMilestones:portfolios.reduce((sum,item)=>sum+Number(item.items),0)},students,teachers,guardians,groups:teacher.groups.map(item=>({...item})),sessions,homework,projects,portfolios,mentorBookings:teacher.mentor.bookings.map(item=>({...item})),reports,notifications:structuredClone(this.adminNotifications),activeSessions,auditEvents:structuredClone(this.adminAuditEvents),securityEvents:structuredClone(this.securityEvents),health:{productionMode:{status:'warning',label:'Перевіряється з server environment'},database:{status:'ok',label:'Repository доступний'},rls:{status:'warning',label:'Потребує integration test'},telegram:{status:'warning',label:'Статус без розкриття секрету'},storage:{status:'required',label:'Приватне сховище потребує конфігурації'},signingKeys:{status:'ok',label:'JWT signer завантажений'},devAuth:{status:'warning',label:'Дозволено лише поза production'},origins:{status:'ok',label:'Allowlist налаштовано'},securityHeaders:{status:'ok',label:'Helmet/CSP увімкнено'}}};
  }

  async searchAdmin(userId:string,query:string):Promise<AdminSearchDto>{const data=await this.getAdminWorkspace(userId),term=query.toLocaleLowerCase('uk'),match=(value:unknown)=>String(value??'').toLocaleLowerCase('uk').includes(term);return{results:[...data.students.filter(x=>match(x.name)).map(x=>({type:'student' as const,id:String(x.id),label:String(x.name),meta:String(x.group)})),...data.teachers.filter(x=>match(x.name)).map(x=>({type:'teacher' as const,id:String(x.id),label:String(x.name),meta:'Викладач'})),...data.guardians.filter(x=>match(x.name)).map(x=>({type:'guardian' as const,id:String(x.id),label:String(x.name),meta:'Батьки'})),...data.groups.filter(x=>match(x.name)).map(x=>({type:'group' as const,id:String(x.id),label:String(x.name),meta:String(x.courseTitle)})),...data.sessions.filter(x=>match(x.title)).map(x=>({type:'class' as const,id:String(x.id),label:String(x.title),meta:String(x.group)})),...data.projects.filter(x=>match(x.title)).map(x=>({type:'project' as const,id:String(x.id),label:String(x.title),meta:String(x.student)}))].slice(0,30)}};

  async exploreAdmin(userId:string,input:{entity:AdminEntity;page:number;pageSize:number;sort:string;direction:'asc'|'desc';query?:string}):Promise<AdminExplorerPageDto>{const data=await this.getAdminWorkspace(userId);const map:Record<AdminEntity,Array<Record<string,unknown>>>={users:[...data.students,...data.teachers,...data.guardians],students:data.students,teachers:data.teachers,guardians:data.guardians,groups:data.groups,courses:[{id:DEV_IDS.course,title:PILOT.courseTitle,status:'published'}],modules:[{id:DEV_IDS.module,title:PILOT.moduleTitle,status:'published'}],lessons:SEEDED_LESSONS.map((item,index)=>({id:item.id,title:item.title,position:index+1,status:'published'})),sessions:data.sessions,attendance:(await this.getTeacherWorkspace(userId)).sessions.flatMap(item=>item.attendance.map(entry=>({id:`${item.id}:${entry.studentId}`,session:item.title,student:entry.studentName,status:entry.status,confirmedAt:entry.confirmedAt}))),homework:data.homework,submissions:(await this.getTeacherWorkspace(userId)).submissions.map(item=>({id:item.id,homework:item.homeworkTitle,student:item.studentName,attempt:item.attemptNumber,status:item.status,submittedAt:item.submittedAt})),reviews:(await this.getTeacherWorkspace(userId)).submissions.filter(item=>item.review).map(item=>({id:item.id,student:item.studentName,score:item.review!.score,effort:item.review!.effort,status:item.review!.status})),projects:data.projects,portfolios:data.portfolios,mentor_bookings:data.mentorBookings,reports:data.reports};let records=map[input.entity];const allowedSorts=new Set(records.length?Object.keys(records[0]!):['id']);if(!allowedSorts.has(input.sort))throw new AppError('INVALID_SORT',400,'Недозволене поле сортування');if(input.query){const term=input.query.toLocaleLowerCase('uk');records=records.filter(item=>Object.values(item).some(value=>String(value??'').toLocaleLowerCase('uk').includes(term)));}records=[...records].sort((left,right)=>String(left[input.sort]??'').localeCompare(String(right[input.sort]??''),'uk')*(input.direction==='asc'?1:-1));const total=records.length,start=(input.page-1)*input.pageSize;return{entity:input.entity,page:input.page,pageSize:input.pageSize,total,sort:input.sort,direction:input.direction,records:structuredClone(records.slice(start,start+input.pageSize))};}

  async adminSetAccountStatus(userId:string,targetUserId:string,status:'active'|'disabled'|'archived',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(userId===targetUserId&&status!=='active')throw new AppError('ADMIN_SELF_LOCKOUT',409,'Не можна вимкнути власний обліковий запис');const target=this.requireUser(targetUserId),previous=target.status;target.status=status;if(status!=='active')await this.sessionStore.revokeUser(targetUserId,new Date());this.audit(userId,'account.status_changed','user',targetUserId,{previous,status,reason},correlationId);}
  async adminCorrectAttendance(userId:string,attendanceId:string,status:'present'|'late'|'absent'|'excused',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(attendanceId!=='72000000-0000-4000-8000-000000000011')throw new AppError('ATTENDANCE_NOT_FOUND',404,'Відвідування не знайдено');const records=this.attendanceRecords.get('71000000-0000-4000-8000-000000000003')!,entry=records.get(DEV_IDS.user)!;const previous=entry.status;entry.status=status;entry.confirmedAt=nowIso();this.audit(userId,'attendance.corrected','attendance',attendanceId,{previous,status,reason},correlationId);}
  async adminSetPortfolioVisibility(userId:string,portfolioId:string,visibility:'private'|'shareable'|'public',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(!this.portfolioVisibility.has(portfolioId))throw new AppError('PORTFOLIO_NOT_FOUND',404,'Портфоліо не знайдено');const previous=this.portfolioVisibility.get(portfolioId);this.portfolioVisibility.set(portfolioId,visibility);this.audit(userId,'portfolio.visibility_changed','portfolio',portfolioId,{previous,visibility,reason},correlationId);}
  async adminRevokeGuardianLink(userId:string,linkId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(!this.guardianLinks.has(linkId))throw new AppError('GUARDIAN_LINK_NOT_FOUND',404,'Зв’язок не знайдено');this.guardianLinks.set(linkId,'revoked');this.audit(userId,'guardian.relationship_revoked','guardian_link',linkId,{reason},correlationId);}
  async adminResendReport(userId:string,reportId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const report=this.teacherReports.find(item=>item.id===reportId);if(!report||!['approved','sent','failed'].includes(report.status)||this.guardianLinks.get('92000000-0000-4000-8000-000000000001')!=='active')throw new AppError('REPORT_RESEND_FORBIDDEN',409,'Звіт не готовий або зв’язок із батьками неактивний');this.adminNotifications.unshift({id:randomUUID(),category:'parent_weekly_report',recipient:'Опікун',status:'pending',scheduledAt:nowIso(),attempts:0});this.audit(userId,'report.resend_requested','parent_report',reportId,{},correlationId);}
  async adminRevokeUserSession(userId:string,sessionId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const session=await this.sessionStore.revokeById(sessionId,new Date());if(!session)throw new AppError('SESSION_NOT_FOUND',404,'Сесію не знайдено');this.audit(userId,'session.revoked','auth_session',sessionId,{subjectUserId:session.userId,reason},correlationId);this.securityEvents.unshift({id:randomUUID(),type:'forced_session_revocation',severity:'medium',actorId:userId,targetId:session.userId,createdAt:nowIso(),correlationId});}
  async recordSecurityEvent(input:{eventType:string;severity:'low'|'medium'|'high'|'critical';actorUserId?:string;targetUserId?:string;metadata?:Record<string,unknown>;correlationId:string}):Promise<void>{this.securityEvents.unshift({id:randomUUID(),type:input.eventType,severity:input.severity,actorId:input.actorUserId??null,targetId:input.targetUserId??null,metadata:input.metadata??{},correlationId:input.correlationId,createdAt:nowIso()});}

  private audit(actorId:string,action:string,targetType:string,targetId:string,metadata:Record<string,unknown>,correlationId:string):void{this.adminAuditEvents.unshift({id:randomUUID(),actorId,actor:this.users.get(actorId)?.displayName,action,targetType,targetId,metadata,correlationId,createdAt:nowIso()});}

  async listConversations(userId: string): Promise<AiConversationDto[]> {
    this.requireUser(userId);
    return (this.conversations.get(userId) ?? []).map(({ summary: _summary, messages: _messages, clientMessageIds: _ids, ...conversation }) => structuredClone(conversation));
  }

  async createConversation(userId: string, title = 'Нова розмова'): Promise<AiConversationDto> {
    this.requireUser(userId);
    const home = await this.getHome(userId);
    const createdAt = nowIso();
    const conversation: InternalConversation = {
      id: randomUUID(), title, courseId: home.course.id, lessonId: home.currentLesson?.id ?? null,
      projectId: home.currentProject?.id ?? null, createdAt, updatedAt: createdAt,
      summary: '', messages: [], clientMessageIds: new Set()
    };
    this.conversations.get(userId)?.push(conversation);
    const { summary: _summary, messages: _messages, clientMessageIds: _ids, ...dto } = conversation;
    return structuredClone(dto);
  }

  async getConversation(userId: string, conversationId: string): Promise<AiConversationDto | null> {
    const conversation = this.findConversation(userId, conversationId);
    if (!conversation) return null;
    const { summary: _summary, messages: _messages, clientMessageIds: _ids, ...dto } = conversation;
    return structuredClone(dto);
  }

  async listMessages(userId: string, conversationId: string, limit: number, before?: string): Promise<AiMessageDto[]> {
    const conversation = this.findConversation(userId, conversationId);
    if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', 404, 'Розмову не знайдено');
    const beforeTime = before ? Date.parse(before) : Number.POSITIVE_INFINITY;
    return structuredClone(conversation.messages.filter(message => Date.parse(message.createdAt) < beforeTime).slice(-limit));
  }

  async appendAiMessage(userId: string, conversationId: string, input: Omit<AiMessageDto, 'id' | 'createdAt'> & { clientMessageId?: string }): Promise<AiMessageDto | null> {
    const conversation = this.findConversation(userId, conversationId);
    if (!conversation) return null;
    if (input.clientMessageId && conversation.clientMessageIds.has(input.clientMessageId)) {
      return conversation.messages.find(message => message.content === input.content && message.role === input.role) ?? null;
    }
    const message: AiMessageDto = { id: randomUUID(), role: input.role, content: input.content, createdAt: nowIso() };
    conversation.messages.push(message);
    if (input.clientMessageId) conversation.clientMessageIds.add(input.clientMessageId);
    conversation.updatedAt = message.createdAt;
    return structuredClone(message);
  }

  async getAiContext(userId: string, conversationId: string): Promise<AiContextDto | null> {
    const conversation = this.findConversation(userId, conversationId);
    if (!conversation) return null;
    const learning = await this.getLearning(userId);
    const current = learning.modules.flatMap(module => module.lessons).find(lesson => lesson.state === 'current' || lesson.state === 'available') ?? null;
    const module = learning.modules.find(item => item.lessons.some(lesson => lesson.id === current?.id)) ?? null;
    const project = (await this.listProjects(userId)).find(item => item.status === 'active') ?? null;
    return {
      firstName: this.studentDisplayNames.get(userId) ?? this.requireUser(userId).displayName,
      courseTitle: learning.course.title,
      moduleTitle: module?.title ?? null,
      lessonTitle: current?.title ?? null,
      lessonSummary: current?.summary ?? null,
      projectTitle: project?.title ?? null,
      projectSummary: project?.summary ?? null,
      projectStage: project?.stage.title ?? null,
      nextProjectTask: project?.tasks.find(task => task.status === 'in_progress' || task.status === 'available')?.title ?? null,
      conversationSummary: conversation.summary,
      recentMessages: structuredClone(conversation.messages.slice(-12))
    };
  }

  async updateConversationSummary(conversationId: string, summary: string): Promise<void> {
    for (const conversations of this.conversations.values()) {
      const conversation = conversations.find(item => item.id === conversationId);
      if (conversation) conversation.summary = summary.slice(0, 4000);
    }
  }

  private loadTelegramBindings(raw: string | undefined): void {
    if (!raw?.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('TELEGRAM_STUDENT_BINDINGS_JSON must be valid JSON');
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('TELEGRAM_STUDENT_BINDINGS_JSON must be a JSON object');
    }
    const seenTelegramIds = new Set<string>();
    for (const [studentKey, telegramId] of Object.entries(parsed)) {
      const student = PILOT_STUDENTS.find(item => item.key === studentKey);
      if (!student) throw new Error(`Unknown pilot student key in TELEGRAM_STUDENT_BINDINGS_JSON: ${studentKey}`);
      if (typeof telegramId !== 'string' || !/^\d{5,20}$/.test(telegramId)) {
        throw new Error(`Invalid Telegram user ID for pilot student: ${studentKey}`);
      }
      if (seenTelegramIds.has(telegramId)) throw new Error('Telegram user IDs must be unique');
      seenTelegramIds.add(telegramId);
      this.identities.set(`telegram:${telegramId}`, student.id);
    }
  }

  private requireUser(userId: string): AuthUser {
    const user = this.users.get(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 404, 'Користувача не знайдено');
    return user;
  }

  private requireRole(userId:string,role:'student'|'guardian'|'teacher'|'admin'):void{this.requireUser(userId);if(this.roles.get(userId)!==role&&this.roles.get(userId)!=='admin')throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав');}

  private teacherCanAccessSession(sessionId:string):boolean{return SEEDED_LESSONS.some((_,index)=>sessionId===`71000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`)||this.createdClassSessions.some(item=>item.id===sessionId);}

  private viewer(userId: string) {
    const user = this.requireUser(userId);
    const xp = this.xp.get(userId) ?? 0;
    let levelIndex = 0;
    for (let index = 0; index < LEVELS.length; index += 1) {
      if (xp >= LEVELS[index]!.minXp) levelIndex = index;
    }
    const level = LEVELS[levelIndex] ?? LEVELS[0]!;
    const next = LEVELS[levelIndex + 1] ?? null;
    return {
      id: user.id,
      firstName: this.studentDisplayNames.get(userId) ?? user.displayName,
      level: { number: level.number, title: level.title, nextTitle: next?.title ?? null, currentMinXp: level.minXp, nextMinXp: next?.minXp ?? null },
      xp,
      streak: this.streak.get(userId) ?? 0
    };
  }

  private projectDto(project: InternalProject): ProjectDto {
    const completionPercent = project.tasks.filter(task => task.status === 'completed').reduce((sum, task) => sum + task.weight, 0);
    return {
      id: project.id, title: project.title, summary: project.summary, status: project.status,
      completionPercent, tags: [...project.tags], workspaceUrl: project.workspaceUrl,
      stage: { id: STAGES[project.stagePosition - 1]?.id ?? DEV_IDS.stage, code: project.stageCode, title: project.stageTitle, position: project.stagePosition, total: STAGES.length },
      tasks: structuredClone(project.tasks)
    };
  }

  private findProject(userId: string, projectId: string): InternalProject | undefined {
    this.requireUser(userId);
    return this.projects.get(userId)?.find(project => project.id === projectId);
  }

  private findConversation(userId: string, conversationId: string): InternalConversation | undefined {
    this.requireUser(userId);
    return this.conversations.get(userId)?.find(conversation => conversation.id === conversationId);
  }

  private bumpStreak(userId: string): void {
    this.streak.set(userId, Math.max(1, this.streak.get(userId) ?? 0));
  }
}
