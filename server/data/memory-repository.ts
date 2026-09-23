import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { MemorySessionStore, type SessionStore } from '../auth/session-store.js';
import type { AppRepository } from './repository.js';
import { MemoryMentoringStore, type MentoringStore, type StoredMentorBooking } from './mentoring-store.js';
import { DEV_IDS, PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_LESSONS } from './seed.js';
import { MemoryPilotRuntimeStore, PILOT_PORTFOLIO_IDS, type PilotDirectoryPerson, type PilotDirectoryRole, type PilotProject, type PilotRuntimeState, type PilotRuntimeStore } from './pilot-runtime-store.js';
import { hashPassword, normalizeEmail, verifyPassword } from '../auth/password-credentials.js';
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
  ParentSummaryDto,
  ParentContactCategory,
  ParentContactRequestDto,
  NotificationDeliveryDto,
  MissedLessonRecoveryDto,
  TeacherGroupDto,
  TeacherStudentDto,
  TeacherWorkspaceDto,
  TeacherSearchDto,
  TeacherPrivateNoteDto,
  RotationResult,
  TelegramIdentityInput
} from '../types/domain.js';

type InternalProject = PilotProject;
type InternalConversation = AiConversationDto & { summary: string; messages: AiMessageDto[]; clientMessageIds: Set<string> };
type NotificationCandidate={recipientUserId:string;type:string;relatedEntityId:string|null;scheduledFor:string;idempotencyKey:string;safeMetadata:{text:string;buttonText?:string;buttonUrl?:string;callbackData?:string;studentId?:string;weekKey?:string}};

export interface MemoryRepositoryOptions {
  telegramBindingsJson?: string | undefined;
  webAuthAccountsJson?: string | undefined;
  requireSeededTelegramIdentity?: boolean;
  sessionStore?: SessionStore;
  mentoringStore?: MentoringStore;
  runtimeStore?: PilotRuntimeStore;
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
  private roleSets = new Map<string, PilotDirectoryRole[]>([
    ...PILOT_STUDENTS.map(student => [student.id, ['student'] as PilotDirectoryRole[]] as const),
    ...PILOT_TEACHERS.map(teacher => [teacher.id, teacher.key === 'maksym' ? ['teacher','mentor','admin'] as PilotDirectoryRole[] : ['teacher'] as PilotDirectoryRole[]] as const),
    ['13000000-0000-4000-8000-000000000001',['guardian']],
    ['14000000-0000-4000-8000-000000000001',['admin']]
  ]);
  private studentDisplayNames = new Map<string, string>(PILOT_STUDENTS.map(student => [student.id, student.displayName]));
  private identities = new Map<string, string>();
  private readonly sessionStore: SessionStore;
  private readonly mentoringStore: MentoringStore;
  private readonly runtimeStore: PilotRuntimeStore;
  private conversations = new Map<string, InternalConversation[]>();
  private readonly requireSeededTelegramIdentity: boolean;
  private readonly legacyWebEmails=new Set<string>();

  constructor(private readonly workspaceUrl?: string, options: MemoryRepositoryOptions = {}) {
    this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    this.mentoringStore = options.mentoringStore ?? new MemoryMentoringStore();
    this.runtimeStore = options.runtimeStore ?? new MemoryPilotRuntimeStore();
    this.requireSeededTelegramIdentity = options.requireSeededTelegramIdentity ?? false;
    for (const student of PILOT_STUDENTS) {
      this.conversations.set(student.id, []);
    }
    this.loadTelegramBindings(options.telegramBindingsJson);
    this.loadWebAccounts(options.webAuthAccountsJson);
  }

  async ping(): Promise<void> {}

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const key = `telegram:${identity.telegramId}`;
    const state=await this.runtimeStore.read();this.syncDirectory(state);
    const existingId = state.telegramBindings[identity.telegramId] ?? this.identities.get(key);
    if (existingId) {
      const existing=await this.getAuthUser(existingId);
      if(existing){
        if(!state.telegramBindings[identity.telegramId])await this.runtimeStore.mutate(next=>{if(!next.telegramBindings[identity.telegramId]&&!Object.values(next.telegramBindings).includes(existingId)){next.telegramBindings[identity.telegramId]=existingId;const person=next.directory[existingId];if(person){person.telegramId=identity.telegramId;person.updatedAt=nowIso();person.version+=1;}}});
        return existing;
      }
    }
    if (this.requireSeededTelegramIdentity) {
      throw new AppError('TELEGRAM_ACCOUNT_NOT_LINKED', 403, 'Telegram-акаунт ще не прив’язано до профілю учня');
    }
    const user: AuthUser = { id: randomUUID(), displayName: identity.firstName.slice(0, 60) || 'Учень', status: 'active' };
    this.users.set(user.id, user);
    this.roles.set(user.id, 'student');
    this.roleSets.set(user.id,['student']);
    this.identities.set(key, user.id);
    this.conversations.set(user.id, []);
    this.studentDisplayNames.set(user.id, user.displayName);
    await this.runtimeStore.mutate(state => {
      const names={firstName:(identity.firstName||'Учень').slice(0,60),lastName:(identity.lastName||'').slice(0,60)};
      state.directory[user.id]={id:user.id,...names,displayName:[names.firstName,names.lastName].filter(Boolean).join(' '),roles:['student'],status:'active',groupId:PILOT.groupId,email:null,phone:null,telegramId:identity.telegramId,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:nowIso(),updatedAt:nowIso(),version:1};
      state.telegramBindings[identity.telegramId]=user.id;
      state.userStatus[user.id] = 'active';
      state.xp[user.id] = 0;
      state.streak[user.id] = 0;
      state.lessonProgress[user.id] = { [SEEDED_LESSONS[0]!.id]: { progressPercent: 0, completedAt: null } };
      state.projects[user.id] = [];
      state.achievements[user.id] = [];
      state.portfolioProjects[user.id] = [];
    });
    return structuredClone(user);
  }

  async getDevelopmentUser(userId: string): Promise<AuthUser | null> {
    return this.getAuthUser(userId);
  }

  async getAuthUser(userId: string): Promise<AuthUser | null> {
    const state = await this.runtimeStore.read();
    this.syncDirectory(state);
    const person=state.directory[userId];
    if(!person)return null;
    return {id:person.id,displayName:person.displayName,status:state.userStatus[userId]??person.status};
  }

  async getWebAuthUser(userId: string): Promise<{ user: AuthUser; role: AccessContext['role']; roles: AccessContext['roles'] } | null> {
    const user = await this.getAuthUser(userId);
    const role = this.roles.get(userId);
    const roles=this.roleSets.get(userId)??[];
    return user && role ? { user, role, roles } : null;
  }

  async authenticatePersistentWebUser(email:string,password:string):Promise<AuthUser|null>{
    const normalized=normalizeEmail(email),state=await this.runtimeStore.read();this.syncDirectory(state);
    const person=Object.values(state.directory).find(item=>item.email===normalized&&Boolean(item.passwordHash));
    if(!person?.passwordHash){const fallback=Object.values(state.directory).find(item=>Boolean(item.passwordHash))?.passwordHash;if(fallback)await verifyPassword(password,fallback);return null;}
    return await verifyPassword(password,person.passwordHash)?this.getAuthUser(person.id):null;
  }

  async activatePersistentWebUser(token:string,password:string):Promise<AuthUser>{
    const tokenHash=createHash('sha256').update(token).digest('hex'),passwordHash=await hashPassword(password),timestamp=nowIso();let activatedId='';
    await this.runtimeStore.mutate(state=>{const person=Object.values(state.directory).find(item=>item.activationTokenHash===tokenHash);if(!person||!person.activationExpiresAt||Date.parse(person.activationExpiresAt)<=Date.now())throw new AppError('ACTIVATION_TOKEN_INVALID',400,'Посилання активації недійсне або прострочене');person.passwordHash=passwordHash;person.activationTokenHash=null;person.activationExpiresAt=null;person.status='active';person.updatedAt=timestamp;person.version+=1;state.userStatus[person.id]='active';this.addAudit(state,person.id,'account.activated','user',person.id,{},randomUUID());activatedId=person.id;});
    const user=await this.getAuthUser(activatedId);if(!user)throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');return user;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.sessionStore.create(session);
  }

  async rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult> {
    const result = await this.sessionStore.rotate(currentTokenHash, next, now);
    if (result.status !== 'ok') return result;
    const user = await this.getAuthUser(result.session.userId);
    if (!user) return { status: 'invalid' };
    return { status: 'ok', user, session: result.session };
  }

  async revokeSession(refreshTokenHash: string, now: Date): Promise<boolean> {
    return this.sessionStore.revokeFamily(refreshTokenHash, now);
  }

  async getAccessContext(userId:string,sessionId:string):Promise<AccessContext>{
    const user=await this.getAuthUser(userId);
    return{role:this.roles.get(userId)??'student',roles:this.roleSets.get(userId)??['student'],status:user?.status??'disabled',sessionActive:await this.sessionStore.isActive(userId,sessionId,new Date())};
  }

  async getHome(userId: string): Promise<HomeDto> {
    const learning = await this.getLearning(userId);
    const projects = await this.listProjects(userId);
    const currentLesson = learning.modules.flatMap(module => module.lessons).find(lesson => lesson.state === 'current' || lesson.state === 'available') ?? null;
    const schedule = await this.getSchedule(userId);
    const homework = await this.listHomework(userId);
    return {
      viewer: await this.viewer(userId),
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
    const state = await this.runtimeStore.read();
    const sessions = state.classSessions.map(item => this.classSessionDto(item));
    const now = Date.now();
    const upcoming = sessions.filter(item => Date.parse(item.endsAt) >= now && item.status !== 'cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    const past = sessions.filter(item => Date.parse(item.endsAt) < now || item.status === 'completed').sort((a,b)=>Date.parse(b.startsAt)-Date.parse(a.startsAt));
    const todayKey = new Date().toISOString().slice(0,10);
    const weekEnd = now + 7 * 86_400_000;
    return { timezone: PILOT.timezone, nextClass: upcoming[0] ?? null, today: upcoming.filter(item => item.startsAt.slice(0,10) === todayKey), thisWeek: upcoming.filter(item => Date.parse(item.startsAt) <= weekEnd), upcoming, past };
  }

  async listHomework(userId: string): Promise<HomeworkSummaryDto[]> {
    this.requireRole(userId,'student');
    const state = await this.runtimeStore.read();
    const submissions = state.submissions.filter(item => item.studentId === userId);
    return state.homework.filter(item => item.status === 'published').map(homework => {
      const latest = submissions.filter(item => item.homeworkId === homework.id).sort((a,b)=>b.attemptNumber-a.attemptNumber)[0] ?? null;
      const session = state.classSessions.find(item => item.id === homework.classSessionId);
      return { id:homework.id,title:homework.title,instructions:homework.instructions,publishedAt:homework.publishAt??'',dueAt:homework.dueAt,xpReward:homework.xpReward,classTitle:session?.title??null,state:latest?.status??'not_started',latestSubmission:latest ? this.submissionDto(latest) : null };
    });
  }

  async submitHomework(userId: string, homeworkId: string, input: { contentText: string; contentUrl?: string; studentComment?: string }): Promise<HomeworkSubmissionDto> {
    this.requireRole(userId,'student');
    const id=randomUUID(), submittedAt=nowIso();
    const created = await this.runtimeStore.mutate(state => {
      if (!state.homework.some(item => item.id === homeworkId && item.status === 'published')) throw new AppError('HOMEWORK_NOT_FOUND', 404, 'Домашнє завдання не знайдено');
      const attemptNumber = state.submissions.filter(item => item.studentId===userId && item.homeworkId===homeworkId).length + 1;
      const submission = { id, studentId:userId, homeworkId, attemptNumber, submittedAt, studentComment:input.studentComment??'', contentText:input.contentText, contentUrl:input.contentUrl??null, status:'submitted' as const, review:null };
      state.submissions.push(submission);
      return submission;
    });
    return this.submissionDto(created);
  }

  async getLearning(userId: string): Promise<LearningDto> {
    this.requireUser(userId);
    const runtime = await this.runtimeStore.read();
    const state = runtime.lessonProgress[userId] ?? {};
    const firstIncompleteIndex = SEEDED_LESSONS.findIndex(lesson => (state[lesson.id]?.progressPercent ?? 0) < 100);
    const lessons: LessonSummaryDto[] = SEEDED_LESSONS.map((lesson, index) => {
      const progress = state[lesson.id]?.progressPercent ?? 0;
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
    const rewardKey = `lesson:${userId}:${lessonId}:${idempotencyKey}`;
    const completedAt=nowIso();
    const awardedXp = await this.runtimeStore.mutate(state => {
      const progress=state.lessonProgress[userId]??(state.lessonProgress[userId]={});
      if(state.idempotencyKeys.includes(rewardKey)||progress[lessonId]?.progressPercent===100)return 0;
      progress[lessonId]={progressPercent:100,completedAt}; state.idempotencyKeys.push(rewardKey);
      state.xp[userId]=(state.xp[userId]??0)+lesson.xpReward; state.streak[userId]=Math.max(1,state.streak[userId]??0);
      const achievements=state.achievements[userId]??(state.achievements[userId]=[]); if(!achievements.includes('first-spark'))achievements.push('first-spark');
      return lesson.xpReward;
    });
    return { awardedXp, home: await this.getHome(userId) };
  }

  async listProjects(userId: string): Promise<ProjectDto[]> {
    this.requireUser(userId);
    const state=await this.runtimeStore.read();
    return (state.projects[userId] ?? []).map(project => this.projectDto(project));
  }

  async createProject(userId: string, input: { title: string; summary: string }): Promise<ProjectDto> {
    this.requireUser(userId);
    const project: InternalProject = {
      id: randomUUID(), title: input.title, summary: input.summary, status: 'active',
      stagePosition: 1, stageCode: 'idea', stageTitle: 'Ідея', tags: ['AI'], workspaceUrl: this.workspaceUrl ?? null,updatedAt:nowIso(),
      tasks: [
        { id: randomUUID(), number: '01', title: 'Сформулювати проблему', description: 'Опиши проблему конкретної людини.', status: 'in_progress', xpReward: 80, weight: 35 },
        { id: randomUUID(), number: '02', title: 'Описати користувача', description: 'Хто потребує рішення?', status: 'locked', xpReward: 100, weight: 25 },
        { id: randomUUID(), number: '03', title: 'Зібрати прототип', description: 'Перевір головний сценарій.', status: 'locked', xpReward: 160, weight: 25 },
        { id: randomUUID(), number: '04', title: 'Провести тест', description: 'Покажи рішення трьом людям.', status: 'locked', xpReward: 180, weight: 15 }
      ]
    };
    await this.runtimeStore.mutate(state => { (state.projects[userId]??(state.projects[userId]=[])).push(project); });
    return this.projectDto(project);
  }

  async updateProject(userId: string, projectId: string, input: { title?: string; summary?: string }): Promise<ProjectDto | null> {
    this.requireUser(userId);
    const project=await this.runtimeStore.mutate(state=>{const item=state.projects[userId]?.find(project=>project.id===projectId);if(!item)return null;if(input.title!==undefined)item.title=input.title;if(input.summary!==undefined)item.summary=input.summary;item.updatedAt=nowIso();return item;});
    return project?this.projectDto(project):null;
  }

  async completeProjectTask(userId: string, projectId: string, taskId: string, idempotencyKey: string): Promise<{ awardedXp: number; project: ProjectDto } | null> {
    this.requireUser(userId);const rewardKey=`project-task:${userId}:${taskId}:${idempotencyKey}`;
    const result=await this.runtimeStore.mutate(state=>{const project=state.projects[userId]?.find(item=>item.id===projectId);if(!project)return null;const taskIndex=project.tasks.findIndex(item=>item.id===taskId),task=project.tasks[taskIndex];if(!task)return null;if(task.status==='locked')throw new AppError('TASK_LOCKED',403,'Це завдання ще не відкрито');let awardedXp=0;if(task.status!=='completed'&&!state.idempotencyKeys.includes(rewardKey)){task.status='completed';project.updatedAt=nowIso();state.idempotencyKeys.push(rewardKey);state.xp[userId]=(state.xp[userId]??0)+task.xpReward;state.streak[userId]=Math.max(1,state.streak[userId]??0);awardedXp=task.xpReward;const next=project.tasks[taskIndex+1];if(next)next.status='in_progress';else project.status='completed';const completed=project.tasks.filter(item=>item.status==='completed').length;project.stagePosition=Math.min(STAGES.length,Math.max(1,completed+1));const stage=STAGES[project.stagePosition-1];if(stage){project.stageCode=stage.code;project.stageTitle=stage.title;}if(completed>=2){const achievements=state.achievements[userId]??(state.achievements[userId]=[]);if(!achievements.includes('builder'))achievements.push('builder');}}return{awardedXp,project};});
    return result?{awardedXp:result.awardedXp,project:this.projectDto(result.project)}:null;
  }

  async getProfile(userId: string): Promise<ProfileDto> {
    const viewer = await this.viewer(userId);
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
      mentor: { displayName: PILOT_TEACHERS[0].fullName, title: 'Ментор', avatarPath: null, nextMeetingAt: await this.nextMentorMeeting(userId) }
    };
  }

  async listAchievements(userId: string): Promise<AchievementDto[]> {
    this.requireUser(userId);
    const state=await this.runtimeStore.read(); const earned = new Set(state.achievements[userId]??[]);
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
    const state=await this.runtimeStore.read(); const portfolioId=PILOT_PORTFOLIO_IDS[userId]??`portfolio:${userId}`;
    return {
      id: portfolioId,
      title: 'Моє портфоліо',
      visibility: state.portfolioVisibility[portfolioId]==='private'?'private':'shared',
      projects: structuredClone(state.portfolioProjects[userId] ?? []),
      skills: [
        { code: 'ai', title: 'AI', level: 3 },
        { code: 'critical-thinking', title: 'Критичне мислення', level: 2 },
        { code: 'product-thinking', title: 'Продуктове мислення', level: 2 },
        { code: 'presentation', title: 'Презентація', level: 1 }
      ]
    };
  }

  async addProjectToPortfolio(userId: string, projectId: string, input: { reflection?: string; learned?: string }): Promise<PortfolioDto> {
    this.requireRole(userId,'student'); const itemId=randomUUID();
    await this.runtimeStore.mutate(state=>{const project=state.projects[userId]?.find(item=>item.id===projectId);if(!project)throw new AppError('PROJECT_NOT_FOUND',404,'Проєкт не знайдено');const projects=state.portfolioProjects[userId]??(state.portfolioProjects[userId]=[]);if(!projects.some(item=>item.projectId===projectId))projects.push({id:itemId,projectId,title:project.title,shortDescription:project.summary,reflection:input.reflection??'',learned:input.learned??'',skills:['AI','Product thinking'],technologies:project.tags,demoUrl:project.workspaceUrl,coverPath:null,screenshots:[],completionDate:project.status==='completed'?new Date().toISOString().slice(0,10):null});});
    return this.getPortfolio(userId);
  }

  async listMentorSlots(userId: string): Promise<MentorSlotDto[]> {
    this.requireRole(userId,'student');
    const [availability, bookings] = await Promise.all([
      this.mentoringStore.listAvailability(PILOT.mentorId),
      this.mentoringStore.listBookings(PILOT.mentorId)
    ]);
    const activeBookings = bookings.filter(item => ['reserved', 'confirmed', 'rescheduled'].includes(item.status));
    const now = Date.now();
    return availability
      .filter(item => item.status === 'open' && Date.parse(item.startsAt) > now)
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
      .map(item => ({
        id: item.id,
        mentorId: item.mentorId,
        mentorName: PILOT_TEACHERS[0].fullName,
        mentorTitle: 'Ментор',
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        timezone: item.timezone,
        available: !activeBookings.some(booking => booking.availabilityId === item.id || (Date.parse(booking.startsAt) < Date.parse(item.endsAt) && Date.parse(booking.endsAt) > Date.parse(item.startsAt)))
      }));
  }

  async bookMentorSlot(userId: string, availabilityId: string): Promise<MentorBookingDto> {
    const slot = (await this.listMentorSlots(userId)).find(item => item.id === availabilityId);
    if (!slot || !slot.available) throw new AppError('MENTOR_SLOT_UNAVAILABLE', 409, 'Цей час уже недоступний');
    const project = (await this.listProjects(userId)).find(item => item.status === 'active') ?? null;
    const booking: StoredMentorBooking = {
      id: randomUUID(), availabilityId, mentorId: slot.mentorId, mentorName: slot.mentorName,
      studentId: userId, studentName: this.requireUser(userId).displayName, projectTitle: project?.title ?? null,
      startsAt: slot.startsAt, endsAt: slot.endsAt, status: 'reserved', meetingUrl: null
    };
    const created = await this.mentoringStore.bookAvailability(availabilityId, booking, new Date());
    if (!created) throw new AppError('MENTOR_SLOT_UNAVAILABLE', 409, 'Цей час уже недоступний');
    const { availabilityId: _availabilityId, studentId: _studentId, studentName: _studentName, projectTitle: _projectTitle, ...studentBooking } = created;
    return studentBooking;
  }

  async listTeacherGroups(userId: string): Promise<TeacherGroupDto[]> {
    const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId, 'teacher');const next=state.classSessions.filter(item=>Date.parse(item.endsAt)>=Date.now()&&item.status!=='cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0];
    return [{ id:PILOT.groupId,name:PILOT.groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:this.activeStudents(state).length,nextClassAt:next?.startsAt??null }];
  }

  async listGroupStudents(userId: string, groupId: string): Promise<TeacherStudentDto[]> {
    const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId,'teacher');
    if(groupId!==PILOT.groupId) throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    return this.activeStudents(state).map(student=>({id:student.id,firstName:student.displayName,progressPercent:this.progressPercent(state,student.id),projectTitle:state.projects[student.id]?.find(item=>item.status==='active')?.title??null}));
  }

  async createClassSession(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;title:string;description?:string;startsAt:string;endsAt:string;meetingUrl?:string;meetingProvider?:string}):Promise<ClassSessionDto>{
    this.requireRole(userId,'teacher'); if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');const id=randomUUID();
    const created={id,groupId:input.groupId,groupName:PILOT.groupName,lessonId:input.lessonId??null,title:input.title,description:input.description??'',startsAt:input.startsAt,endsAt:input.endsAt,durationMinutes:Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000),status:'scheduled' as const,meetingProvider:input.meetingProvider??null,meetingUrl:input.meetingUrl??null,courseTitle:PILOT.courseTitle,moduleTitle:PILOT.moduleTitle,lessonTitle:input.lessonId?SEEDED_LESSONS.find(item=>item.id===input.lessonId)?.title??null:null,teacherName:this.requireUser(userId).displayName,teacherNotes:'',materials:[]};
    await this.runtimeStore.mutate(state=>{state.classSessions.push(created);});return this.classSessionDto(created);
  }
  async rescheduleClass(userId:string,sessionId:string,input:{startsAt:string;endsAt:string;reason?:string}):Promise<void>{this.requireRole(userId,'teacher');if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');item.startsAt=input.startsAt;item.endsAt=input.endsAt;item.durationMinutes=Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000);item.status='rescheduled';item.changedAt=nowIso();});}
  async confirmAttendance(userId:string,sessionId:string,studentId:string,status:'present'|'late'|'absent'|'excused',note?:string):Promise<void>{const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);this.requireRole(userId,'teacher');if(!this.activeStudents(snapshot).some(student=>student.id===studentId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const id=randomUUID(),confirmedAt=nowIso();await this.runtimeStore.mutate(state=>{if(!state.classSessions.some(item=>item.id===sessionId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const record=state.attendance.find(item=>item.sessionId===sessionId&&item.studentId===studentId);if(record){record.status=status;record.note=note??'';record.confirmedAt=confirmedAt;}else state.attendance.push({id,sessionId,studentId,status,note:note??'',confirmedAt});});}
  async createHomework(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;classSessionId?:string;title:string;instructions:string;publishAt?:string;dueAt?:string;xpReward:number;status:'draft'|'published';resources?:Array<{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}>}):Promise<HomeworkSummaryDto>{this.requireRole(userId,'teacher');if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');if(input.resources?.some(resource=>!resource.url.startsWith('https://')))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const id=randomUUID(),resources=(input.resources??[]).map(resource=>({id:randomUUID(),...resource}));await this.runtimeStore.mutate(state=>{state.homework.unshift({id,groupId:input.groupId,groupName:PILOT.groupName,classSessionId:input.classSessionId??null,title:input.title,instructions:input.instructions,publishAt:input.publishAt??null,dueAt:input.dueAt??null,xpReward:input.xpReward,status:input.status,submissionCount:0,reviewCount:0,needsRevisionCount:0,resources});});return{id,title:input.title,instructions:input.instructions,publishedAt:input.publishAt??'',dueAt:input.dueAt??null,xpReward:input.xpReward,classTitle:null,state:'not_started',latestSubmission:null};}
  async reviewHomework(userId:string,submissionId:string,input:{score:number;effort:EffortLevel;status:'reviewed'|'needs_revision'|'completed';feedback:string}):Promise<void>{this.requireRole(userId,'teacher');if(input.score<0||input.score>10||!Number.isInteger(input.score))throw new AppError('INVALID_SCORE',400,'Оцінка має бути цілим числом від 0 до 10');const reviewedAt=nowIso();await this.runtimeStore.mutate(state=>{const submission=state.submissions.find(item=>item.id===submissionId);if(!submission)throw new AppError('SUBMISSION_FORBIDDEN',403,'Робота недоступна');submission.status=input.status==='needs_revision'?'needs_revision':input.status==='completed'?'completed':submission.status;submission.review={score:input.score,effort:input.effort,status:input.status,feedback:input.feedback,reviewedAt};});}

  async getTeacherWorkspace(userId:string):Promise<TeacherWorkspaceDto>{
    const state=await this.runtimeStore.read();
    this.syncDirectory(state);this.requireRole(userId,'teacher');
    const [mentorAvailability, mentorBookings] = await Promise.all([
      this.mentoringStore.listAvailability(PILOT.mentorId),
      this.mentoringStore.listBookings(PILOT.mentorId)
    ]);
    const activeMentorBookings = mentorBookings.filter(item => ['reserved', 'confirmed', 'rescheduled'].includes(item.status));
    const groupId=PILOT.groupId; const groupName=PILOT.groupName;
    const groupStudents=this.activeStudents(state).map(student=>({id:student.id,firstName:student.displayName,progressPercent:this.progressPercent(state,student.id),projectTitle:state.projects[student.id]?.find(item=>item.status==='active')?.title??null}));
    const allSessions=state.classSessions.map(item=>({...this.classSessionDto(item),groupId:item.groupId,groupName:item.groupName,lessonId:item.lessonId,teacherNotes:item.teacherNotes,homeworkIds:state.homework.filter(homework=>homework.classSessionId===item.id).map(homework=>homework.id),attendance:groupStudents.map(student=>{const record=state.attendance.find(value=>value.sessionId===item.id&&value.studentId===student.id);return{studentId:student.id,studentName:student.firstName,status:record?.status??null,suggestedStatus:null,note:record?.note??'',confirmedAt:record?.confirmedAt??null};})})).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    const submissions=[] as TeacherWorkspaceDto['submissions'];
    for(const attempt of state.submissions){const homework=state.homework.find(item=>item.id===attempt.homeworkId),student=this.users.get(attempt.studentId);if(!homework||!student)continue;submissions.push({id:attempt.id,homeworkId:homework.id,homeworkTitle:homework.title,groupId,groupName,studentId:attempt.studentId,studentName:student.displayName,attemptNumber:attempt.attemptNumber,submittedAt:attempt.submittedAt,studentComment:attempt.studentComment,contentText:attempt.contentText,contentUrl:attempt.contentUrl,status:attempt.status,review:structuredClone(attempt.review),attachments:[],previousAttempts:state.submissions.filter(item=>item.studentId===attempt.studentId&&item.homeworkId===attempt.homeworkId&&item.attemptNumber<attempt.attemptNumber).map(item=>this.submissionDto(item))});}
    submissions.sort((a,b)=>Date.parse(b.submittedAt??'')-Date.parse(a.submittedAt??''));
    const students=[] as TeacherWorkspaceDto['students'];
    for(const student of groupStudents){
      const learning=await this.getLearning(student.id); const projects=(state.projects[student.id]??[]).map(item=>this.projectDto(item)); const portfolio=this.portfolioFromState(state,student.id); const attempts=state.submissions.filter(item=>item.studentId===student.id);const scores=attempts.flatMap(item=>item.review?[item.review.score]:[]);const effort=attempts.map(item=>item.review?.effort).find(Boolean)??null;
      const attendance=state.attendance.filter(item=>item.studentId===student.id).map(item=>item.status); const reasons:string[]=[];
      if(attendance.filter(value=>value==='absent').length>=2)reasons.push('2 або більше пропущених занять');
      if(attempts.filter(item=>item.status==='needs_revision').length)reasons.push('Є робота на доопрацюванні');
      if(!projects.length)reasons.push('Ще немає активного проєкту');
      const studentMentorBookings = mentorBookings.filter(item => item.studentId === student.id).map(({availabilityId:_availabilityId,studentId:_studentId,studentName:_studentName,projectTitle:_projectTitle,...booking}) => booking);
      const xp=state.xp[student.id]??0;students.push({...student,groupId,groupName,courseTitle:learning.course.title,moduleTitle:learning.modules[0]?.title??'',xp,level:LEVELS.filter(level=>xp>=level.minXp).at(-1)?.title??LEVELS[0]!.title,attendance:{present:attendance.filter(value=>value==='present').length,late:attendance.filter(value=>value==='late').length,absent:attendance.filter(value=>value==='absent').length,excused:attendance.filter(value=>value==='excused').length},homework:{assigned:state.homework.filter(item=>item.status==='published').length,submitted:attempts.length,needsRevision:attempts.filter(item=>item.status==='needs_revision').length,averageScore:scores.length?Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length*10)/10:null,effort:effort as EffortLevel|null},projects,portfolio,mentorBookings:studentMentorBookings,notes:structuredClone(state.teacherNotes.filter(note=>note.studentId===student.id)),attentionReasons:reasons,recentActivityAt:attempts.map(item=>item.submittedAt).filter((value):value is string=>Boolean(value)).sort().at(-1)??null});
    }
    const todayKey=new Date().toISOString().slice(0,10); const attention=students.filter(student=>student.attentionReasons.length).map(student=>({studentId:student.id,studentName:student.firstName,reasons:student.attentionReasons}));
    const teacherPerson=state.directory[userId]??state.directory[PILOT_TEACHERS[0].id]!;const isMentor=teacherPerson.roles.includes('mentor');
    const teacherAvailability = mentorAvailability.map(item => ({...item,status:activeMentorBookings.some(booking => booking.availabilityId === item.id || (Date.parse(booking.startsAt)<Date.parse(item.endsAt)&&Date.parse(booking.endsAt)>Date.parse(item.startsAt)))?'booked' as const:item.status}));
    const homework=state.homework.map(item=>({...item,submissionCount:state.submissions.filter(value=>value.homeworkId===item.id).length,reviewCount:state.submissions.filter(value=>value.homeworkId===item.id&&Boolean(value.review)).length,needsRevisionCount:state.submissions.filter(value=>value.homeworkId===item.id&&value.status==='needs_revision').length}));const nextClass=allSessions.filter(item=>Date.parse(item.endsAt)>=Date.now()&&item.status!=='cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0];const attendanceCount=state.attendance.length,attendancePresent=state.attendance.filter(item=>item.status==='present'||item.status==='late').length;
    return{teacher:{id:userId,name:teacherPerson.displayName,title:teacherPerson.roles.includes('mentor')?'Викладач · Ментор':'Викладач',timezone:PILOT.timezone},metrics:{todayClasses:allSessions.filter(item=>item.startsAt.slice(0,10)===todayKey).length,awaitingReview:submissions.filter(item=>item.status==='submitted'&&!item.review).length,resubmitted:submissions.filter(item=>item.attemptNumber>1&&item.status==='submitted').length,mentorToday:mentorBookings.filter(item=>item.startsAt.slice(0,10)===todayKey).length,reportsPending:state.teacherReports.filter(item=>['draft','ready_for_review'].includes(item.status)).length},groups:[{id:groupId,courseId:DEV_IDS.course,name:groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:groupStudents.length,nextClassAt:nextClass?.startsAt??null,scheduleLabel:'8 занять · розклад уточнюється',progressPercent:groupStudents.length?Math.round(groupStudents.reduce((sum,item)=>sum+item.progressPercent,0)/groupStudents.length):0,attendanceRate:attendanceCount?Math.round(attendancePresent/attendanceCount*100):0,recentHomework:homework[0]?.title??null}],sessions:allSessions,homework,submissions,students,mentor:{mentorId:isMentor?PILOT.mentorId:null,availability:isMentor?teacherAvailability:[],bookings:isMentor?mentorBookings:[]},reports:structuredClone(state.teacherReports),lessons:SEEDED_LESSONS.map(lesson=>({id:lesson.id,title:lesson.title,moduleTitle:PILOT.moduleTitle})),attention};
  }

  async searchTeacherScope(userId:string,query:string):Promise<TeacherSearchDto>{const data=await this.getTeacherWorkspace(userId);const term=query.trim().toLocaleLowerCase('uk');const includes=(value:string)=>value.toLocaleLowerCase('uk').includes(term);return{students:data.students.filter(item=>includes(item.firstName)).map(item=>({id:item.id,label:item.firstName,meta:item.groupName})),groups:data.groups.filter(item=>includes(item.name)||includes(item.courseTitle)).map(item=>({id:item.id,label:item.name,meta:item.courseTitle})),homework:data.homework.filter(item=>includes(item.title)).map(item=>({id:item.id,label:item.title,meta:item.groupName})),projects:data.students.flatMap(student=>student.projects.filter(project=>includes(project.title)).map(project=>({id:project.id,label:project.title,meta:student.firstName})))}};

  async updateTeacherClass(userId:string,sessionId:string,input:{title?:string;description?:string;lessonId?:string|null;meetingUrl?:string|null;meetingProvider?:string|null;teacherNotes?:string;status?:'scheduled'|'in_progress'|'completed'|'cancelled'}):Promise<void>{this.requireRole(userId,'teacher');if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(input.title!==undefined)item.title=input.title;if(input.description!==undefined)item.description=input.description;if(input.lessonId!==undefined){item.lessonId=input.lessonId;item.lessonTitle=input.lessonId?SEEDED_LESSONS.find(value=>value.id===input.lessonId)?.title??null:null;}if(input.meetingUrl!==undefined)item.meetingUrl=input.meetingUrl;if(input.meetingProvider!==undefined)item.meetingProvider=input.meetingProvider;if(input.teacherNotes!==undefined)item.teacherNotes=input.teacherNotes;if(input.status!==undefined){item.status=input.status;if(input.status==='cancelled')item.changedAt=nowIso();}});}
  async addClassMaterial(userId:string,sessionId:string,input:{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}):Promise<void>{this.requireRole(userId,'teacher');if(!input.url.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const id=randomUUID();await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');item.materials.push({id,kind:input.kind,title:input.title,url:input.url});});}
  async bulkConfirmAttendance(userId:string,sessionId:string,entries:Array<{studentId:string;status:'present'|'late'|'absent'|'excused';note?:string}>):Promise<void>{const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);this.requireRole(userId,'teacher');if(!entries.length)throw new AppError('ATTENDANCE_EMPTY',400,'Додайте учнів');const allowed=new Set(this.activeStudents(snapshot).map(student=>student.id));if(entries.some(entry=>!allowed.has(entry.studentId)))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const confirmedAt=nowIso(),ids=entries.map(()=>randomUUID());await this.runtimeStore.mutate(state=>{if(!state.classSessions.some(item=>item.id===sessionId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');entries.forEach((entry,index)=>{const record=state.attendance.find(item=>item.sessionId===sessionId&&item.studentId===entry.studentId);if(record){record.status=entry.status;record.note=entry.note??'';record.confirmedAt=confirmedAt;}else state.attendance.push({id:ids[index]!,sessionId,studentId:entry.studentId,status:entry.status,note:entry.note??'',confirmedAt});});});}
  async publishHomework(userId:string,homeworkId:string,publishAt:string):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const homework=state.homework.find(item=>item.id===homeworkId);if(!homework)throw new AppError('HOMEWORK_FORBIDDEN',403,'Домашня робота недоступна');if(homework.status!=='draft')throw new AppError('HOMEWORK_STATE',409,'Опублікувати можна лише чернетку');if(homework.dueAt&&Date.parse(homework.dueAt)<=Date.parse(publishAt))throw new AppError('INVALID_TIME',400,'Дедлайн має бути після публікації');homework.status='published';homework.publishAt=publishAt;});}
  async createTeacherNote(userId:string,studentId:string,input:{category:'general'|'learning'|'project'|'mentoring';content:string}):Promise<TeacherPrivateNoteDto>{const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);this.requireRole(userId,'teacher');if(!this.activeStudents(snapshot).some(student=>student.id===studentId))throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');const timestamp=nowIso(),note={id:randomUUID(),studentId,category:input.category,content:input.content,createdAt:timestamp,updatedAt:timestamp};await this.runtimeStore.mutate(state=>{state.teacherNotes.unshift(note);});return structuredClone(note);}
  async updatePortfolioItemAsTeacher(userId:string,portfolioProjectId:string,input:{title?:string|null;shortDescription?:string;reflection?:string;learned?:string}):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const item=Object.values(state.portfolioProjects).flat().find(project=>project.id===portfolioProjectId);if(!item)throw new AppError('PORTFOLIO_FORBIDDEN',403,'Елемент портфоліо недоступний');if(input.title)item.title=input.title;if(input.shortDescription!==undefined)item.shortDescription=input.shortDescription;if(input.reflection!==undefined)item.reflection=input.reflection;if(input.learned!==undefined)item.learned=input.learned;});}
  async createMentorAvailability(userId:string,input:{startsAt:string;endsAt:string;timezone:string;status:'open'|'blocked'}):Promise<void>{this.requireMentor(userId);if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний часовий інтервал');const result=await this.mentoringStore.createAvailability({id:randomUUID(),mentorId:PILOT.mentorId,...input});if(result==='conflict')throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час перетинається з іншим вікном або зустріччю');}
  async updateMentorBooking(userId:string,bookingId:string,input:{status:'confirmed'|'completed'|'cancelled'|'rescheduled'|'no_show';meetingUrl?:string|null;startsAt?:string;endsAt?:string}):Promise<void>{this.requireMentor(userId);if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');if(input.status==='rescheduled'&&(!input.startsAt||!input.endsAt||Date.parse(input.endsAt)<=Date.parse(input.startsAt)))throw new AppError('INVALID_TIME',400,'Для переносу потрібен новий час');const bookings=await this.mentoringStore.listBookings(PILOT.mentorId);const booking=bookings.find(item=>item.id===bookingId);if(!booking)throw new AppError('BOOKING_FORBIDDEN',403,'Бронювання недоступне');const result=await this.mentoringStore.updateBooking(PILOT.mentorId,bookingId,{status:input.status,meetingUrl:input.meetingUrl!==undefined?input.meetingUrl:booking.meetingUrl,startsAt:input.startsAt??booking.startsAt,endsAt:input.endsAt??booking.endsAt});if(result==='not_found')throw new AppError('BOOKING_FORBIDDEN',403,'Бронювання недоступне');if(result==='conflict')throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час зайнятий іншою зустріччю');}
  async generateTeacherReports(userId:string,groupId:string,periodStart:string,periodEnd:string):Promise<void>{this.requireRole(userId,'teacher');if(groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');const ids=Object.fromEntries(PILOT_STUDENTS.map(item=>[item.id,randomUUID()]));await this.runtimeStore.mutate(state=>{for(const student of PILOT_STUDENTS){if(state.teacherReports.some(report=>report.studentId===student.id&&report.periodStart===periodStart&&report.periodEnd===periodEnd))continue;state.teacherReports.push({id:ids[student.id]!,studentId:student.id,studentFirstName:student.fullName,groupId,groupName:PILOT.groupName,periodStart,periodEnd,payload:{classesScheduled:state.classSessions.length,classesAttended:state.attendance.filter(item=>item.studentId===student.id&&['present','late'].includes(item.status)).length,homeworkSubmitted:state.submissions.filter(item=>item.studentId===student.id).length,project:state.projects[student.id]?.find(item=>item.status==='active')?.title??null,projectProgress:this.progressPercent(state,student.id),xpEarned:state.xp[student.id]??0},teacherComment:'',status:'draft',approvedAt:null});}});}
  async saveTeacherReport(userId:string,reportId:string,input:{teacherComment:string;status:'draft'|'ready_for_review'}):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');report.teacherComment=input.teacherComment;report.status=input.status;});}
  async approveTeacherReport(userId:string,reportId:string):Promise<void>{this.requireRole(userId,'teacher');const approvedAt=nowIso();await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');if(report.status!=='ready_for_review'||!report.teacherComment.trim())throw new AppError('REPORT_NOT_READY',409,'Звіт ще не готовий до підтвердження');report.status='approved';report.approvedAt=approvedAt;});}
  async listLinkedStudents(userId:string):Promise<TeacherStudentDto[]>{const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId,'guardian');return state.guardianRelations.filter(link=>link.guardianId===userId&&link.status==='active').flatMap(link=>{const student=state.directory[link.studentId];return student&&student.roles.includes('student')&&student.status!=='archived'?[{id:student.id,firstName:student.displayName,progressPercent:this.progressPercent(state,student.id),projectTitle:state.projects[student.id]?.find(item=>item.status==='active')?.title??null}]:[];});}
  async listParentReports(userId:string,studentId:string):Promise<ParentReportDto[]>{const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireGuardianStudent(state,userId,studentId);const student=state.directory[studentId]!;return structuredClone(state.teacherReports.filter(report=>report.studentId===studentId&&['approved','sent'].includes(report.status)).map(report=>({id:report.id,studentId:report.studentId,studentFirstName:student.displayName,periodStart:report.periodStart,periodEnd:report.periodEnd,payload:report.payload,teacherComment:report.teacherComment,status:report.status})));}

  async getParentSummary(userId:string,studentId:string):Promise<ParentSummaryDto>{const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireGuardianStudent(state,userId,studentId);return this.parentSummary(state,studentId);}
  async getTelegramAudience(telegramId:string):Promise<{userId:string;roles:string[];displayName:string}|null>{const state=await this.runtimeStore.read();this.syncDirectory(state);const id=state.telegramBindings[telegramId]??this.identities.get(`telegram:${telegramId}`);if(!id)return null;const person=state.directory[id];if(!person||person.status!=='active')return null;return{userId:id,roles:[...person.roles],displayName:person.displayName};}
  async getGuardianSummaryByTelegram(telegramId:string,studentId?:string):Promise<{students:TeacherStudentDto[];selected:ParentSummaryDto|null}>{const audience=await this.getTelegramAudience(telegramId);if(!audience||!audience.roles.includes('guardian'))throw new AppError('TELEGRAM_ACCOUNT_NOT_LINKED',403,'Telegram-акаунт не прив’язано до профілю когось із батьків');const students=await this.listLinkedStudents(audience.userId);if(studentId&&!students.some(item=>item.id===studentId))throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');const selectedId=studentId??(students.length===1?students[0]!.id:undefined);return{students,selected:selectedId?await this.getParentSummary(audience.userId,selectedId):null};}

  async createParentContactRequestByTelegram(telegramId:string,studentId:string,category:ParentContactCategory,message:string):Promise<ParentContactRequestDto>{
    const audience=await this.getTelegramAudience(telegramId);if(!audience?.roles.includes('guardian'))throw new AppError('TELEGRAM_ACCOUNT_NOT_LINKED',403,'Telegram-акаунт не прив’язано до профілю когось із батьків');
    const state=await this.runtimeStore.read();this.requireGuardianStudent(state,audience.userId,studentId);const id=randomUUID(),createdAt=nowIso(),trimmed=message.trim().slice(0,1000);if(!trimmed)throw new AppError('PARENT_REQUEST_MESSAGE_REQUIRED',400,'Опишіть запит коротким повідомленням');
    await this.runtimeStore.mutate(next=>{this.requireGuardianStudent(next,audience.userId,studentId);next.parentContactRequests.unshift({id,guardianId:audience.userId,studentId,category,message:trimmed,status:'new',createdAt,resolvedAt:null});});
    const guardian=state.directory[audience.userId]!,student=state.directory[studentId]!;return{id,guardianId:guardian.id,guardianName:guardian.displayName,studentId:student.id,studentName:student.displayName,category,message:trimmed,status:'new',createdAt,resolvedAt:null};
  }

  async listMissedLessonRecoveries(userId:string):Promise<MissedLessonRecoveryDto[]>{
    const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId,'student');const slots=(await this.mentoringStore.listAvailability(PILOT.mentorId)).filter(item=>item.status==='open'&&Date.parse(item.startsAt)>Date.now()).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt));
    return state.attendance.filter(item=>item.studentId===userId&&item.status==='absent').flatMap(record=>{const session=state.classSessions.find(item=>item.id===record.sessionId);if(!session)return[];const homework=state.homework.find(item=>item.classSessionId===session.id),submission=homework?state.submissions.filter(item=>item.studentId===userId&&item.homeworkId===homework.id).sort((a,b)=>b.attemptNumber-a.attemptNumber)[0]:undefined;const status=submission?.status==='completed'?'completed':submission?'in_progress':'available';return[{sessionId:session.id,lessonId:session.lessonId,lessonTitle:session.lessonTitle??session.title,title:session.title,description:session.description,startsAt:session.startsAt,materials:session.materials.filter(item=>!item.url||item.url.startsWith('https://')),homework:homework?{id:homework.id,title:homework.title,instructions:homework.instructions,state:submission?.status??'not_started'}:null,recordingUrl:null,mentorSlotId:slots[0]?.id??null,status}];});
  }

  async prepareNotificationBatch(now:Date,weeklyDay:number,weeklyHour:number,limit:number):Promise<NotificationDeliveryDto[]>{
    const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);const candidates:NotificationCandidate[]=[],nowMs=now.getTime(),recent=(value:string|null|undefined)=>Boolean(value&&nowMs-Date.parse(value)>=0&&nowMs-Date.parse(value)<=7_200_000),format=(value:string)=>new Intl.DateTimeFormat('uk-UA',{timeZone:'Europe/Kyiv',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
    const students=this.activeStudents(snapshot),guardiansFor=(studentId:string)=>snapshot.guardianRelations.filter(link=>link.studentId===studentId&&link.status==='active').map(link=>link.guardianId).filter(id=>snapshot.directory[id]?.status==='active');
    for(const session of snapshot.classSessions){const delta=Date.parse(session.startsAt)-nowMs;if(['scheduled','rescheduled'].includes(session.status)){for(const student of students){if(delta>82_800_000&&delta<=90_000_000)candidates.push(this.notificationCandidate(student.id,'student_class_24h',session.id,`class24:${session.id}:${student.id}`,`🚀 Завтра заняття\n\n${session.title}\n${format(session.startsAt)}`,now));if(delta>1_800_000&&delta<=5_400_000)candidates.push(this.notificationCandidate(student.id,'student_class_1h',session.id,`class1:${session.id}:${student.id}`,`⏰ Через годину починаємо\n\n${session.title}\n${format(session.startsAt)}`,now,session.meetingUrl?{buttonText:'🎥 Приєднатися до заняття',buttonUrl:session.meetingUrl}:{}));}}
      if(recent(session.changedAt)&&['rescheduled','cancelled'].includes(session.status))for(const student of students)for(const guardianId of guardiansFor(student.id))candidates.push(this.notificationCandidate(guardianId,`guardian_session_${session.status}`,session.id,`session:${session.status}:${session.id}:${session.startsAt}:${guardianId}`,`${session.status==='cancelled'?'❌ Заняття скасовано':'📅 Час заняття змінено'}\n\n${student.displayName} · ${session.title}\n${format(session.startsAt)}`,now,{studentId:student.id,buttonText:'Відкрити кабінет',callbackData:`parent:student:${student.id}`}));
    }
    for(const homework of snapshot.homework.filter(item=>item.status==='published'))for(const student of students){const attempts=snapshot.submissions.filter(item=>item.studentId===student.id&&item.homeworkId===homework.id),submitted=attempts.some(item=>Boolean(item.submittedAt));if(recent(homework.publishAt))candidates.push(this.notificationCandidate(student.id,'student_homework_assigned',homework.id,`homework:assigned:${homework.id}:${student.id}`,`📝 Нове домашнє завдання\n\n${homework.title}${homework.dueAt?`\nДедлайн: ${format(homework.dueAt)}`:''}`,now));if(homework.dueAt&&!submitted){const delta=Date.parse(homework.dueAt)-nowMs;if(delta>82_800_000&&delta<=90_000_000)candidates.push(this.notificationCandidate(student.id,'student_homework_deadline',homework.id,`homework:deadline:${homework.id}:${student.id}`,`⏳ Нагадування про домашнє завдання\n\n${homework.title}\nДедлайн: ${format(homework.dueAt)}`,now));if(delta<=0&&delta>=-7_200_000)candidates.push(this.notificationCandidate(student.id,'student_homework_overdue',homework.id,`homework:overdue:${homework.id}:${student.id}`,`⚠️ Домашнє завдання прострочено\n\n${homework.title}`,now));}}
    for(const submission of snapshot.submissions)if(submission.review&&recent(submission.review.reviewedAt)){const homework=snapshot.homework.find(item=>item.id===submission.homeworkId);candidates.push(this.notificationCandidate(submission.studentId,'student_homework_reviewed',submission.id,`homework:reviewed:${submission.id}:${submission.review.reviewedAt}`,`✅ Викладач перевірив твоє завдання\n\n${homework?.title??'Домашнє завдання'}\nОцінка: ${submission.review.score}/10\n${submission.review.feedback.slice(0,500)}`,now));}
    for(const attendance of snapshot.attendance)if(attendance.status==='absent'&&recent(attendance.confirmedAt)){const student=snapshot.directory[attendance.studentId],session=snapshot.classSessions.find(item=>item.id===attendance.sessionId);if(student&&session)for(const guardianId of guardiansFor(student.id))candidates.push(this.notificationCandidate(guardianId,'guardian_absent_lesson',attendance.id,`attendance:absent:${attendance.id}:${attendance.confirmedAt}:${guardianId}`,`📅 ${student.displayName} пропустив(ла) заняття\n\n${session.title}\nМатеріали для самостійного опрацювання вже доступні.`,now,{studentId:student.id,buttonText:'Відкрити кабінет',callbackData:`parent:student:${student.id}`}));}
    const kyiv=this.kyivParts(now);if(kyiv.day===weeklyDay&&kyiv.hour===weeklyHour){const weekKey=this.weekKey(kyiv.date);for(const link of snapshot.guardianRelations.filter(item=>item.status==='active')){const guardian=snapshot.directory[link.guardianId],student=snapshot.directory[link.studentId];if(!guardian||guardian.status!=='active'||!student||student.status!=='active')continue;candidates.push(this.notificationCandidate(guardian.id,'guardian_weekly_digest',student.id,`weekly:${guardian.id}:${student.id}:${weekKey}`,this.weeklyDigestText(snapshot,student.id,weekKey),now,{studentId:student.id,weekKey,buttonText:'Відкрити кабінет',callbackData:`parent:student:${student.id}`}));}}
    await this.runtimeStore.mutate(state=>{const keys=new Set(state.notifications.map(item=>item.idempotencyKey));for(const candidate of candidates){if(keys.has(candidate.idempotencyKey))continue;const telegram=this.telegramForUser(state,candidate.recipientUserId);if(!telegram)continue;state.notifications.push({id:randomUUID(),recipientUserId:candidate.recipientUserId,recipientTelegramId:telegram,type:candidate.type,relatedEntityId:candidate.relatedEntityId,scheduledFor:candidate.scheduledFor,sentAt:null,status:'pending',attempts:0,lastAttemptAt:null,nextAttemptAt:null,idempotencyKey:candidate.idempotencyKey,safeMetadata:candidate.safeMetadata,errorCode:null});keys.add(candidate.idempotencyKey);}});
    return this.runtimeStore.mutate(state=>{const claimed:NotificationDeliveryDto[]=[];for(const item of state.notifications){if(claimed.length>=limit)break;const retryable=item.status==='pending'||item.status==='failed'&&(!item.nextAttemptAt||Date.parse(item.nextAttemptAt)<=nowMs)||item.status==='processing'&&Boolean(item.lastAttemptAt)&&nowMs-Date.parse(item.lastAttemptAt!)>600_000;if(!retryable||item.attempts>=5||Date.parse(item.scheduledFor)>nowMs)continue;const person=state.directory[item.recipientUserId],telegram=this.telegramForUser(state,item.recipientUserId),studentId=item.safeMetadata.studentId;if(!person||person.status!=='active'||!telegram||studentId&&(!state.directory[studentId]||state.directory[studentId]!.status!=='active'||!state.guardianRelations.some(link=>link.guardianId===item.recipientUserId&&link.studentId===studentId&&link.status==='active'))){item.status='skipped';item.errorCode='RECIPIENT_NO_LONGER_AUTHORIZED';continue;}item.recipientTelegramId=telegram;item.status='processing';item.attempts+=1;item.lastAttemptAt=now.toISOString();claimed.push({id:item.id,recipientUserId:item.recipientUserId,recipientTelegramId:telegram,type:item.type,relatedEntityId:item.relatedEntityId,text:item.safeMetadata.text,buttonText:item.safeMetadata.buttonText??null,buttonUrl:item.safeMetadata.buttonUrl??null,callbackData:item.safeMetadata.callbackData??null,attempts:item.attempts});}return claimed;});
  }

  async completeNotificationDelivery(notificationId:string,sent:boolean,errorCode:string|null,now:Date,retryable=true):Promise<void>{await this.runtimeStore.mutate(state=>{const item=state.notifications.find(value=>value.id===notificationId);if(!item||item.status!=='processing')return;item.errorCode=errorCode;if(sent){item.status='sent';item.sentAt=now.toISOString();item.nextAttemptAt=null;}else if(retryable){item.status='failed';item.nextAttemptAt=new Date(now.getTime()+Math.min(21_600_000,300_000*2**Math.max(0,item.attempts-1))).toISOString();}else{item.status='skipped';item.nextAttemptAt=null;}});}

  async getAdminWorkspace(userId:string):Promise<AdminWorkspaceDto>{
    const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId,'admin');const teacher=await this.getTeacherWorkspace(userId);const now=Date.now();
    const studentPeople=Object.values(state.directory).filter(item=>item.roles.includes('student'));
    const students=studentPeople.map(person=>{const student=teacher.students.find(item=>item.id===person.id);const attendance=state.attendance.filter(item=>item.studentId===person.id);const attempts=state.submissions.filter(item=>item.studentId===person.id);const guardianIds=state.guardianRelations.filter(link=>link.studentId===person.id&&link.status==='active').map(link=>link.guardianId);return{id:person.id,name:person.displayName,firstName:person.firstName,lastName:person.lastName,version:person.version,status:state.userStatus[person.id]??person.status,group:PILOT.groupName,groupId:person.groupId,course:PILOT.courseTitle,progress:student?.progressPercent??this.progressPercent(state,person.id),xp:state.xp[person.id]??0,level:student?.level??LEVELS[0]!.title,streak:state.streak[person.id]??0,attendance:student?.attendance??{present:attendance.filter(item=>item.status==='present').length,late:attendance.filter(item=>item.status==='late').length,absent:attendance.filter(item=>item.status==='absent').length,excused:attendance.filter(item=>item.status==='excused').length},homework:student?.homework??{assigned:state.homework.filter(item=>item.status==='published').length,submitted:attempts.length,needsRevision:attempts.filter(item=>item.status==='needs_revision').length,averageScore:null,effort:null},project:state.projects[person.id]?.find(item=>item.status==='active')?.title??null,guardianLinked:guardianIds.length>0,guardianIds,telegramLinked:Boolean(person.telegramId),telegramId:person.telegramId};});
    const teachers=Object.values(state.directory).filter(item=>item.roles.some(role=>['teacher','mentor','admin'].includes(role))&&item.id!=='14000000-0000-4000-8000-000000000001').map(item=>({id:item.id,name:item.displayName,firstName:item.firstName,lastName:item.lastName,email:item.email,version:item.version,status:item.status,credentialStatus:item.passwordHash?'active':item.activationTokenHash?'pending_activation':'external_seed',roles:item.roles.filter(role=>['teacher','mentor','admin'].includes(role)),groups:item.roles.includes('teacher')?1:0,upcomingClasses:item.roles.includes('teacher')?teacher.sessions.filter(session=>Date.parse(session.startsAt)>now&&session.status!=='cancelled').length:0,classesTaught:0,reviews:0,mentor:item.roles.includes('mentor')}));
    const guardians=Object.values(state.directory).filter(item=>item.roles.includes('guardian')).map(item=>{const links=state.guardianRelations.filter(link=>link.guardianId===item.id&&link.status==='active'),recentNotifications=state.notifications.filter(notification=>notification.recipientUserId===item.id).sort((a,b)=>Date.parse(b.scheduledFor)-Date.parse(a.scheduledFor));return{id:item.id,name:item.displayName,firstName:item.firstName,lastName:item.lastName,email:item.email,phone:item.phone,version:item.version,linkedStudents:links.map(link=>state.directory[link.studentId]?.displayName??link.studentId),studentIds:links.map(link=>link.studentId),relationshipStatus:links.length?'active':'revoked',telegramLinked:Boolean(item.telegramId),telegramId:item.telegramId,status:item.status,recentNotifications:recentNotifications.slice(0,3).map(notification=>({type:notification.type,status:notification.status,scheduledFor:notification.scheduledFor})),lastWeeklyReport:recentNotifications.find(notification=>notification.type==='guardian_weekly_digest')?.sentAt??null,parentRequestCount:state.parentContactRequests.filter(request=>request.guardianId===item.id&&request.status==='new').length};});
    const sessions=teacher.sessions.map(item=>({id:item.id,title:item.title,group:item.groupName,teacher:item.teacherName,lesson:item.lessonTitle,startsAt:item.startsAt,durationMinutes:item.durationMinutes,status:item.status,meetingProvider:item.meetingProvider,meetingUrl:item.meetingUrl,attendanceComplete:item.attendance.every(entry=>entry.status)}));
    const homework=teacher.homework.map(item=>({id:item.id,title:item.title,group:item.groupName,status:item.status,dueAt:item.dueAt,submissions:item.submissionCount,reviews:item.reviewCount,revisions:item.needsRevisionCount}));
    const projects=studentPeople.flatMap(person=>(state.projects[person.id]??[]).map(project=>{const dto=this.projectDto(project);return{id:dto.id,studentId:person.id,student:person.displayName,title:dto.title,stage:dto.stage.title,progress:dto.completionPercent,technologies:dto.tags,status:dto.status};}));
    const portfolios=studentPeople.map(person=>{const portfolio=this.portfolioFromState(state,person.id);return{id:portfolio.id,studentId:person.id,student:person.displayName,title:portfolio.title,visibility:state.portfolioVisibility[portfolio.id]??portfolio.visibility,items:portfolio.projects.length};});
    const activeSessions=(await this.sessionStore.listActive(new Date(now))).map(item=>({id:item.id,userId:item.userId,user:this.users.get(item.userId)?.displayName??'Користувач',role:this.roles.get(item.userId),provider:item.provider,createdAt:item.createdAt.toISOString(),expiresAt:item.expiresAt.toISOString(),status:'active'}));
    const reports=teacher.reports.map(item=>({...item,guardianRelationshipActive:state.guardianRelations.some(link=>link.studentId===item.studentId&&link.status==='active')}));
    const parentRequests=state.parentContactRequests.map(request=>({id:request.id,guardianId:request.guardianId,guardian:state.directory[request.guardianId]?.displayName??request.guardianId,studentId:request.studentId,student:state.directory[request.studentId]?.displayName??request.studentId,category:request.category,message:request.message,status:request.status,createdAt:request.createdAt,resolvedAt:request.resolvedAt}));const notificationProjection=state.notifications.slice().sort((a,b)=>Date.parse(b.scheduledFor)-Date.parse(a.scheduledFor)).slice(0,100).map(item=>({id:item.id,category:item.type,recipient:state.directory[item.recipientUserId]?.displayName??item.recipientUserId,status:item.status,scheduledAt:item.scheduledFor,attempts:item.attempts,sentAt:item.sentAt}));
    return{admin:{id:userId,name:this.requireUser(userId).displayName,role:'admin',mfaRequired:true},metrics:{activeStudents:students.filter(item=>item.status==='active').length,activeGroups:teacher.groups.length,teachers:teachers.length,upcomingClasses:sessions.filter(item=>Date.parse(String(item.startsAt))>now&&!['cancelled','completed'].includes(String(item.status))).length,classesToday:sessions.filter(item=>String(item.startsAt).slice(0,10)===new Date().toISOString().slice(0,10)).length,awaitingReview:teacher.metrics.awaitingReview,needsRevision:teacher.homework.reduce((sum,item)=>sum+item.needsRevisionCount,0),mentorBookings:teacher.mentor.bookings.length,attendanceIssues:teacher.students.reduce((sum,item)=>sum+item.attendance.absent+item.attendance.late,0),reportsAwaiting:reports.filter(item=>item.status==='ready_for_review').length,recentProjects:projects.length,portfolioMilestones:portfolios.reduce((sum,item)=>sum+Number(item.items),0)},students,teachers,guardians,groups:teacher.groups.map(item=>({...item})),sessions,homework,projects,portfolios,mentorBookings:teacher.mentor.bookings.map(item=>({...item})),reports,notifications:notificationProjection,parentRequests,activeSessions,auditEvents:structuredClone(state.adminAuditEvents),securityEvents:structuredClone(state.securityEvents),health:{productionMode:{status:'warning',label:'Перевіряється з server environment'},database:{status:'ok',label:'Repository доступний'},rls:{status:'warning',label:'Потребує integration test'},telegram:{status:'warning',label:'Статус без розкриття секрету'},storage:{status:'required',label:'Приватне сховище потребує конфігурації'},signingKeys:{status:'ok',label:'JWT signer завантажений'},devAuth:{status:'warning',label:'Дозволено лише поза production'},origins:{status:'ok',label:'Allowlist налаштовано'},securityHeaders:{status:'ok',label:'Helmet/CSP увімкнено'}}};
  }

  async searchAdmin(userId:string,query:string):Promise<AdminSearchDto>{const data=await this.getAdminWorkspace(userId),term=query.toLocaleLowerCase('uk'),match=(value:unknown)=>String(value??'').toLocaleLowerCase('uk').includes(term);return{results:[...data.students.filter(x=>match(x.name)).map(x=>({type:'student' as const,id:String(x.id),label:String(x.name),meta:String(x.group)})),...data.teachers.filter(x=>match(x.name)).map(x=>({type:'teacher' as const,id:String(x.id),label:String(x.name),meta:'Викладач'})),...data.guardians.filter(x=>match(x.name)).map(x=>({type:'guardian' as const,id:String(x.id),label:String(x.name),meta:'Батьки'})),...data.groups.filter(x=>match(x.name)).map(x=>({type:'group' as const,id:String(x.id),label:String(x.name),meta:String(x.courseTitle)})),...data.sessions.filter(x=>match(x.title)).map(x=>({type:'class' as const,id:String(x.id),label:String(x.title),meta:String(x.group)})),...data.projects.filter(x=>match(x.title)).map(x=>({type:'project' as const,id:String(x.id),label:String(x.title),meta:String(x.student)}))].slice(0,30)}};

  async exploreAdmin(userId:string,input:{entity:AdminEntity;page:number;pageSize:number;sort:string;direction:'asc'|'desc';query?:string}):Promise<AdminExplorerPageDto>{const data=await this.getAdminWorkspace(userId);const map:Record<AdminEntity,Array<Record<string,unknown>>>={users:[...data.students,...data.teachers,...data.guardians],students:data.students,teachers:data.teachers,guardians:data.guardians,groups:data.groups,courses:[{id:DEV_IDS.course,title:PILOT.courseTitle,status:'published'}],modules:[{id:DEV_IDS.module,title:PILOT.moduleTitle,status:'published'}],lessons:SEEDED_LESSONS.map((item,index)=>({id:item.id,title:item.title,position:index+1,status:'published'})),sessions:data.sessions,attendance:(await this.getTeacherWorkspace(userId)).sessions.flatMap(item=>item.attendance.map(entry=>({id:`${item.id}:${entry.studentId}`,session:item.title,student:entry.studentName,status:entry.status,confirmedAt:entry.confirmedAt}))),homework:data.homework,submissions:(await this.getTeacherWorkspace(userId)).submissions.map(item=>({id:item.id,homework:item.homeworkTitle,student:item.studentName,attempt:item.attemptNumber,status:item.status,submittedAt:item.submittedAt})),reviews:(await this.getTeacherWorkspace(userId)).submissions.filter(item=>item.review).map(item=>({id:item.id,student:item.studentName,score:item.review!.score,effort:item.review!.effort,status:item.review!.status})),projects:data.projects,portfolios:data.portfolios,mentor_bookings:data.mentorBookings,reports:data.reports};let records=map[input.entity];const allowedSorts=new Set(records.length?Object.keys(records[0]!):['id']);if(!allowedSorts.has(input.sort))throw new AppError('INVALID_SORT',400,'Недозволене поле сортування');if(input.query){const term=input.query.toLocaleLowerCase('uk');records=records.filter(item=>Object.values(item).some(value=>String(value??'').toLocaleLowerCase('uk').includes(term)));}records=[...records].sort((left,right)=>String(left[input.sort]??'').localeCompare(String(right[input.sort]??''),'uk')*(input.direction==='asc'?1:-1));const total=records.length,start=(input.page-1)*input.pageSize;return{entity:input.entity,page:input.page,pageSize:input.pageSize,total,sort:input.sort,direction:input.direction,records:structuredClone(records.slice(start,start+input.pageSize))};}

  async adminSetAccountStatus(userId:string,targetUserId:string,status:'active'|'disabled'|'archived',reason:string,correlationId:string):Promise<void>{const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);this.requireRole(userId,'admin');const target=snapshot.directory[targetUserId];if(!target)throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');if(status!=='active'&&target.roles.includes('admin')&&this.activeAdminCount(snapshot)<=1)throw new AppError('LAST_ADMIN_REQUIRED',409,'Не можна вимкнути або архівувати останнього адміністратора');await this.runtimeStore.mutate(state=>{const person=state.directory[targetUserId];if(!person)throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');const previous=state.userStatus[targetUserId]??'disabled',kind=person.roles.includes('student')?'student':person.roles.includes('guardian')?'guardian':'teacher',verb=status==='active'?'activated':status==='disabled'?'deactivated':'archived';state.userStatus[targetUserId]=status;person.status=status;person.updatedAt=nowIso();person.version+=1;this.addAudit(state,userId,'account.status_changed','user',targetUserId,{previous,status,reason},correlationId);this.addAudit(state,userId,`${kind}.${verb}`,kind,targetUserId,{previous,status,reason},correlationId);});if(status!=='active')await this.sessionStore.revokeUser(targetUserId,new Date());}
  async adminCorrectAttendance(userId:string,attendanceId:string,status:'present'|'late'|'absent'|'excused',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const confirmedAt=nowIso();await this.runtimeStore.mutate(state=>{const entry=state.attendance.find(item=>item.id===attendanceId);if(!entry)throw new AppError('ATTENDANCE_NOT_FOUND',404,'Відвідування не знайдено');const previous=entry.status;entry.status=status;entry.confirmedAt=confirmedAt;this.addAudit(state,userId,'attendance.corrected','attendance',attendanceId,{previous,status,reason},correlationId);});}
  async adminSetPortfolioVisibility(userId:string,portfolioId:string,visibility:'private'|'shareable'|'public',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{if(!(portfolioId in state.portfolioVisibility))throw new AppError('PORTFOLIO_NOT_FOUND',404,'Портфоліо не знайдено');const previous=state.portfolioVisibility[portfolioId];state.portfolioVisibility[portfolioId]=visibility;this.addAudit(state,userId,'portfolio.visibility_changed','portfolio',portfolioId,{previous,visibility,reason},correlationId);});}
  async adminRevokeGuardianLink(userId:string,linkId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{const link=state.guardianRelations.find(item=>item.id===linkId);if(!link)throw new AppError('GUARDIAN_LINK_NOT_FOUND',404,'Зв’язок не знайдено');link.status='revoked';link.updatedAt=nowIso();this.addAudit(state,userId,'guardian.relationship_revoked','guardian_link',linkId,{reason},correlationId);});}
  async adminResendReport(userId:string,reportId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const timestamp=nowIso();await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);const links=report?state.guardianRelations.filter(link=>link.studentId===report.studentId&&link.status==='active'):[];if(!report||!['approved','sent','failed'].includes(report.status)||!links.length)throw new AppError('REPORT_RESEND_FORBIDDEN',409,'Звіт не готовий або зв’язок із батьками неактивний');for(const link of links){const guardian=state.directory[link.guardianId],telegram=this.telegramForUser(state,link.guardianId);if(!guardian||guardian.status!=='active'||!telegram)continue;const key=`report-resend:${report.id}:${link.guardianId}:${correlationId}`;if(state.notifications.some(item=>item.idempotencyKey===key))continue;state.notifications.push({id:randomUUID(),recipientUserId:link.guardianId,recipientTelegramId:telegram,type:'guardian_weekly_report_resend',relatedEntityId:report.id,scheduledFor:timestamp,sentAt:null,status:'pending',attempts:0,lastAttemptAt:null,nextAttemptAt:null,idempotencyKey:key,safeMetadata:{studentId:report.studentId,text:`📊 Тижневий звіт · ${report.studentFirstName}\n\nПеріод: ${report.periodStart} — ${report.periodEnd}${report.teacherComment?`\n\n💬 Коментар викладача: ${report.teacherComment.slice(0,700)}`:''}`,callbackData:`parent:student:${report.studentId}`,buttonText:'Відкрити кабінет'},errorCode:null});}this.addAudit(state,userId,'report.resend_requested','parent_report',reportId,{recipients:links.length},correlationId);});}
  async adminRevokeUserSession(userId:string,sessionId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const session=await this.sessionStore.revokeById(sessionId,new Date());if(!session)throw new AppError('SESSION_NOT_FOUND',404,'Сесію не знайдено');const createdAt=nowIso(),id=randomUUID();await this.runtimeStore.mutate(state=>{this.addAudit(state,userId,'session.revoked','auth_session',sessionId,{subjectUserId:session.userId,reason},correlationId);state.securityEvents.unshift({id,type:'forced_session_revocation',severity:'medium',actorId:userId,targetId:session.userId,createdAt,correlationId});});}

  async adminCreateStudent(userId:string,input:{firstName:string;lastName:string;groupId:string;telegramId?:string;status:'active'|'disabled'},correlationId:string):Promise<Record<string,unknown>>{this.requireRole(userId,'admin');const id=randomUUID(),timestamp=nowIso(),telegramId=input.telegramId?this.normalizeTelegramId(input.telegramId):null;await this.runtimeStore.mutate(state=>{if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_NOT_FOUND',404,'Групу не знайдено');if(telegramId)this.assertTelegramAvailable(state,telegramId);const person=this.newPerson(id,input.firstName,input.lastName,['student'],input.status,{groupId:input.groupId,telegramId},timestamp);state.directory[id]=person;state.userStatus[id]=input.status;if(telegramId)state.telegramBindings[telegramId]=id;state.xp[id]=0;state.streak[id]=0;state.lessonProgress[id]={[SEEDED_LESSONS[0]!.id]:{progressPercent:0,completedAt:null}};state.projects[id]=[];state.achievements[id]=[];state.portfolioProjects[id]=[];state.portfolioVisibility[`portfolio:${id}`]='private';this.addAudit(state,userId,'student.created','student',id,{groupId:input.groupId,telegramLinked:Boolean(telegramId),status:input.status},correlationId);});return{id,version:1};}
  async adminUpdateStudent(userId:string,studentId:string,input:{firstName?:string;lastName?:string;groupId?:string;expectedVersion:number},correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{const person=this.expectPerson(state,studentId,'student');this.assertVersion(person,input.expectedVersion);if(input.groupId!==undefined&&input.groupId!==PILOT.groupId)throw new AppError('GROUP_NOT_FOUND',404,'Групу не знайдено');if(input.firstName!==undefined)person.firstName=input.firstName;if(input.lastName!==undefined)person.lastName=input.lastName;if(input.groupId!==undefined)person.groupId=input.groupId;this.touchPerson(person);this.addAudit(state,userId,'student.edited','student',studentId,{groupId:person.groupId},correlationId);});}
  async adminSetTelegramBinding(userId:string,targetUserId:string,telegramId:string|null,expectedVersion:number,correlationId:string):Promise<void>{this.requireRole(userId,'admin');let revoke=false;await this.runtimeStore.mutate(state=>{const person=state.directory[targetUserId];if(!person||!person.roles.some(role=>role==='student'||role==='guardian'))throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');this.assertVersion(person,expectedVersion);const normalized=telegramId===null?null:this.normalizeTelegramId(telegramId);if(normalized)this.assertTelegramAvailable(state,normalized,targetUserId);const previous=person.telegramId;revoke=Boolean(previous&&previous!==normalized);if(previous)delete state.telegramBindings[previous];person.telegramId=normalized;if(normalized)state.telegramBindings[normalized]=targetUserId;this.touchPerson(person);this.addAudit(state,userId,normalized?'telegram.bound':'telegram.unbound','user',targetUserId,{changed:Boolean(previous&&normalized)},correlationId);});if(revoke)await this.sessionStore.revokeUser(targetUserId,new Date());}
  async adminCreateGuardian(userId:string,input:{firstName:string;lastName:string;telegramId?:string;phone?:string;email?:string;studentIds:string[];status:'active'|'disabled'},correlationId:string):Promise<Record<string,unknown>>{this.requireRole(userId,'admin');const id=randomUUID(),timestamp=nowIso(),telegramId=input.telegramId?this.normalizeTelegramId(input.telegramId):null,email=input.email?normalizeEmail(input.email):null;await this.runtimeStore.mutate(state=>{if(telegramId)this.assertTelegramAvailable(state,telegramId);if(email&&Object.values(state.directory).some(item=>item.email===email))throw new AppError('EMAIL_CONFLICT',409,'Ця електронна адреса вже використовується');for(const studentId of input.studentIds)this.expectPerson(state,studentId,'student');const person=this.newPerson(id,input.firstName,input.lastName,['guardian'],input.status,{telegramId,email,phone:input.phone?.trim()||null},timestamp);state.directory[id]=person;state.userStatus[id]=input.status;if(telegramId)state.telegramBindings[telegramId]=id;for(const studentId of [...new Set(input.studentIds)])state.guardianRelations.push({id:randomUUID(),guardianId:id,studentId,status:'active',createdAt:timestamp,updatedAt:timestamp});this.addAudit(state,userId,'guardian.created','guardian',id,{studentCount:input.studentIds.length,telegramLinked:Boolean(telegramId)},correlationId);});return{id,version:1};}
  async adminUpdateGuardian(userId:string,guardianId:string,input:{firstName?:string;lastName?:string;phone?:string|null;email?:string|null;expectedVersion:number},correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{const person=this.expectPerson(state,guardianId,'guardian');this.assertVersion(person,input.expectedVersion);const normalized=input.email?normalizeEmail(input.email):input.email;if(normalized&&Object.values(state.directory).some(item=>item.id!==guardianId&&item.email===normalized))throw new AppError('EMAIL_CONFLICT',409,'Ця електронна адреса вже використовується');if(input.firstName!==undefined)person.firstName=input.firstName;if(input.lastName!==undefined)person.lastName=input.lastName;if(input.phone!==undefined)person.phone=input.phone?.trim()||null;if(input.email!==undefined)person.email=normalized??null;this.touchPerson(person);this.addAudit(state,userId,'guardian.edited','guardian',guardianId,{},correlationId);});}
  async adminLinkGuardian(userId:string,guardianId:string,studentId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const timestamp=nowIso();await this.runtimeStore.mutate(state=>{this.expectPerson(state,guardianId,'guardian');this.expectPerson(state,studentId,'student');const existing=state.guardianRelations.find(link=>link.guardianId===guardianId&&link.studentId===studentId);if(existing){if(existing.status==='active')throw new AppError('GUARDIAN_LINK_CONFLICT',409,'Зв’язок уже існує');existing.status='active';existing.updatedAt=timestamp;}else state.guardianRelations.push({id:randomUUID(),guardianId,studentId,status:'active',createdAt:timestamp,updatedAt:timestamp});this.addAudit(state,userId,'guardian.relationship_linked','guardian',guardianId,{studentId},correlationId);});}
  async adminUnlinkGuardian(userId:string,guardianId:string,studentId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{const link=state.guardianRelations.find(item=>item.guardianId===guardianId&&item.studentId===studentId&&item.status==='active');if(!link)throw new AppError('GUARDIAN_LINK_NOT_FOUND',404,'Зв’язок не знайдено');link.status='revoked';link.updatedAt=nowIso();this.addAudit(state,userId,'guardian.relationship_unlinked','guardian',guardianId,{studentId},correlationId);});}
  async adminCreateStaff(userId:string,input:{firstName:string;lastName:string;email:string;roles:Array<'teacher'|'mentor'|'admin'>},correlationId:string):Promise<Record<string,unknown>>{this.requireRole(userId,'admin');const id=randomUUID(),timestamp=nowIso(),email=normalizeEmail(input.email),token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex'),expiresAt=new Date(Date.now()+48*60*60*1000).toISOString();await this.runtimeStore.mutate(state=>{if(this.legacyWebEmails.has(email)||Object.values(state.directory).some(item=>item.email===email))throw new AppError('EMAIL_CONFLICT',409,'Ця електронна адреса вже використовується');const roles=[...new Set(input.roles)];if(roles.includes('mentor')&&!roles.includes('teacher'))throw new AppError('ROLE_DEPENDENCY',400,'Роль Mentor потребує ролі Teacher');const person=this.newPerson(id,input.firstName,input.lastName,roles,'pending',{email},timestamp);person.activationTokenHash=tokenHash;person.activationExpiresAt=expiresAt;state.directory[id]=person;state.userStatus[id]='pending';this.addAudit(state,userId,'teacher.created','staff',id,{roles,email,activationExpiresAt:expiresAt},correlationId);});return{id,version:1,activationToken:token,activationExpiresAt:expiresAt};}
  async adminUpdateStaff(userId:string,staffId:string,input:{firstName?:string;lastName?:string;email?:string;roles?:Array<'teacher'|'mentor'|'admin'>;expectedVersion:number},correlationId:string):Promise<void>{const snapshot=await this.runtimeStore.read();this.syncDirectory(snapshot);this.requireRole(userId,'admin');const current=this.expectPerson(snapshot,staffId);const roles=input.roles?[...new Set(input.roles)]:current.roles.filter((role):role is 'teacher'|'mentor'|'admin'=>['teacher','mentor','admin'].includes(role));if(roles.includes('mentor')&&!roles.includes('teacher'))throw new AppError('ROLE_DEPENDENCY',400,'Роль Mentor потребує ролі Teacher');if(current.roles.includes('mentor')&&!roles.includes('mentor')){const bookings=await this.mentoringStore.listBookings(PILOT.mentorId);if(bookings.some(item=>['reserved','confirmed','rescheduled'].includes(item.status)))throw new AppError('MENTOR_HAS_MEETINGS',409,'Спочатку перенесіть або скасуйте активні менторські зустрічі');}if(current.roles.includes('admin')&&!roles.includes('admin')&&this.activeAdminCount(snapshot)<=1)throw new AppError('LAST_ADMIN_REQUIRED',409,'Не можна зняти роль останнього адміністратора');await this.runtimeStore.mutate(state=>{const person=this.expectPerson(state,staffId);this.assertVersion(person,input.expectedVersion);const email=input.email?normalizeEmail(input.email):person.email;if(email&&(this.legacyWebEmails.has(email)&&email!==person.email||Object.values(state.directory).some(item=>item.id!==staffId&&item.email===email)))throw new AppError('EMAIL_CONFLICT',409,'Ця електронна адреса вже використовується');const previousRoles=[...person.roles];if(input.firstName!==undefined)person.firstName=input.firstName;if(input.lastName!==undefined)person.lastName=input.lastName;if(input.email!==undefined)person.email=email;if(input.roles)person.roles=[...new Set([...person.roles.filter(role=>role==='guardian'),...roles])];this.touchPerson(person);this.addAudit(state,userId,'teacher.edited','staff',staffId,{previousRoles,roles:person.roles},correlationId);if(input.roles&&previousRoles.join(',')!==person.roles.join(','))this.addAudit(state,userId,'teacher.roles_changed','staff',staffId,{previousRoles,roles:person.roles},correlationId);});await this.sessionStore.revokeUser(staffId,new Date());}
  async adminResolveParentContactRequest(userId:string,requestId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{const request=state.parentContactRequests.find(item=>item.id===requestId);if(!request)throw new AppError('PARENT_REQUEST_NOT_FOUND',404,'Запит не знайдено');if(request.status==='resolved')return;request.status='resolved';request.resolvedAt=nowIso();this.addAudit(state,userId,'parent_contact_request.resolved','parent_contact_request',requestId,{guardianId:request.guardianId,studentId:request.studentId},correlationId);});}
  async exportRuntimeState(userId:string,correlationId:string):Promise<{state:PilotRuntimeState;namespace:string}>{
    const state=await this.runtimeStore.read();this.syncDirectory(state);this.requireRole(userId,'admin');
    await this.runtimeStore.mutate(next=>{this.addAudit(next,userId,'runtime_state.exported','runtime_state',this.runtimeStore.namespace,{people:Object.keys(state.directory).length},correlationId);});
    return {state,namespace:this.runtimeStore.namespace};
  }

  async recordSecurityEvent(input:{eventType:string;severity:'low'|'medium'|'high'|'critical';actorUserId?:string;targetUserId?:string;metadata?:Record<string,unknown>;correlationId:string}):Promise<void>{const id=randomUUID(),createdAt=nowIso();await this.runtimeStore.mutate(state=>{state.securityEvents.unshift({id,type:input.eventType,severity:input.severity,actorId:input.actorUserId??null,targetId:input.targetUserId??null,metadata:input.metadata??{},correlationId:input.correlationId,createdAt});});}

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

  private loadWebAccounts(raw:string|undefined):void{if(!raw?.trim())return;let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw new Error('WEB_AUTH_ACCOUNTS_JSON must be valid JSON');}if(!Array.isArray(parsed))throw new Error('WEB_AUTH_ACCOUNTS_JSON must be a JSON array');for(const account of parsed){if(!account||typeof account!=='object'||typeof (account as {email?:unknown}).email!=='string')continue;this.legacyWebEmails.add(normalizeEmail((account as {email:string}).email));}}

  private notificationCandidate(recipientUserId:string,type:string,relatedEntityId:string|null,idempotencyKey:string,text:string,now:Date,extra:Partial<NotificationCandidate['safeMetadata']>={}):NotificationCandidate{return{recipientUserId,type,relatedEntityId,scheduledFor:now.toISOString(),idempotencyKey,safeMetadata:{text,...extra}};}

  private telegramForUser(state:PilotRuntimeState,userId:string):string|null{return state.directory[userId]?.telegramId??[...this.identities.entries()].find(([,id])=>id===userId)?.[0].replace('telegram:','')??null;}

  private kyivParts(value:Date):{day:number;hour:number;date:string}{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(value).map(item=>[item.type,item.value]));const days:Record<string,number>={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};return{day:days[parts.weekday!]??0,hour:Number(parts.hour),date:`${parts.year}-${parts.month}-${parts.day}`};}

  private weekKey(localDate:string):string{const end=new Date(`${localDate}T12:00:00Z`),start=new Date(end);start.setUTCDate(end.getUTCDate()-6);return start.toISOString().slice(0,10);}

  private kyivMidnight(localDate:string):number{const utcMidnight=Date.parse(`${localDate}T00:00:00Z`),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(utcMidnight)).map(item=>[item.type,item.value])),localAsUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));return utcMidnight-(localAsUtc-utcMidnight);}

  private weeklyDigestText(state:PilotRuntimeState,studentId:string,weekKey:string):string{const student=this.expectPerson(state,studentId,'student'),endDate=new Date(`${weekKey}T12:00:00Z`);endDate.setUTCDate(endDate.getUTCDate()+7);const start=this.kyivMidnight(weekKey),end=this.kyivMidnight(endDate.toISOString().slice(0,10)),sessions=state.classSessions.filter(item=>{const at=Date.parse(item.startsAt);return at>=start&&at<end&&item.status!=='cancelled';}),attendance=state.attendance.filter(item=>item.studentId===studentId&&sessions.some(session=>session.id===item.sessionId)),homework=state.homework.filter(item=>{const at=Date.parse(item.dueAt??item.publishAt??'');return at>=start&&at<end&&item.status==='published';}),completed=homework.filter(item=>state.submissions.some(submission=>submission.studentId===studentId&&submission.homeworkId===item.id&&submission.status==='completed')).length,reviews=state.submissions.filter(item=>item.studentId===studentId&&item.review&&Date.parse(item.review.reviewedAt)>=start&&Date.parse(item.review.reviewedAt)<end).map(item=>item.review!.score),average=reviews.length?Math.round(reviews.reduce((sum,value)=>sum+value,0)/reviews.length*10)/10:null,project=(state.projects[studentId]??[]).find(item=>item.status==='active')??state.projects[studentId]?.[0],report=state.teacherReports.filter(item=>item.studentId===studentId&&['approved','sent'].includes(item.status)&&item.teacherComment.trim()).sort((a,b)=>Date.parse(b.approvedAt??b.periodEnd)-Date.parse(a.approvedAt??a.periodEnd))[0],comment=report?`\n\n💬 Коментар викладача: ${report.teacherComment.slice(0,700)}`:'';return`📊 Підсумок тижня · ${student.displayName}\n\n✅ Заняття: ${attendance.filter(item=>['present','late'].includes(item.status)).length}/${sessions.length}\n📝 Домашні: ${completed}/${homework.length}\n⭐ Середня оцінка: ${average===null?'—':`${average}/10`}\n🚀 Проєкт: ${project?`етап «${project.stageTitle}»`:'ще не створено'}\n📈 Прогрес курсу: ${this.progressPercent(state,studentId)}%${comment}`;}

  private syncDirectory(state:PilotRuntimeState):void{
    for(const person of Object.values(state.directory)){
      const status=state.userStatus[person.id]??person.status;
      this.users.set(person.id,{id:person.id,displayName:person.displayName,status});
      this.roleSets.set(person.id,[...person.roles]);
      this.roles.set(person.id,this.primaryRole(person.roles));
      if(person.roles.includes('student')){this.studentDisplayNames.set(person.id,PILOT_STUDENTS.find(item=>item.id===person.id)?.displayName??person.firstName??person.displayName);if(!this.conversations.has(person.id))this.conversations.set(person.id,[]);}
    }
  }

  private primaryRole(roles:PilotDirectoryRole[]):'student'|'guardian'|'teacher'|'admin'{
    if(roles.includes('admin'))return'admin';if(roles.includes('teacher')||roles.includes('mentor'))return'teacher';if(roles.includes('guardian'))return'guardian';return'student';
  }

  private activeStudents(state:PilotRuntimeState):PilotDirectoryPerson[]{return Object.values(state.directory).filter(person=>person.roles.includes('student')&&person.status==='active'&&person.groupId===PILOT.groupId);}
  private activeAdminCount(state:PilotRuntimeState):number{return Object.values(state.directory).filter(person=>person.roles.includes('admin')&&person.status==='active').length;}
  private expectPerson(state:PilotRuntimeState,id:string,role?:PilotDirectoryRole):PilotDirectoryPerson{const person=state.directory[id];if(!person||role&&!person.roles.includes(role))throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');return person;}
  private assertVersion(person:PilotDirectoryPerson,expectedVersion:number):void{if(person.version!==expectedVersion)throw new AppError('STALE_UPDATE',409,'Запис уже змінився. Оновіть дані та повторіть дію.');}
  private touchPerson(person:PilotDirectoryPerson):void{person.displayName=[person.firstName,person.lastName].filter(Boolean).join(' ');person.updatedAt=nowIso();person.version+=1;}
  private normalizeTelegramId(value:string):string{const normalized=value.trim();if(!/^\d{5,20}$/.test(normalized))throw new AppError('INVALID_TELEGRAM_ID',400,'Telegram ID має містити від 5 до 20 цифр');return normalized;}
  private assertTelegramAvailable(state:PilotRuntimeState,telegramId:string,currentUserId?:string):void{const owner=state.telegramBindings[telegramId]??this.identities.get(`telegram:${telegramId}`);if(owner&&owner!==currentUserId)throw new AppError('TELEGRAM_ID_CONFLICT',409,'Цей Telegram ID уже прив’язаний до іншого користувача');}
  private newPerson(id:string,firstName:string,lastName:string,roles:PilotDirectoryRole[],status:AuthUser['status'],extra:Partial<Pick<PilotDirectoryPerson,'groupId'|'email'|'phone'|'telegramId'>>,timestamp:string):PilotDirectoryPerson{return{id,firstName:firstName.trim(),lastName:lastName.trim(),displayName:[firstName.trim(),lastName.trim()].filter(Boolean).join(' '),roles:[...roles],status,groupId:extra.groupId??null,email:extra.email??null,phone:extra.phone??null,telegramId:extra.telegramId??null,passwordHash:null,activationTokenHash:null,activationExpiresAt:null,createdAt:timestamp,updatedAt:timestamp,version:1};}

  private requireGuardianStudent(state:PilotRuntimeState,guardianId:string,studentId:string):void{this.syncDirectory(state);this.requireRole(guardianId,'guardian');const guardian=state.directory[guardianId],student=state.directory[studentId];if(!guardian||guardian.status!=='active'||!student||student.status==='archived'||!state.guardianRelations.some(link=>link.guardianId===guardianId&&link.studentId===studentId&&link.status==='active'))throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');}

  private async parentSummary(state:PilotRuntimeState,studentId:string):Promise<ParentSummaryDto>{
    const student=this.expectPerson(state,studentId,'student');const progress=this.progressPercent(state,studentId);const completedLessons=Object.values(state.lessonProgress[studentId]??{}).filter(item=>item.progressPercent===100).length;const attempts=state.submissions.filter(item=>item.studentId===studentId);const latestByHomework=new Map<string,PilotRuntimeState['submissions'][number]>();for(const attempt of attempts){const current=latestByHomework.get(attempt.homeworkId);if(!current||attempt.attemptNumber>current.attemptNumber)latestByHomework.set(attempt.homeworkId,attempt);}const published=state.homework.filter(item=>item.status==='published');const now=Date.now();const attendance=state.attendance.filter(item=>item.studentId===studentId);const project=(state.projects[studentId]??[]).find(item=>item.status==='active')??state.projects[studentId]?.[0]??null;const nextClass=state.classSessions.filter(item=>Date.parse(item.endsAt)>=now&&!['cancelled','completed'].includes(item.status)).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0]??null;const bookings=(await this.mentoringStore.listBookings(PILOT.mentorId)).filter(item=>item.studentId===studentId&&['reserved','confirmed','rescheduled'].includes(item.status)&&Date.parse(item.endsAt)>=now).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt)),lastAbsence=attendance.filter(item=>item.status==='absent').sort((a,b)=>Date.parse(b.confirmedAt)-Date.parse(a.confirmedAt))[0],missedSession=lastAbsence?state.classSessions.find(item=>item.id===lastAbsence.sessionId):undefined,portfolioId=PILOT_PORTFOLIO_IDS[studentId]??`portfolio:${studentId}`,projectShared=project&&state.portfolioProjects[studentId]?.some(item=>item.projectId===project.id)&&['shareable','public'].includes(state.portfolioVisibility[portfolioId]??'private'),viewUrl=projectShared&&project.workspaceUrl?.startsWith('https://')?project.workspaceUrl:null;return{student:{id:student.id,name:student.displayName,groupName:PILOT.groupName},nextClass:nextClass?{id:nextClass.id,title:nextClass.title,startsAt:nextClass.startsAt,endsAt:nextClass.endsAt}:null,progress:{percent:progress,completedLessons,totalLessons:SEEDED_LESSONS.length},homework:{completed:[...latestByHomework.values()].filter(item=>item.status==='completed').length,pending:published.filter(item=>!['completed'].includes(latestByHomework.get(item.id)?.status??'')).filter(item=>!item.dueAt||Date.parse(item.dueAt)>=now).length,overdue:published.filter(item=>item.dueAt&&Date.parse(item.dueAt)<now&&!['completed'].includes(latestByHomework.get(item.id)?.status??'')).length},attendance:{attended:attendance.filter(item=>['present','late'].includes(item.status)).length,missed:attendance.filter(item=>item.status==='absent').length,late:attendance.filter(item=>item.status==='late').length,excused:attendance.filter(item=>item.status==='excused').length},grades:attempts.filter(item=>item.review).sort((a,b)=>Date.parse(b.review!.reviewedAt)-Date.parse(a.review!.reviewedAt)).slice(0,5).map(item=>({homeworkTitle:state.homework.find(homework=>homework.id===item.homeworkId)?.title??'Домашнє завдання',score:item.review!.score,feedback:item.review!.feedback,reviewedAt:item.review!.reviewedAt})),project:project?{id:project.id,title:project.title,description:project.summary,status:project.status,stage:project.stageTitle,progressPercent:project.tasks.filter(item=>item.status==='completed').reduce((sum,item)=>sum+item.weight,0),completedTasks:project.tasks.filter(item=>item.status==='completed').map(item=>item.title),nextTask:project.tasks.find(item=>['available','in_progress'].includes(item.status))?.title??null,updatedAt:project.updatedAt,viewUrl}:null,mentoring:bookings[0]?{startsAt:bookings[0].startsAt,endsAt:bookings[0].endsAt,status:bookings[0].status}:null,recovery:missedSession?{sessionId:missedSession.id,title:missedSession.title,startsAt:missedSession.startsAt,materialsAvailable:missedSession.materials.length>0||state.homework.some(item=>item.classSessionId===missedSession.id)}:null};
  }

  private requireUser(userId: string): AuthUser {
    const user = this.users.get(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 404, 'Користувача не знайдено');
    return user;
  }

  private requireRole(userId:string,role:'student'|'guardian'|'teacher'|'admin'):void{this.requireUser(userId);const roles=this.roleSets.get(userId)??[];if(!roles.includes(role)&&!roles.includes('admin'))throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав');}

  private requireMentor(userId:string):void{this.requireRole(userId,'teacher');if(!(this.roleSets.get(userId)??[]).includes('mentor'))throw new AppError('MENTOR_FORBIDDEN',403,'Менторські вікна недоступні');}

  private async viewer(userId: string) {
    const user = this.requireUser(userId);
    const state=await this.runtimeStore.read();const xp = state.xp[userId] ?? 0;
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
      streak: state.streak[userId] ?? 0
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

  private findConversation(userId: string, conversationId: string): InternalConversation | undefined {
    this.requireUser(userId);
    return this.conversations.get(userId)?.find(conversation => conversation.id === conversationId);
  }

  private classSessionDto(item:PilotRuntimeState['classSessions'][number]):ClassSessionDto {
    const {groupId:_groupId,groupName:_groupName,lessonId:_lessonId,teacherNotes:_teacherNotes,...dto}=item;
    return structuredClone(dto);
  }

  private submissionDto(item:PilotRuntimeState['submissions'][number]):HomeworkSubmissionDto {
    const {studentId:_studentId,homeworkId:_homeworkId,...dto}=item;
    return structuredClone(dto);
  }

  private progressPercent(state:PilotRuntimeState,userId:string):number {
    const progress=state.lessonProgress[userId]??{};
    return Math.round(SEEDED_LESSONS.reduce((sum,lesson)=>sum+(progress[lesson.id]?.progressPercent??0),0)/SEEDED_LESSONS.length);
  }

  private portfolioFromState(state:PilotRuntimeState,userId:string):PortfolioDto {
    const id=PILOT_PORTFOLIO_IDS[userId]??`portfolio:${userId}`;
    return{id,title:'Моє портфоліо',visibility:state.portfolioVisibility[id]==='private'?'private':'shared',projects:structuredClone(state.portfolioProjects[userId]??[]),skills:[{code:'ai',title:'AI',level:3},{code:'critical-thinking',title:'Критичне мислення',level:2},{code:'product-thinking',title:'Продуктове мислення',level:2},{code:'presentation',title:'Презентація',level:1}]};
  }

  private async nextMentorMeeting(userId:string):Promise<string|null>{
    const bookings=await this.mentoringStore.listBookings(PILOT.mentorId);const now=Date.now();
    return bookings.filter(item=>item.studentId===userId&&['reserved','confirmed','rescheduled'].includes(item.status)&&Date.parse(item.startsAt)>=now).sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0]?.startsAt??null;
  }

  private addAudit(state:PilotRuntimeState,actorId:string,action:string,targetType:string,targetId:string,metadata:Record<string,unknown>,correlationId:string):void{
    state.adminAuditEvents.unshift({id:randomUUID(),actorId,actor:this.users.get(actorId)?.displayName,action,targetType,targetId,metadata,correlationId,createdAt:nowIso()});
  }
}
