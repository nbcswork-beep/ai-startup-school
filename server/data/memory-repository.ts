import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import type { AppRepository } from './repository.js';
import { DEV_IDS, SEEDED_LESSONS } from './seed.js';
import type {
  AchievementDto,
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
  RotationResult,
  TelegramIdentityInput
} from '../types/domain.js';

type LessonState = { progressPercent: number; completedAt: string | null };
type InternalProject = Omit<ProjectDto, 'completionPercent' | 'stage'> & { stagePosition: number; stageCode: string; stageTitle: string };
type InternalConversation = AiConversationDto & { summary: string; messages: AiMessageDto[]; clientMessageIds: Set<string> };

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
    [DEV_IDS.user, { id: DEV_IDS.user, displayName: 'Максим', status: 'active' }],
    ['12000000-0000-4000-8000-000000000001', { id: '12000000-0000-4000-8000-000000000001', displayName: 'Анна Коваль', status: 'active' }],
    ['13000000-0000-4000-8000-000000000001', { id: '13000000-0000-4000-8000-000000000001', displayName: 'Олена', status: 'active' }],
    ['10000000-0000-4000-8000-000000000002', { id: '10000000-0000-4000-8000-000000000002', displayName: 'Ірина', status: 'active' }]
  ]);
  private roles = new Map<string, 'student'|'guardian'|'teacher'|'admin'>([[DEV_IDS.user,'student'],['12000000-0000-4000-8000-000000000001','teacher'],['13000000-0000-4000-8000-000000000001','guardian'],['10000000-0000-4000-8000-000000000002','student']]);
  private identities = new Map<string, string>();
  private sessions = new Map<string, NewSession & { revokedAt: Date | null; replacedBy: string | null }>();
  private xp = new Map<string, number>([[DEV_IDS.user, 640]]);
  private streak = new Map<string, number>([[DEV_IDS.user, 4]]);
  private lessonState = new Map<string, Map<string, LessonState>>([
    [DEV_IDS.user, new Map([
      [SEEDED_LESSONS[0].id, { progressPercent: 100, completedAt: '2026-09-12T12:00:00.000Z' }],
      [SEEDED_LESSONS[1].id, { progressPercent: 100, completedAt: '2026-09-14T12:00:00.000Z' }],
      [SEEDED_LESSONS[2].id, { progressPercent: 36, completedAt: null }]
    ])]
  ]);
  private projects = new Map<string, InternalProject[]>();
  private achievements = new Map<string, Set<string>>([[DEV_IDS.user, new Set(['first-spark', 'builder', 'ai-explorer'])]]);
  private xpKeys = new Set(['seed:xp']);
  private conversations = new Map<string, InternalConversation[]>();
  private homeworkSubmissions = new Map<string, HomeworkSubmissionDto[]>();
  private submissionHomeworkIds = new Map<string,string>();
  private portfolioProjects = new Map<string, PortfolioDto['projects']>();
  private mentorBookings = new Map<string, MentorBookingDto[]>();
  private classSessionOverrides = new Map<string, { startsAt: string; endsAt: string; status: 'rescheduled' }>();

  constructor(workspaceUrl?: string) {
    const tasks: ProjectTaskDto[] = [
      { id: '32000000-0000-4000-8000-000000000001', number: '01', title: 'Сформулювати проблему', description: 'Хто має проблему і що саме заважає?', status: 'completed', xpReward: 80, weight: 30 },
      { id: '32000000-0000-4000-8000-000000000002', number: '02', title: 'Описати користувача', description: 'Для кого ми створюємо рішення?', status: 'completed', xpReward: 100, weight: 32 },
      { id: '32000000-0000-4000-8000-000000000003', number: '03', title: 'Зібрати перший прототип', description: 'Покажи головний сценарій без зайвих функцій.', status: 'in_progress', xpReward: 160, weight: 18 },
      { id: '32000000-0000-4000-8000-000000000004', number: '04', title: 'Показати 3 людям', description: 'Збери чесний зворотний зв’язок.', status: 'locked', xpReward: 180, weight: 10 },
      { id: '32000000-0000-4000-8000-000000000005', number: '05', title: 'Підготувати пітч', description: 'Поясни проблему, рішення та доказ.', status: 'locked', xpReward: 200, weight: 10 }
    ];
    this.projects.set(DEV_IDS.user, [{
      id: DEV_IDS.project,
      title: 'Smart Study Planner',
      summary: 'AI-помічник для навчання без хаосу.',
      status: 'active',
      stagePosition: 3,
      stageCode: 'prototype',
      stageTitle: 'Прототип',
      tags: ['AI', 'WEB', 'EDUCATION'],
      workspaceUrl: workspaceUrl ?? null,
      tasks
    }]);

    const created = '2026-09-17T10:00:00.000Z';
    this.conversations.set(DEV_IDS.user, [{
      id: DEV_IDS.conversation,
      title: 'Smart Study Planner',
      courseId: DEV_IDS.course,
      lessonId: SEEDED_LESSONS[2].id,
      projectId: DEV_IDS.project,
      createdAt: created,
      updatedAt: created,
      summary: '',
      clientMessageIds: new Set(),
      messages: [{
        id: '41000000-0000-4000-8000-000000000001',
        role: 'assistant',
        content: 'Привіт, Максим! Бачу, ти збираєш Smart Study Planner. З чого почнемо?',
        createdAt: created
      }]
    }]);
    this.homeworkSubmissions.set(DEV_IDS.user, [
      { id: '74000000-0000-4000-8000-000000000001', attemptNumber: 1, submittedAt: relativeIso(-3, 18), studentComment: 'Перевірив джерела та додав пояснення.', contentText: 'Чекліст перевірки відповіді AI', contentUrl: null, status: 'completed', review: { score: 9, effort: 'high_effort', status: 'completed', feedback: 'Сильна перевірка джерел. Продовжуй пояснювати, чому джерело надійне.', reviewedAt: relativeIso(-2, 15) } },
      { id: '74000000-0000-4000-8000-000000000002', attemptNumber: 1, submittedAt: relativeIso(-1, 19), studentComment: 'Це перша версія плану.', contentText: 'План Smart Study Planner', contentUrl: 'https://example.com/smart-study-plan', status: 'needs_revision', review: { score: 6, effort: 'high_effort', status: 'needs_revision', feedback: 'Зусилля видно. Додай одну конкретну перевірку для головного припущення.', reviewedAt: relativeIso(0, 10) } }
    ]);
    this.submissionHomeworkIds.set('74000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001');
    this.submissionHomeworkIds.set('74000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000002');
    this.portfolioProjects.set(DEV_IDS.user, [{
      id: '82000000-0000-4000-8000-000000000001', projectId: DEV_IDS.project, title: 'Smart Study Planner', shortDescription: 'AI-помічник, що допомагає планувати навчання без хаосу.', reflection: 'Я навчився починати з проблеми, а не з функцій.', learned: 'Перевіряти припущення, будувати прототип і слухати користувача.', skills: ['AI', 'Product thinking', 'UX'], technologies: ['HTML', 'CSS', 'JavaScript'], demoUrl: null, coverPath: null, screenshots: [], completionDate: null
    }]);
    this.mentorBookings.set(DEV_IDS.user, []);
  }

  async ping(): Promise<void> {}

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const key = `telegram:${identity.telegramId}`;
    const existingId = this.identities.get(key);
    if (existingId) return this.requireUser(existingId);
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
    return structuredClone(user);
  }

  async getDevelopmentUser(userId: string): Promise<AuthUser | null> {
    return this.users.has(userId) ? structuredClone(this.requireUser(userId)) : null;
  }

  async getAuthUser(userId: string): Promise<AuthUser | null> {
    return this.users.has(userId) ? structuredClone(this.requireUser(userId)) : null;
  }

  async createSession(session: NewSession): Promise<void> {
    if ([...this.sessions.values()].some(item => item.refreshTokenHash === session.refreshTokenHash)) {
      throw new AppError('SESSION_CONFLICT', 409, 'Session token conflict');
    }
    this.sessions.set(session.id, { ...session, revokedAt: null, replacedBy: null });
  }

  async rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult> {
    const current = [...this.sessions.values()].find(item => item.refreshTokenHash === currentTokenHash);
    if (!current) return { status: 'invalid' };
    if (current.replacedBy) {
      for (const session of this.sessions.values()) if (session.familyId === current.familyId) session.revokedAt = now;
      return { status: 'reused' };
    }
    if (current.revokedAt) return { status: 'revoked' };
    if (current.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
    current.revokedAt = now;
    current.replacedBy = next.id;
    const rotated = { ...next, familyId: current.familyId, userId: current.userId, provider: current.provider };
    this.sessions.set(next.id, { ...rotated, revokedAt: null, replacedBy: null });
    return { status: 'ok', user: structuredClone(this.requireUser(current.userId)), session: rotated };
  }

  async revokeSession(refreshTokenHash: string, now: Date): Promise<boolean> {
    const current = [...this.sessions.values()].find(item => item.refreshTokenHash === refreshTokenHash);
    if (!current) return false;
    for (const session of this.sessions.values()) if (session.familyId === current.familyId) session.revokedAt = now;
    return true;
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
      const override=this.classSessionOverrides.get(id); const startsAt=override?.startsAt??relativeIso(days,17); const endsAt=override?.endsAt??relativeIso(days,18,30);
      return { id, title, description: 'Живе групове заняття з практикою та роботою над проєктом.', startsAt, endsAt, durationMinutes: Math.round((Date.parse(endsAt)-Date.parse(startsAt))/60000), status:override?.status??status,
        meetingProvider: 'Google Meet', meetingUrl: status === 'cancelled' ? null : 'https://meet.google.com/abc-defg-hij', courseTitle: 'Основи роботи з AI', moduleTitle: 'Основи роботи з AI', lessonTitle: title, teacherName: 'Анна Коваль', materials: [] };
    };
    const upcoming = [session('71000000-0000-4000-8000-000000000001', 'Як перевіряти відповіді AI', 1, 'scheduled'), session('71000000-0000-4000-8000-000000000002', 'Від проблеми до ідеї', 4, 'rescheduled')].sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    const past = [session('71000000-0000-4000-8000-000000000003', 'Як працювати з AI', -3, 'completed')];
    return { timezone: 'Europe/Kyiv', nextClass: upcoming[0] ?? null, today: upcoming.filter(item => new Date(item.startsAt).toDateString() === new Date().toDateString()), thisWeek: upcoming, upcoming, past };
  }

  async listHomework(userId: string): Promise<HomeworkSummaryDto[]> {
    this.requireRole(userId,'student');
    const submissions = this.homeworkSubmissions.get(userId) ?? [];
    const latestFor=(homeworkId:string)=>submissions.filter(item=>this.submissionHomeworkIds.get(item.id)===homeworkId).sort((a,b)=>b.attemptNumber-a.attemptNumber)[0]??null;
    const reviewed = latestFor('73000000-0000-4000-8000-000000000001');
    const revision = latestFor('73000000-0000-4000-8000-000000000002');
    return [
      { id: '73000000-0000-4000-8000-000000000001', title: 'Перевір відповідь AI', instructions: 'Обери відповідь AI, знайди два джерела та поясни висновок.', publishedAt: relativeIso(-5, 18), dueAt: relativeIso(-2, 20), xpReward: 80, classTitle: 'Як перевіряти відповіді AI', state: reviewed?.status ?? 'not_started', latestSubmission: reviewed },
      { id: '73000000-0000-4000-8000-000000000002', title: 'План твого проєкту', instructions: 'Опиши проблему, користувача, рішення та одну перевірку.', publishedAt: relativeIso(-2, 18), dueAt: relativeIso(2, 20), xpReward: 120, classTitle: 'Від проблеми до ідеї', state: revision?.status ?? 'not_started', latestSubmission: revision },
      { id: '73000000-0000-4000-8000-000000000003', title: 'Підготуй перший прототип', instructions: 'Збери один головний сценарій та додай посилання або скриншот.', publishedAt: relativeIso(0, 12), dueAt: relativeIso(6, 20), xpReward: 160, classTitle: 'Створюємо першу версію', state: 'not_started', latestSubmission: null }
    ];
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
        title: 'Основи роботи з AI',
        description: 'Думай разом з AI, став правильні питання й перевіряй результат.',
        progressPercent: Math.round(totalProgress / lessons.length),
        completedLessons: lessons.filter(lesson => lesson.state === 'completed').length,
        totalLessons: lessons.length
      },
      modules: [{
        id: DEV_IDS.module,
        number: '01',
        title: 'Основи роботи з AI',
        description: 'Від першого запиту до перевіреного MVP.',
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
      moduleTitle: 'Основи роботи з AI',
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
      stagePosition: 1, stageCode: 'idea', stageTitle: 'Ідея', tags: ['AI'], workspaceUrl: null,
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
      mentor: { displayName: 'Анна', title: 'Product mentor', avatarPath: null, nextMeetingAt: null }
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
      id: `portfolio:${userId}`,
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
      return { id: `91000000-0000-4000-8000-00000000000${index + 1}`, mentorId: '60000000-0000-4000-8000-000000000001', mentorName: 'Анна Коваль', mentorTitle: 'Product mentor', startsAt, endsAt: relativeIso(days, index ? 16 : 18, 30), timezone: 'Europe/Kyiv', available: !booked.has(startsAt) };
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
    return [{ id:'70000000-0000-4000-8000-000000000001',name:'Creators · Осінь 2026',courseTitle:'Основи роботи з AI',timezone:'Europe/Kyiv',studentCount:2,nextClassAt:relativeIso(1,17) }];
  }

  async listGroupStudents(userId: string, groupId: string): Promise<TeacherStudentDto[]> {
    this.requireRole(userId,'teacher');
    if(groupId!=='70000000-0000-4000-8000-000000000001') throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    return [{id:DEV_IDS.user,firstName:'Максим',progressPercent:20,projectTitle:'Smart Study Planner'},{id:'10000000-0000-4000-8000-000000000002',firstName:'Ірина',progressPercent:10,projectTitle:null}];
  }

  async createClassSession(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;title:string;description?:string;startsAt:string;endsAt:string;meetingUrl?:string;meetingProvider?:string}):Promise<ClassSessionDto>{
    this.requireRole(userId,'teacher'); if(input.groupId!=='70000000-0000-4000-8000-000000000001')throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    return{id:randomUUID(),title:input.title,description:input.description??'',startsAt:input.startsAt,endsAt:input.endsAt,durationMinutes:Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000),status:'scheduled',meetingProvider:input.meetingProvider??null,meetingUrl:input.meetingUrl??null,courseTitle:'Основи роботи з AI',moduleTitle:'Основи роботи з AI',lessonTitle:null,teacherName:'Анна Коваль',materials:[]};
  }
  async rescheduleClass(userId:string,sessionId:string,input:{startsAt:string;endsAt:string;reason?:string}):Promise<void>{this.requireRole(userId,'teacher');if(!['71000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002'].includes(sessionId))throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');this.classSessionOverrides.set(sessionId,{startsAt:input.startsAt,endsAt:input.endsAt,status:'rescheduled'});}
  async confirmAttendance(userId:string,sessionId:string,studentId:string,status:'present'|'late'|'absent'|'excused',note?:string):Promise<void>{this.requireRole(userId,'teacher');if(!sessionId.startsWith('71000000-')||![DEV_IDS.user,'10000000-0000-4000-8000-000000000002'].includes(studentId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');void status;void note;}
  async createHomework(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;classSessionId?:string;title:string;instructions:string;publishAt?:string;dueAt?:string;xpReward:number;status:'draft'|'published'}):Promise<HomeworkSummaryDto>{this.requireRole(userId,'teacher');if(input.groupId!=='70000000-0000-4000-8000-000000000001')throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');return{id:randomUUID(),title:input.title,instructions:input.instructions,publishedAt:input.publishAt??nowIso(),dueAt:input.dueAt??null,xpReward:input.xpReward,classTitle:null,state:'not_started',latestSubmission:null};}
  async reviewHomework(userId:string,submissionId:string,input:{score:number;effort:EffortLevel;status:'reviewed'|'needs_revision'|'completed';feedback:string}):Promise<void>{this.requireRole(userId,'teacher');if(input.score<0||input.score>10||!Number.isInteger(input.score))throw new AppError('INVALID_SCORE',400,'Оцінка має бути цілим числом від 0 до 10');const submission=[...this.homeworkSubmissions.values()].flat().find(item=>item.id===submissionId);if(!submission)throw new AppError('SUBMISSION_FORBIDDEN',403,'Робота недоступна');submission.status=input.status==='needs_revision'?'needs_revision':input.status==='completed'?'completed':submission.status;submission.review={score:input.score,effort:input.effort,status:input.status,feedback:input.feedback,reviewedAt:nowIso()};}
  async listLinkedStudents(userId:string):Promise<TeacherStudentDto[]>{this.requireRole(userId,'guardian');return[{id:DEV_IDS.user,firstName:'Максим',progressPercent:20,projectTitle:'Smart Study Planner'}];}
  async listParentReports(userId:string,studentId:string):Promise<ParentReportDto[]>{this.requireRole(userId,'guardian');if(studentId!==DEV_IDS.user)throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');return[{id:'93000000-0000-4000-8000-000000000001',studentId,studentFirstName:'Максим',periodStart:new Date(Date.now()-7*86400000).toISOString().slice(0,10),periodEnd:new Date(Date.now()-86400000).toISOString().slice(0,10),payload:{classesScheduled:2,classesAttended:2,homeworkSubmitted:2,project:'Smart Study Planner',projectProgress:62,effort:{high:2}},teacherComment:'Максим уважно працював із джерелами й наполегливо допрацьовує план проєкту.',status:'approved'}];}

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
      firstName: this.requireUser(userId).displayName,
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

  private requireUser(userId: string): AuthUser {
    const user = this.users.get(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 404, 'Користувача не знайдено');
    return user;
  }

  private requireRole(userId:string,role:'student'|'guardian'|'teacher'|'admin'):void{this.requireUser(userId);if(this.roles.get(userId)!==role&&this.roles.get(userId)!=='admin')throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав');}

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
      firstName: user.displayName,
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
