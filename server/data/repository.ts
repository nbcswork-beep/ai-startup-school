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
  NewSession,
  ProfileDto,
  PortfolioDto,
  ProjectDto,
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
  TelegramIdentityInput,
  UserId
} from '../types/domain.js';

export interface AppRepository {
  ping(): Promise<void>;

  resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser>;
  getDevelopmentUser(userId: UserId): Promise<AuthUser | null>;
  getAuthUser(userId: UserId): Promise<AuthUser | null>;
  getWebAuthUser(userId: UserId): Promise<{ user: AuthUser; role: AccessContext['role'] } | null>;
  createSession(session: NewSession): Promise<void>;
  rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult>;
  revokeSession(refreshTokenHash: string, now: Date): Promise<boolean>;
  getAccessContext(userId: UserId, sessionId: string): Promise<AccessContext>;

  getHome(userId: UserId): Promise<HomeDto>;
  getSchedule(userId: UserId): Promise<ScheduleDto>;
  listHomework(userId: UserId): Promise<HomeworkSummaryDto[]>;
  submitHomework(userId: UserId, homeworkId: string, input: { contentText: string; contentUrl?: string; studentComment?: string }): Promise<HomeworkSubmissionDto>;
  getLearning(userId: UserId): Promise<LearningDto>;
  getLesson(userId: UserId, lessonId: string): Promise<LessonDto | null>;
  completeLesson(userId: UserId, lessonId: string, idempotencyKey: string): Promise<{ awardedXp: number; home: HomeDto }>;

  listProjects(userId: UserId): Promise<ProjectDto[]>;
  createProject(userId: UserId, input: { title: string; summary: string }): Promise<ProjectDto>;
  updateProject(userId: UserId, projectId: string, input: { title?: string; summary?: string }): Promise<ProjectDto | null>;
  completeProjectTask(userId: UserId, projectId: string, taskId: string, idempotencyKey: string): Promise<{ awardedXp: number; project: ProjectDto } | null>;

  getProfile(userId: UserId): Promise<ProfileDto>;
  listAchievements(userId: UserId): Promise<AchievementDto[]>;
  getPortfolio(userId: UserId): Promise<PortfolioDto>;
  addProjectToPortfolio(userId: UserId, projectId: string, input: { reflection?: string; learned?: string }): Promise<PortfolioDto>;
  listMentorSlots(userId: UserId): Promise<MentorSlotDto[]>;
  bookMentorSlot(userId: UserId, availabilityId: string): Promise<MentorBookingDto>;

  listTeacherGroups(userId: UserId): Promise<TeacherGroupDto[]>;
  listGroupStudents(userId: UserId, groupId: string): Promise<TeacherStudentDto[]>;
  createClassSession(userId: UserId, input: { groupId: string; courseId: string; moduleId?: string; lessonId?: string; title: string; description?: string; startsAt: string; endsAt: string; meetingUrl?: string; meetingProvider?: string }): Promise<ClassSessionDto>;
  rescheduleClass(userId: UserId, sessionId: string, input: { startsAt: string; endsAt: string; reason?: string }): Promise<void>;
  confirmAttendance(userId: UserId, sessionId: string, studentId: string, status: 'present' | 'late' | 'absent' | 'excused', note?: string): Promise<void>;
  createHomework(userId: UserId, input: { groupId: string; courseId: string; moduleId?: string; lessonId?: string; classSessionId?: string; title: string; instructions: string; publishAt?: string; dueAt?: string; xpReward: number; status: 'draft' | 'published'; resources?: Array<{ kind: 'presentation' | 'document' | 'link' | 'reference' | 'other'; title: string; url: string }> }): Promise<HomeworkSummaryDto>;
  reviewHomework(userId: UserId, submissionId: string, input: { score: number; effort: EffortLevel; status: 'reviewed' | 'needs_revision' | 'completed'; feedback: string }): Promise<void>;
  getTeacherWorkspace(userId: UserId): Promise<TeacherWorkspaceDto>;
  searchTeacherScope(userId: UserId, query: string): Promise<TeacherSearchDto>;
  updateTeacherClass(userId: UserId, sessionId: string, input: { title?: string; description?: string; lessonId?: string | null; meetingUrl?: string | null; meetingProvider?: string | null; teacherNotes?: string; status?: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' }): Promise<void>;
  addClassMaterial(userId: UserId, sessionId: string, input: { kind: 'presentation' | 'document' | 'link' | 'reference' | 'other'; title: string; url: string }): Promise<void>;
  bulkConfirmAttendance(userId: UserId, sessionId: string, entries: Array<{ studentId: string; status: 'present' | 'late' | 'absent' | 'excused'; note?: string }>): Promise<void>;
  publishHomework(userId: UserId, homeworkId: string, publishAt: string): Promise<void>;
  createTeacherNote(userId: UserId, studentId: string, input: { category: 'general' | 'learning' | 'project' | 'mentoring'; content: string }): Promise<TeacherPrivateNoteDto>;
  updatePortfolioItemAsTeacher(userId: UserId, portfolioProjectId: string, input: { title?: string | null; shortDescription?: string; reflection?: string; learned?: string }): Promise<void>;
  createMentorAvailability(userId: UserId, input: { startsAt: string; endsAt: string; timezone: string; status: 'open' | 'blocked' }): Promise<void>;
  updateMentorBooking(userId: UserId, bookingId: string, input: { status: 'confirmed' | 'completed' | 'cancelled' | 'rescheduled' | 'no_show'; meetingUrl?: string | null; startsAt?: string; endsAt?: string }): Promise<void>;
  generateTeacherReports(userId: UserId, groupId: string, periodStart: string, periodEnd: string): Promise<void>;
  saveTeacherReport(userId: UserId, reportId: string, input: { teacherComment: string; status: 'draft' | 'ready_for_review' }): Promise<void>;
  approveTeacherReport(userId: UserId, reportId: string): Promise<void>;
  listLinkedStudents(userId: UserId): Promise<TeacherStudentDto[]>;
  listParentReports(userId: UserId, studentId: string): Promise<ParentReportDto[]>;

  getAdminWorkspace(userId: UserId): Promise<AdminWorkspaceDto>;
  searchAdmin(userId: UserId, query: string): Promise<AdminSearchDto>;
  exploreAdmin(userId: UserId, input: { entity: AdminEntity; page: number; pageSize: number; sort: string; direction: 'asc'|'desc'; query?: string }): Promise<AdminExplorerPageDto>;
  adminSetAccountStatus(userId: UserId, targetUserId: string, status: 'active'|'disabled'|'archived', reason: string, correlationId: string): Promise<void>;
  adminCorrectAttendance(userId: UserId, attendanceId: string, status: 'present'|'late'|'absent'|'excused', reason: string, correlationId: string): Promise<void>;
  adminSetPortfolioVisibility(userId: UserId, portfolioId: string, visibility: 'private'|'shareable'|'public', reason: string, correlationId: string): Promise<void>;
  adminRevokeGuardianLink(userId: UserId, linkId: string, reason: string, correlationId: string): Promise<void>;
  adminResendReport(userId: UserId, reportId: string, correlationId: string): Promise<void>;
  adminRevokeUserSession(userId: UserId, sessionId: string, reason: string, correlationId: string): Promise<void>;
  recordSecurityEvent(input: { eventType: string; severity: 'low'|'medium'|'high'|'critical'; actorUserId?: string; targetUserId?: string; metadata?: Record<string,unknown>; correlationId: string }): Promise<void>;

  listConversations(userId: UserId): Promise<AiConversationDto[]>;
  createConversation(userId: UserId, title?: string): Promise<AiConversationDto>;
  getConversation(userId: UserId, conversationId: string): Promise<AiConversationDto | null>;
  listMessages(userId: UserId, conversationId: string, limit: number, before?: string): Promise<AiMessageDto[]>;
  appendAiMessage(userId: UserId, conversationId: string, message: Omit<AiMessageDto, 'id' | 'createdAt'> & { clientMessageId?: string }): Promise<AiMessageDto | null>;
  getAiContext(userId: UserId, conversationId: string): Promise<AiContextDto | null>;
  updateConversationSummary(conversationId: string, summary: string): Promise<void>;
}
