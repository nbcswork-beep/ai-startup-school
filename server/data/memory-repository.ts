import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/app-error.js';
import { MemorySessionStore, type SessionStore } from '../auth/session-store.js';
import type { AppRepository } from './repository.js';
import { MemoryMentoringStore, type MentoringStore, type StoredMentorBooking } from './mentoring-store.js';
import { DEV_IDS, PILOT, PILOT_STUDENTS, PILOT_TEACHERS, SEEDED_LESSONS } from './seed.js';
import { MemoryPilotRuntimeStore, PILOT_PORTFOLIO_IDS, type PilotProject, type PilotRuntimeState, type PilotRuntimeStore } from './pilot-runtime-store.js';
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
  RotationResult,
  TelegramIdentityInput
} from '../types/domain.js';

type InternalProject = PilotProject;
type InternalConversation = AiConversationDto & { summary: string; messages: AiMessageDto[]; clientMessageIds: Set<string> };

export interface MemoryRepositoryOptions {
  telegramBindingsJson?: string | undefined;
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
  private studentDisplayNames = new Map<string, string>(PILOT_STUDENTS.map(student => [student.id, student.displayName]));
  private identities = new Map<string, string>();
  private readonly sessionStore: SessionStore;
  private readonly mentoringStore: MentoringStore;
  private readonly runtimeStore: PilotRuntimeStore;
  private conversations = new Map<string, InternalConversation[]>();
  private guardianLinks = new Map<string,'active'|'revoked'>([['92000000-0000-4000-8000-000000000001','active']]);
  private adminNotifications: Array<Record<string,unknown>> = [];
  private readonly requireSeededTelegramIdentity: boolean;

  constructor(private readonly workspaceUrl?: string, options: MemoryRepositoryOptions = {}) {
    this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    this.mentoringStore = options.mentoringStore ?? new MemoryMentoringStore();
    this.runtimeStore = options.runtimeStore ?? new MemoryPilotRuntimeStore();
    this.requireSeededTelegramIdentity = options.requireSeededTelegramIdentity ?? false;
    for (const student of PILOT_STUDENTS) {
      this.conversations.set(student.id, []);
    }
    this.loadTelegramBindings(options.telegramBindingsJson);
  }

  async ping(): Promise<void> {}

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const key = `telegram:${identity.telegramId}`;
    const existingId = this.identities.get(key);
    if (existingId) {
      const existing=await this.getAuthUser(existingId);
      if(existing)return existing;
    }
    if (this.requireSeededTelegramIdentity) {
      throw new AppError('TELEGRAM_ACCOUNT_NOT_LINKED', 403, 'Telegram-акаунт ще не прив’язано до профілю учня');
    }
    const user: AuthUser = { id: randomUUID(), displayName: identity.firstName.slice(0, 60) || 'Учень', status: 'active' };
    this.users.set(user.id, user);
    this.roles.set(user.id, 'student');
    this.identities.set(key, user.id);
    this.conversations.set(user.id, []);
    this.studentDisplayNames.set(user.id, user.displayName);
    await this.runtimeStore.mutate(state => {
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
    const user = this.users.get(userId);
    if (!user) return null;
    const state = await this.runtimeStore.read();
    return { ...structuredClone(user), status: state.userStatus[userId] ?? 'disabled' };
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
    const user = await this.getAuthUser(result.session.userId);
    if (!user) return { status: 'invalid' };
    return { status: 'ok', user, session: result.session };
  }

  async revokeSession(refreshTokenHash: string, now: Date): Promise<boolean> {
    return this.sessionStore.revokeFamily(refreshTokenHash, now);
  }

  async getAccessContext(userId:string,sessionId:string):Promise<AccessContext>{
    const user=await this.getAuthUser(userId);
    return{role:this.roles.get(userId)??'student',status:user?.status??'disabled',sessionActive:await this.sessionStore.isActive(userId,sessionId,new Date())};
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
      stagePosition: 1, stageCode: 'idea', stageTitle: 'Ідея', tags: ['AI'], workspaceUrl: this.workspaceUrl ?? null,
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
    const project=await this.runtimeStore.mutate(state=>{const item=state.projects[userId]?.find(project=>project.id===projectId);if(!item)return null;if(input.title!==undefined)item.title=input.title;if(input.summary!==undefined)item.summary=input.summary;return item;});
    return project?this.projectDto(project):null;
  }

  async completeProjectTask(userId: string, projectId: string, taskId: string, idempotencyKey: string): Promise<{ awardedXp: number; project: ProjectDto } | null> {
    this.requireUser(userId);const rewardKey=`project-task:${userId}:${taskId}:${idempotencyKey}`;
    const result=await this.runtimeStore.mutate(state=>{const project=state.projects[userId]?.find(item=>item.id===projectId);if(!project)return null;const taskIndex=project.tasks.findIndex(item=>item.id===taskId),task=project.tasks[taskIndex];if(!task)return null;if(task.status==='locked')throw new AppError('TASK_LOCKED',403,'Це завдання ще не відкрито');let awardedXp=0;if(task.status!=='completed'&&!state.idempotencyKeys.includes(rewardKey)){task.status='completed';state.idempotencyKeys.push(rewardKey);state.xp[userId]=(state.xp[userId]??0)+task.xpReward;state.streak[userId]=Math.max(1,state.streak[userId]??0);awardedXp=task.xpReward;const next=project.tasks[taskIndex+1];if(next)next.status='in_progress';else project.status='completed';const completed=project.tasks.filter(item=>item.status==='completed').length;project.stagePosition=Math.min(STAGES.length,Math.max(1,completed+1));const stage=STAGES[project.stagePosition-1];if(stage){project.stageCode=stage.code;project.stageTitle=stage.title;}if(completed>=2){const achievements=state.achievements[userId]??(state.achievements[userId]=[]);if(!achievements.includes('builder'))achievements.push('builder');}}return{awardedXp,project};});
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
    this.requireRole(userId, 'teacher');
    const state=await this.runtimeStore.read();const next=state.classSessions.filter(item=>Date.parse(item.endsAt)>=Date.now()&&item.status!=='cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0];
    return [{ id:PILOT.groupId,name:PILOT.groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:PILOT_STUDENTS.length,nextClassAt:next?.startsAt??null }];
  }

  async listGroupStudents(userId: string, groupId: string): Promise<TeacherStudentDto[]> {
    this.requireRole(userId,'teacher');
    if(groupId!==PILOT.groupId) throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    const state=await this.runtimeStore.read();
    return PILOT_STUDENTS.map(student=>({id:student.id,firstName:student.fullName,progressPercent:this.progressPercent(state,student.id),projectTitle:state.projects[student.id]?.find(item=>item.status==='active')?.title??null}));
  }

  async createClassSession(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;title:string;description?:string;startsAt:string;endsAt:string;meetingUrl?:string;meetingProvider?:string}):Promise<ClassSessionDto>{
    this.requireRole(userId,'teacher'); if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');
    if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');const id=randomUUID();
    const created={id,groupId:input.groupId,groupName:PILOT.groupName,lessonId:input.lessonId??null,title:input.title,description:input.description??'',startsAt:input.startsAt,endsAt:input.endsAt,durationMinutes:Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000),status:'scheduled' as const,meetingProvider:input.meetingProvider??null,meetingUrl:input.meetingUrl??null,courseTitle:PILOT.courseTitle,moduleTitle:PILOT.moduleTitle,lessonTitle:input.lessonId?SEEDED_LESSONS.find(item=>item.id===input.lessonId)?.title??null:null,teacherName:this.requireUser(userId).displayName,teacherNotes:'',materials:[]};
    await this.runtimeStore.mutate(state=>{state.classSessions.push(created);});return this.classSessionDto(created);
  }
  async rescheduleClass(userId:string,sessionId:string,input:{startsAt:string;endsAt:string;reason?:string}):Promise<void>{this.requireRole(userId,'teacher');if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний час заняття');await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');item.startsAt=input.startsAt;item.endsAt=input.endsAt;item.durationMinutes=Math.round((Date.parse(input.endsAt)-Date.parse(input.startsAt))/60000);item.status='rescheduled';});}
  async confirmAttendance(userId:string,sessionId:string,studentId:string,status:'present'|'late'|'absent'|'excused',note?:string):Promise<void>{this.requireRole(userId,'teacher');if(!PILOT_STUDENTS.some(student=>student.id===studentId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const id=randomUUID(),confirmedAt=nowIso();await this.runtimeStore.mutate(state=>{if(!state.classSessions.some(item=>item.id===sessionId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const record=state.attendance.find(item=>item.sessionId===sessionId&&item.studentId===studentId);if(record){record.status=status;record.note=note??'';record.confirmedAt=confirmedAt;}else state.attendance.push({id,sessionId,studentId,status,note:note??'',confirmedAt});});}
  async createHomework(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;classSessionId?:string;title:string;instructions:string;publishAt?:string;dueAt?:string;xpReward:number;status:'draft'|'published';resources?:Array<{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}>}):Promise<HomeworkSummaryDto>{this.requireRole(userId,'teacher');if(input.groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');if(input.resources?.some(resource=>!resource.url.startsWith('https://')))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const id=randomUUID(),resources=(input.resources??[]).map(resource=>({id:randomUUID(),...resource}));await this.runtimeStore.mutate(state=>{state.homework.unshift({id,groupId:input.groupId,groupName:PILOT.groupName,classSessionId:input.classSessionId??null,title:input.title,instructions:input.instructions,publishAt:input.publishAt??null,dueAt:input.dueAt??null,xpReward:input.xpReward,status:input.status,submissionCount:0,reviewCount:0,needsRevisionCount:0,resources});});return{id,title:input.title,instructions:input.instructions,publishedAt:input.publishAt??'',dueAt:input.dueAt??null,xpReward:input.xpReward,classTitle:null,state:'not_started',latestSubmission:null};}
  async reviewHomework(userId:string,submissionId:string,input:{score:number;effort:EffortLevel;status:'reviewed'|'needs_revision'|'completed';feedback:string}):Promise<void>{this.requireRole(userId,'teacher');if(input.score<0||input.score>10||!Number.isInteger(input.score))throw new AppError('INVALID_SCORE',400,'Оцінка має бути цілим числом від 0 до 10');const reviewedAt=nowIso();await this.runtimeStore.mutate(state=>{const submission=state.submissions.find(item=>item.id===submissionId);if(!submission)throw new AppError('SUBMISSION_FORBIDDEN',403,'Робота недоступна');submission.status=input.status==='needs_revision'?'needs_revision':input.status==='completed'?'completed':submission.status;submission.review={score:input.score,effort:input.effort,status:input.status,feedback:input.feedback,reviewedAt};});}

  async getTeacherWorkspace(userId:string):Promise<TeacherWorkspaceDto>{
    this.requireRole(userId,'teacher');
    const state=await this.runtimeStore.read();
    const [mentorAvailability, mentorBookings] = await Promise.all([
      this.mentoringStore.listAvailability(PILOT.mentorId),
      this.mentoringStore.listBookings(PILOT.mentorId)
    ]);
    const activeMentorBookings = mentorBookings.filter(item => ['reserved', 'confirmed', 'rescheduled'].includes(item.status));
    const groupId=PILOT.groupId; const groupName=PILOT.groupName;
    const groupStudents=PILOT_STUDENTS.map(student=>({id:student.id,firstName:student.fullName,progressPercent:this.progressPercent(state,student.id),projectTitle:state.projects[student.id]?.find(item=>item.status==='active')?.title??null}));
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
    const teacher=PILOT_TEACHERS.find(item=>item.id===userId)??PILOT_TEACHERS[0];
    const teacherAvailability = mentorAvailability.map(item => ({...item,status:activeMentorBookings.some(booking => booking.availabilityId === item.id || (Date.parse(booking.startsAt)<Date.parse(item.endsAt)&&Date.parse(booking.endsAt)>Date.parse(item.startsAt)))?'booked' as const:item.status}));
    const homework=state.homework.map(item=>({...item,submissionCount:state.submissions.filter(value=>value.homeworkId===item.id).length,reviewCount:state.submissions.filter(value=>value.homeworkId===item.id&&Boolean(value.review)).length,needsRevisionCount:state.submissions.filter(value=>value.homeworkId===item.id&&value.status==='needs_revision').length}));const nextClass=allSessions.filter(item=>Date.parse(item.endsAt)>=Date.now()&&item.status!=='cancelled').sort((a,b)=>Date.parse(a.startsAt)-Date.parse(b.startsAt))[0];const attendanceCount=state.attendance.length,attendancePresent=state.attendance.filter(item=>item.status==='present'||item.status==='late').length;
    return{teacher:{id:userId,name:teacher.fullName,title:teacher.title,timezone:PILOT.timezone},metrics:{todayClasses:allSessions.filter(item=>item.startsAt.slice(0,10)===todayKey).length,awaitingReview:submissions.filter(item=>item.status==='submitted'&&!item.review).length,resubmitted:submissions.filter(item=>item.attemptNumber>1&&item.status==='submitted').length,mentorToday:mentorBookings.filter(item=>item.startsAt.slice(0,10)===todayKey).length,reportsPending:state.teacherReports.filter(item=>['draft','ready_for_review'].includes(item.status)).length},groups:[{id:groupId,courseId:DEV_IDS.course,name:groupName,courseTitle:PILOT.courseTitle,timezone:PILOT.timezone,studentCount:groupStudents.length,nextClassAt:nextClass?.startsAt??null,scheduleLabel:'8 занять · розклад уточнюється',progressPercent:Math.round(groupStudents.reduce((sum,item)=>sum+item.progressPercent,0)/groupStudents.length),attendanceRate:attendanceCount?Math.round(attendancePresent/attendanceCount*100):0,recentHomework:homework[0]?.title??null}],sessions:allSessions,homework,submissions,students,mentor:{mentorId:teacher.mentor?PILOT.mentorId:null,availability:teacher.mentor?teacherAvailability:[],bookings:teacher.mentor?mentorBookings:[]},reports:structuredClone(state.teacherReports),lessons:SEEDED_LESSONS.map(lesson=>({id:lesson.id,title:lesson.title,moduleTitle:PILOT.moduleTitle})),attention};
  }

  async searchTeacherScope(userId:string,query:string):Promise<TeacherSearchDto>{const data=await this.getTeacherWorkspace(userId);const term=query.trim().toLocaleLowerCase('uk');const includes=(value:string)=>value.toLocaleLowerCase('uk').includes(term);return{students:data.students.filter(item=>includes(item.firstName)).map(item=>({id:item.id,label:item.firstName,meta:item.groupName})),groups:data.groups.filter(item=>includes(item.name)||includes(item.courseTitle)).map(item=>({id:item.id,label:item.name,meta:item.courseTitle})),homework:data.homework.filter(item=>includes(item.title)).map(item=>({id:item.id,label:item.title,meta:item.groupName})),projects:data.students.flatMap(student=>student.projects.filter(project=>includes(project.title)).map(project=>({id:project.id,label:project.title,meta:student.firstName})))}};

  async updateTeacherClass(userId:string,sessionId:string,input:{title?:string;description?:string;lessonId?:string|null;meetingUrl?:string|null;meetingProvider?:string|null;teacherNotes?:string;status?:'scheduled'|'in_progress'|'completed'|'cancelled'}):Promise<void>{this.requireRole(userId,'teacher');if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');if(input.title!==undefined)item.title=input.title;if(input.description!==undefined)item.description=input.description;if(input.lessonId!==undefined){item.lessonId=input.lessonId;item.lessonTitle=input.lessonId?SEEDED_LESSONS.find(value=>value.id===input.lessonId)?.title??null:null;}if(input.meetingUrl!==undefined)item.meetingUrl=input.meetingUrl;if(input.meetingProvider!==undefined)item.meetingProvider=input.meetingProvider;if(input.teacherNotes!==undefined)item.teacherNotes=input.teacherNotes;if(input.status!==undefined)item.status=input.status;});}
  async addClassMaterial(userId:string,sessionId:string,input:{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}):Promise<void>{this.requireRole(userId,'teacher');if(!input.url.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');const id=randomUUID();await this.runtimeStore.mutate(state=>{const item=state.classSessions.find(value=>value.id===sessionId);if(!item)throw new AppError('CLASS_FORBIDDEN',403,'Заняття недоступне');item.materials.push({id,kind:input.kind,title:input.title,url:input.url});});}
  async bulkConfirmAttendance(userId:string,sessionId:string,entries:Array<{studentId:string;status:'present'|'late'|'absent'|'excused';note?:string}>):Promise<void>{this.requireRole(userId,'teacher');if(!entries.length)throw new AppError('ATTENDANCE_EMPTY',400,'Додайте учнів');if(entries.some(entry=>!PILOT_STUDENTS.some(student=>student.id===entry.studentId)))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');const confirmedAt=nowIso(),ids=entries.map(()=>randomUUID());await this.runtimeStore.mutate(state=>{if(!state.classSessions.some(item=>item.id===sessionId))throw new AppError('ATTENDANCE_FORBIDDEN',403,'Учень або заняття недоступні');entries.forEach((entry,index)=>{const record=state.attendance.find(item=>item.sessionId===sessionId&&item.studentId===entry.studentId);if(record){record.status=entry.status;record.note=entry.note??'';record.confirmedAt=confirmedAt;}else state.attendance.push({id:ids[index]!,sessionId,studentId:entry.studentId,status:entry.status,note:entry.note??'',confirmedAt});});});}
  async publishHomework(userId:string,homeworkId:string,publishAt:string):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const homework=state.homework.find(item=>item.id===homeworkId);if(!homework)throw new AppError('HOMEWORK_FORBIDDEN',403,'Домашня робота недоступна');if(homework.status!=='draft')throw new AppError('HOMEWORK_STATE',409,'Опублікувати можна лише чернетку');if(homework.dueAt&&Date.parse(homework.dueAt)<=Date.parse(publishAt))throw new AppError('INVALID_TIME',400,'Дедлайн має бути після публікації');homework.status='published';homework.publishAt=publishAt;});}
  async createTeacherNote(userId:string,studentId:string,input:{category:'general'|'learning'|'project'|'mentoring';content:string}):Promise<TeacherPrivateNoteDto>{this.requireRole(userId,'teacher');if(!PILOT_STUDENTS.some(student=>student.id===studentId))throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');const timestamp=nowIso(),note={id:randomUUID(),studentId,category:input.category,content:input.content,createdAt:timestamp,updatedAt:timestamp};await this.runtimeStore.mutate(state=>{state.teacherNotes.unshift(note);});return structuredClone(note);}
  async updatePortfolioItemAsTeacher(userId:string,portfolioProjectId:string,input:{title?:string|null;shortDescription?:string;reflection?:string;learned?:string}):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const item=Object.values(state.portfolioProjects).flat().find(project=>project.id===portfolioProjectId);if(!item)throw new AppError('PORTFOLIO_FORBIDDEN',403,'Елемент портфоліо недоступний');if(input.title)item.title=input.title;if(input.shortDescription!==undefined)item.shortDescription=input.shortDescription;if(input.reflection!==undefined)item.reflection=input.reflection;if(input.learned!==undefined)item.learned=input.learned;});}
  async createMentorAvailability(userId:string,input:{startsAt:string;endsAt:string;timezone:string;status:'open'|'blocked'}):Promise<void>{this.requireMentor(userId);if(Date.parse(input.endsAt)<=Date.parse(input.startsAt))throw new AppError('INVALID_TIME',400,'Некоректний часовий інтервал');const result=await this.mentoringStore.createAvailability({id:randomUUID(),mentorId:PILOT.mentorId,...input});if(result==='conflict')throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час перетинається з іншим вікном або зустріччю');}
  async updateMentorBooking(userId:string,bookingId:string,input:{status:'confirmed'|'completed'|'cancelled'|'rescheduled'|'no_show';meetingUrl?:string|null;startsAt?:string;endsAt?:string}):Promise<void>{this.requireMentor(userId);if(input.meetingUrl&&!input.meetingUrl.startsWith('https://'))throw new AppError('UNSAFE_URL',400,'Дозволено лише HTTPS-посилання');if(input.status==='rescheduled'&&(!input.startsAt||!input.endsAt||Date.parse(input.endsAt)<=Date.parse(input.startsAt)))throw new AppError('INVALID_TIME',400,'Для переносу потрібен новий час');const bookings=await this.mentoringStore.listBookings(PILOT.mentorId);const booking=bookings.find(item=>item.id===bookingId);if(!booking)throw new AppError('BOOKING_FORBIDDEN',403,'Бронювання недоступне');const result=await this.mentoringStore.updateBooking(PILOT.mentorId,bookingId,{status:input.status,meetingUrl:input.meetingUrl!==undefined?input.meetingUrl:booking.meetingUrl,startsAt:input.startsAt??booking.startsAt,endsAt:input.endsAt??booking.endsAt});if(result==='not_found')throw new AppError('BOOKING_FORBIDDEN',403,'Бронювання недоступне');if(result==='conflict')throw new AppError('MENTOR_SLOT_CONFLICT',409,'Цей час зайнятий іншою зустріччю');}
  async generateTeacherReports(userId:string,groupId:string,periodStart:string,periodEnd:string):Promise<void>{this.requireRole(userId,'teacher');if(groupId!==PILOT.groupId)throw new AppError('GROUP_FORBIDDEN',403,'Група недоступна');const ids=Object.fromEntries(PILOT_STUDENTS.map(item=>[item.id,randomUUID()]));await this.runtimeStore.mutate(state=>{for(const student of PILOT_STUDENTS){if(state.teacherReports.some(report=>report.studentId===student.id&&report.periodStart===periodStart&&report.periodEnd===periodEnd))continue;state.teacherReports.push({id:ids[student.id]!,studentId:student.id,studentFirstName:student.fullName,groupId,groupName:PILOT.groupName,periodStart,periodEnd,payload:{classesScheduled:state.classSessions.length,classesAttended:state.attendance.filter(item=>item.studentId===student.id&&['present','late'].includes(item.status)).length,homeworkSubmitted:state.submissions.filter(item=>item.studentId===student.id).length,project:state.projects[student.id]?.find(item=>item.status==='active')?.title??null,projectProgress:this.progressPercent(state,student.id),xpEarned:state.xp[student.id]??0},teacherComment:'',status:'draft',approvedAt:null});}});}
  async saveTeacherReport(userId:string,reportId:string,input:{teacherComment:string;status:'draft'|'ready_for_review'}):Promise<void>{this.requireRole(userId,'teacher');await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');report.teacherComment=input.teacherComment;report.status=input.status;});}
  async approveTeacherReport(userId:string,reportId:string):Promise<void>{this.requireRole(userId,'teacher');const approvedAt=nowIso();await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);if(!report)throw new AppError('REPORT_FORBIDDEN',403,'Звіт недоступний');if(report.status!=='ready_for_review'||!report.teacherComment.trim())throw new AppError('REPORT_NOT_READY',409,'Звіт ще не готовий до підтвердження');report.status='approved';report.approvedAt=approvedAt;});}
  async listLinkedStudents(userId:string):Promise<TeacherStudentDto[]>{this.requireRole(userId,'guardian');return[{id:DEV_IDS.user,firstName:PILOT_STUDENTS[0].fullName,progressPercent:0,projectTitle:null}];}
  async listParentReports(userId:string,studentId:string):Promise<ParentReportDto[]>{this.requireRole(userId,'guardian');if(studentId!==DEV_IDS.user)throw new AppError('STUDENT_FORBIDDEN',403,'Учень недоступний');const state=await this.runtimeStore.read();return structuredClone(state.teacherReports.filter(report=>report.studentId===studentId&&['approved','sent'].includes(report.status)).map(report=>({id:report.id,studentId:report.studentId,studentFirstName:PILOT_STUDENTS[0].fullName,periodStart:report.periodStart,periodEnd:report.periodEnd,payload:report.payload,teacherComment:report.teacherComment,status:report.status})));}

  async getAdminWorkspace(userId:string):Promise<AdminWorkspaceDto>{
    this.requireRole(userId,'admin');const [teacher,state]=await Promise.all([this.getTeacherWorkspace(userId),this.runtimeStore.read()]);const now=Date.now();
    const students=teacher.students.map(student=>({id:student.id,name:student.firstName,status:state.userStatus[student.id]??'disabled',group:student.groupName,course:student.courseTitle,progress:student.progressPercent,xp:student.xp,level:student.level,streak:state.streak[student.id]??0,attendance:student.attendance,homework:student.homework,project:student.projectTitle,guardianLinked:false,telegramLinked:[...this.identities.values()].includes(student.id)}));
    const teachers=PILOT_TEACHERS.map(item=>({id:item.id,name:item.fullName,status:state.userStatus[item.id]??'disabled',groups:1,upcomingClasses:teacher.sessions.filter(session=>Date.parse(session.startsAt)>now&&session.status!=='cancelled').length,classesTaught:teacher.sessions.filter(session=>session.status==='completed').length,reviews:teacher.submissions.filter(submission=>submission.review).length,mentor:item.mentor}));
    const guardians:Array<Record<string,unknown>>=[];
    const sessions=teacher.sessions.map(item=>({id:item.id,title:item.title,group:item.groupName,teacher:item.teacherName,lesson:item.lessonTitle,startsAt:item.startsAt,durationMinutes:item.durationMinutes,status:item.status,meetingProvider:item.meetingProvider,meetingUrl:item.meetingUrl,attendanceComplete:item.attendance.every(entry=>entry.status)}));
    const homework=teacher.homework.map(item=>({id:item.id,title:item.title,group:item.groupName,status:item.status,dueAt:item.dueAt,submissions:item.submissionCount,reviews:item.reviewCount,revisions:item.needsRevisionCount}));
    const projects=teacher.students.flatMap(student=>student.projects.map(project=>({id:project.id,studentId:student.id,student:student.firstName,title:project.title,stage:project.stage.title,progress:project.completionPercent,technologies:project.tags,status:project.status})));
    const portfolios=teacher.students.map(student=>({id:student.portfolio?.id??`portfolio:${student.id}`,studentId:student.id,student:student.firstName,title:student.portfolio?.title??'Портфоліо',visibility:student.portfolio?.id?state.portfolioVisibility[student.portfolio.id]??student.portfolio.visibility:'private',items:student.portfolio?.projects.length??0}));
    const activeSessions=(await this.sessionStore.listActive(new Date(now))).map(item=>({id:item.id,userId:item.userId,user:this.users.get(item.userId)?.displayName??'Користувач',role:this.roles.get(item.userId),provider:item.provider,createdAt:item.createdAt.toISOString(),expiresAt:item.expiresAt.toISOString(),status:'active'}));
    const reports=teacher.reports.map(item=>({...item,guardianRelationshipActive:this.guardianLinks.get('92000000-0000-4000-8000-000000000001')==='active'}));
    return{admin:{id:userId,name:this.requireUser(userId).displayName,role:'admin',mfaRequired:true},metrics:{activeStudents:students.filter(item=>item.status==='active').length,activeGroups:teacher.groups.length,teachers:teachers.length,upcomingClasses:sessions.filter(item=>Date.parse(String(item.startsAt))>now&&!['cancelled','completed'].includes(String(item.status))).length,classesToday:sessions.filter(item=>String(item.startsAt).slice(0,10)===new Date().toISOString().slice(0,10)).length,awaitingReview:teacher.metrics.awaitingReview,needsRevision:teacher.homework.reduce((sum,item)=>sum+item.needsRevisionCount,0),mentorBookings:teacher.mentor.bookings.length,attendanceIssues:teacher.students.reduce((sum,item)=>sum+item.attendance.absent+item.attendance.late,0),reportsAwaiting:reports.filter(item=>item.status==='ready_for_review').length,recentProjects:projects.length,portfolioMilestones:portfolios.reduce((sum,item)=>sum+Number(item.items),0)},students,teachers,guardians,groups:teacher.groups.map(item=>({...item})),sessions,homework,projects,portfolios,mentorBookings:teacher.mentor.bookings.map(item=>({...item})),reports,notifications:structuredClone(this.adminNotifications),activeSessions,auditEvents:structuredClone(state.adminAuditEvents),securityEvents:structuredClone(state.securityEvents),health:{productionMode:{status:'warning',label:'Перевіряється з server environment'},database:{status:'ok',label:'Repository доступний'},rls:{status:'warning',label:'Потребує integration test'},telegram:{status:'warning',label:'Статус без розкриття секрету'},storage:{status:'required',label:'Приватне сховище потребує конфігурації'},signingKeys:{status:'ok',label:'JWT signer завантажений'},devAuth:{status:'warning',label:'Дозволено лише поза production'},origins:{status:'ok',label:'Allowlist налаштовано'},securityHeaders:{status:'ok',label:'Helmet/CSP увімкнено'}}};
  }

  async searchAdmin(userId:string,query:string):Promise<AdminSearchDto>{const data=await this.getAdminWorkspace(userId),term=query.toLocaleLowerCase('uk'),match=(value:unknown)=>String(value??'').toLocaleLowerCase('uk').includes(term);return{results:[...data.students.filter(x=>match(x.name)).map(x=>({type:'student' as const,id:String(x.id),label:String(x.name),meta:String(x.group)})),...data.teachers.filter(x=>match(x.name)).map(x=>({type:'teacher' as const,id:String(x.id),label:String(x.name),meta:'Викладач'})),...data.guardians.filter(x=>match(x.name)).map(x=>({type:'guardian' as const,id:String(x.id),label:String(x.name),meta:'Батьки'})),...data.groups.filter(x=>match(x.name)).map(x=>({type:'group' as const,id:String(x.id),label:String(x.name),meta:String(x.courseTitle)})),...data.sessions.filter(x=>match(x.title)).map(x=>({type:'class' as const,id:String(x.id),label:String(x.title),meta:String(x.group)})),...data.projects.filter(x=>match(x.title)).map(x=>({type:'project' as const,id:String(x.id),label:String(x.title),meta:String(x.student)}))].slice(0,30)}};

  async exploreAdmin(userId:string,input:{entity:AdminEntity;page:number;pageSize:number;sort:string;direction:'asc'|'desc';query?:string}):Promise<AdminExplorerPageDto>{const data=await this.getAdminWorkspace(userId);const map:Record<AdminEntity,Array<Record<string,unknown>>>={users:[...data.students,...data.teachers,...data.guardians],students:data.students,teachers:data.teachers,guardians:data.guardians,groups:data.groups,courses:[{id:DEV_IDS.course,title:PILOT.courseTitle,status:'published'}],modules:[{id:DEV_IDS.module,title:PILOT.moduleTitle,status:'published'}],lessons:SEEDED_LESSONS.map((item,index)=>({id:item.id,title:item.title,position:index+1,status:'published'})),sessions:data.sessions,attendance:(await this.getTeacherWorkspace(userId)).sessions.flatMap(item=>item.attendance.map(entry=>({id:`${item.id}:${entry.studentId}`,session:item.title,student:entry.studentName,status:entry.status,confirmedAt:entry.confirmedAt}))),homework:data.homework,submissions:(await this.getTeacherWorkspace(userId)).submissions.map(item=>({id:item.id,homework:item.homeworkTitle,student:item.studentName,attempt:item.attemptNumber,status:item.status,submittedAt:item.submittedAt})),reviews:(await this.getTeacherWorkspace(userId)).submissions.filter(item=>item.review).map(item=>({id:item.id,student:item.studentName,score:item.review!.score,effort:item.review!.effort,status:item.review!.status})),projects:data.projects,portfolios:data.portfolios,mentor_bookings:data.mentorBookings,reports:data.reports};let records=map[input.entity];const allowedSorts=new Set(records.length?Object.keys(records[0]!):['id']);if(!allowedSorts.has(input.sort))throw new AppError('INVALID_SORT',400,'Недозволене поле сортування');if(input.query){const term=input.query.toLocaleLowerCase('uk');records=records.filter(item=>Object.values(item).some(value=>String(value??'').toLocaleLowerCase('uk').includes(term)));}records=[...records].sort((left,right)=>String(left[input.sort]??'').localeCompare(String(right[input.sort]??''),'uk')*(input.direction==='asc'?1:-1));const total=records.length,start=(input.page-1)*input.pageSize;return{entity:input.entity,page:input.page,pageSize:input.pageSize,total,sort:input.sort,direction:input.direction,records:structuredClone(records.slice(start,start+input.pageSize))};}

  async adminSetAccountStatus(userId:string,targetUserId:string,status:'active'|'disabled'|'archived',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(userId===targetUserId&&status!=='active')throw new AppError('ADMIN_SELF_LOCKOUT',409,'Не можна вимкнути власний обліковий запис');this.requireUser(targetUserId);await this.runtimeStore.mutate(state=>{const previous=state.userStatus[targetUserId]??'disabled';state.userStatus[targetUserId]=status;this.addAudit(state,userId,'account.status_changed','user',targetUserId,{previous,status,reason},correlationId);});if(status!=='active')await this.sessionStore.revokeUser(targetUserId,new Date());}
  async adminCorrectAttendance(userId:string,attendanceId:string,status:'present'|'late'|'absent'|'excused',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const confirmedAt=nowIso();await this.runtimeStore.mutate(state=>{const entry=state.attendance.find(item=>item.id===attendanceId);if(!entry)throw new AppError('ATTENDANCE_NOT_FOUND',404,'Відвідування не знайдено');const previous=entry.status;entry.status=status;entry.confirmedAt=confirmedAt;this.addAudit(state,userId,'attendance.corrected','attendance',attendanceId,{previous,status,reason},correlationId);});}
  async adminSetPortfolioVisibility(userId:string,portfolioId:string,visibility:'private'|'shareable'|'public',reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');await this.runtimeStore.mutate(state=>{if(!(portfolioId in state.portfolioVisibility))throw new AppError('PORTFOLIO_NOT_FOUND',404,'Портфоліо не знайдено');const previous=state.portfolioVisibility[portfolioId];state.portfolioVisibility[portfolioId]=visibility;this.addAudit(state,userId,'portfolio.visibility_changed','portfolio',portfolioId,{previous,visibility,reason},correlationId);});}
  async adminRevokeGuardianLink(userId:string,linkId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');if(!this.guardianLinks.has(linkId))throw new AppError('GUARDIAN_LINK_NOT_FOUND',404,'Зв’язок не знайдено');this.guardianLinks.set(linkId,'revoked');await this.runtimeStore.mutate(state=>{this.addAudit(state,userId,'guardian.relationship_revoked','guardian_link',linkId,{reason},correlationId);});}
  async adminResendReport(userId:string,reportId:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const notification={id:randomUUID(),category:'parent_weekly_report',recipient:'Опікун',status:'pending',scheduledAt:nowIso(),attempts:0};await this.runtimeStore.mutate(state=>{const report=state.teacherReports.find(item=>item.id===reportId);if(!report||!['approved','sent','failed'].includes(report.status)||this.guardianLinks.get('92000000-0000-4000-8000-000000000001')!=='active')throw new AppError('REPORT_RESEND_FORBIDDEN',409,'Звіт не готовий або зв’язок із батьками неактивний');this.addAudit(state,userId,'report.resend_requested','parent_report',reportId,{},correlationId);});this.adminNotifications.unshift(notification);}
  async adminRevokeUserSession(userId:string,sessionId:string,reason:string,correlationId:string):Promise<void>{this.requireRole(userId,'admin');const session=await this.sessionStore.revokeById(sessionId,new Date());if(!session)throw new AppError('SESSION_NOT_FOUND',404,'Сесію не знайдено');const createdAt=nowIso(),id=randomUUID();await this.runtimeStore.mutate(state=>{this.addAudit(state,userId,'session.revoked','auth_session',sessionId,{subjectUserId:session.userId,reason},correlationId);state.securityEvents.unshift({id,type:'forced_session_revocation',severity:'medium',actorId:userId,targetId:session.userId,createdAt,correlationId});});}
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

  private requireUser(userId: string): AuthUser {
    const user = this.users.get(userId);
    if (!user) throw new AppError('USER_NOT_FOUND', 404, 'Користувача не знайдено');
    return user;
  }

  private requireRole(userId:string,role:'student'|'guardian'|'teacher'|'admin'):void{this.requireUser(userId);if(this.roles.get(userId)!==role&&this.roles.get(userId)!=='admin')throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав');}

  private requireMentor(userId:string):void{this.requireRole(userId,'teacher');if(!PILOT_TEACHERS.some(teacher=>teacher.id===userId&&teacher.mentor))throw new AppError('MENTOR_FORBIDDEN',403,'Менторські вікна недоступні');}

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
