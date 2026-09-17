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
  HomeDto,
  LearningDto,
  LessonDto,
  LessonSummaryDto,
  NewSession,
  ProfileDto,
  ProjectDto,
  ProjectTaskDto,
  RotationResult,
  TelegramIdentityInput
} from '../types/domain.js';

type LessonState = { progressPercent: number; completedAt: string | null };
type InternalProject = Omit<ProjectDto, 'completionPercent' | 'stage'> & { stagePosition: number; stageCode: string; stageTitle: string };
type InternalConversation = AiConversationDto & { summary: string; messages: AiMessageDto[]; clientMessageIds: Set<string> };

const LEVELS = [
  { number: 1, title: 'Explorer', minXp: 0 },
  { number: 2, title: 'Maker', minXp: 200 },
  { number: 3, title: 'Builder', minXp: 400 },
  { number: 4, title: 'Creator', minXp: 600 },
  { number: 5, title: 'Launcher', minXp: 900 }
];

const STAGES = [
  { id: '31000000-0000-4000-8000-000000000001', code: 'problem', title: 'Проблема', position: 1 },
  { id: '31000000-0000-4000-8000-000000000002', code: 'concept', title: 'Концепт', position: 2 },
  { id: DEV_IDS.stage, code: 'prototype', title: 'Прототип', position: 3 },
  { id: '31000000-0000-4000-8000-000000000004', code: 'test', title: 'Тест', position: 4 },
  { id: '31000000-0000-4000-8000-000000000005', code: 'pitch', title: 'Пітч', position: 5 }
];

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryRepository implements AppRepository {
  private users = new Map<string, AuthUser>([[DEV_IDS.user, { id: DEV_IDS.user, displayName: 'Максим', status: 'active' }]]);
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
  }

  async ping(): Promise<void> {}

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const key = `telegram:${identity.telegramId}`;
    const existingId = this.identities.get(key);
    if (existingId) return this.requireUser(existingId);
    const user: AuthUser = { id: randomUUID(), displayName: identity.firstName.slice(0, 60) || 'Учень', status: 'active' };
    this.users.set(user.id, user);
    this.identities.set(key, user.id);
    this.xp.set(user.id, 0);
    this.streak.set(user.id, 0);
    this.lessonState.set(user.id, new Map([[SEEDED_LESSONS[0].id, { progressPercent: 0, completedAt: null }]]));
    this.projects.set(user.id, []);
    this.achievements.set(user.id, new Set());
    this.conversations.set(user.id, []);
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
    return {
      viewer: this.viewer(userId),
      course: learning.course,
      currentLesson,
      projectCount: projects.length,
      currentProject: projects.find(project => project.status === 'active') ?? null
    };
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
        title: 'AI Foundations',
        description: 'Думай разом з AI, став правильні питання й перевіряй результат.',
        progressPercent: Math.round(totalProgress / lessons.length),
        completedLessons: lessons.filter(lesson => lesson.state === 'completed').length,
        totalLessons: lessons.length
      },
      modules: [{
        id: DEV_IDS.module,
        number: '01',
        title: 'AI Foundations',
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
      moduleTitle: 'AI Foundations',
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
      stagePosition: 1, stageCode: 'problem', stageTitle: 'Проблема', tags: ['AI'], workspaceUrl: null,
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
