import type {
  AchievementDto,
  AiContextDto,
  AiConversationDto,
  AiMessageDto,
  AuthUser,
  HomeDto,
  LearningDto,
  LessonDto,
  NewSession,
  ProfileDto,
  ProjectDto,
  RotationResult,
  TelegramIdentityInput,
  UserId
} from '../types/domain.js';

export interface AppRepository {
  ping(): Promise<void>;

  resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser>;
  getDevelopmentUser(userId: UserId): Promise<AuthUser | null>;
  getAuthUser(userId: UserId): Promise<AuthUser | null>;
  createSession(session: NewSession): Promise<void>;
  rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult>;
  revokeSession(refreshTokenHash: string, now: Date): Promise<boolean>;

  getHome(userId: UserId): Promise<HomeDto>;
  getLearning(userId: UserId): Promise<LearningDto>;
  getLesson(userId: UserId, lessonId: string): Promise<LessonDto | null>;
  completeLesson(userId: UserId, lessonId: string, idempotencyKey: string): Promise<{ awardedXp: number; home: HomeDto }>;

  listProjects(userId: UserId): Promise<ProjectDto[]>;
  createProject(userId: UserId, input: { title: string; summary: string }): Promise<ProjectDto>;
  updateProject(userId: UserId, projectId: string, input: { title?: string; summary?: string }): Promise<ProjectDto | null>;
  completeProjectTask(userId: UserId, projectId: string, taskId: string, idempotencyKey: string): Promise<{ awardedXp: number; project: ProjectDto } | null>;

  getProfile(userId: UserId): Promise<ProfileDto>;
  listAchievements(userId: UserId): Promise<AchievementDto[]>;

  listConversations(userId: UserId): Promise<AiConversationDto[]>;
  createConversation(userId: UserId, title?: string): Promise<AiConversationDto>;
  getConversation(userId: UserId, conversationId: string): Promise<AiConversationDto | null>;
  listMessages(userId: UserId, conversationId: string, limit: number, before?: string): Promise<AiMessageDto[]>;
  appendAiMessage(userId: UserId, conversationId: string, message: Omit<AiMessageDto, 'id' | 'createdAt'> & { clientMessageId?: string }): Promise<AiMessageDto | null>;
  getAiContext(userId: UserId, conversationId: string): Promise<AiContextDto | null>;
  updateConversationSummary(conversationId: string, summary: string): Promise<void>;
}
