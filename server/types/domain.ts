export type UserId = string;
export type AppRole = 'student' | 'guardian' | 'teacher' | 'admin';

export interface AuthUser {
  id: UserId;
  displayName: string;
  status: 'active' | 'suspended' | 'deleted';
}

export interface TelegramIdentityInput {
  telegramId: string;
  firstName: string;
  lastName?: string;
  languageCode?: string;
}

export interface NewSession {
  id: string;
  familyId: string;
  userId: UserId;
  provider: 'telegram' | 'development' | 'web';
  refreshTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export type RotationResult =
  | { status: 'ok'; user: AuthUser; session: NewSession }
  | { status: 'invalid' | 'expired' | 'revoked' | 'reused' };

export interface ViewerDto {
  id: string;
  firstName: string;
  level: {
    number: number;
    title: string;
    nextTitle: string | null;
    currentMinXp: number;
    nextMinXp: number | null;
  };
  xp: number;
  streak: number;
}

export interface LessonSummaryDto {
  id: string;
  number: string;
  title: string;
  summary: string;
  estimatedMinutes: number;
  xpReward: number;
  state: 'completed' | 'current' | 'available' | 'locked';
  progressPercent: number;
}

export interface LearningDto {
  course: {
    id: string;
    title: string;
    description: string;
    progressPercent: number;
    completedLessons: number;
    totalLessons: number;
  };
  modules: Array<{
    id: string;
    number: string;
    title: string;
    description: string;
    lessons: LessonSummaryDto[];
  }>;
}

export interface LessonDto extends LessonSummaryDto {
  moduleTitle: string;
  content: {
    explanation: string;
    examples: string[];
    task: { prompt: string; hint: string };
    conceptName: string;
    nextStep: string;
  };
  nextLessonId: string | null;
}

export interface ProjectTaskDto {
  id: string;
  number: string;
  title: string;
  description: string;
  status: 'locked' | 'available' | 'in_progress' | 'completed';
  xpReward: number;
  weight: number;
}

export interface ProjectDto {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'completed' | 'archived';
  completionPercent: number;
  stage: { id: string; code: string; title: string; position: number; total: number };
  tags: string[];
  workspaceUrl: string | null;
  tasks: ProjectTaskDto[];
}

export interface AchievementDto {
  id: string;
  code: string;
  title: string;
  description: string;
  artifactStyleKey: string;
  earned: boolean;
  awardedAt: string | null;
}

export interface ProfileDto {
  viewer: ViewerDto;
  nextLevelProgressPercent: number;
  lessonCount: number;
  projectCount: number;
  achievements: AchievementDto[];
  mentor: null | {
    displayName: string;
    title: string;
    avatarPath: string | null;
    nextMeetingAt: string | null;
  };
}

export interface HomeDto {
  viewer: ViewerDto;
  course: LearningDto['course'];
  currentLesson: LessonSummaryDto | null;
  projectCount: number;
  currentProject: ProjectDto | null;
  nextClass?: ClassSessionDto | null;
  homeworkDue?: HomeworkSummaryDto | null;
}

export interface ClassMaterialDto {
  id: string;
  kind: 'presentation' | 'document' | 'link' | 'file' | 'reference' | 'other';
  title: string;
  url: string | null;
}

export interface ClassSessionDto {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: 'scheduled' | 'rescheduled' | 'in_progress' | 'completed' | 'cancelled';
  meetingProvider: string | null;
  meetingUrl: string | null;
  courseTitle: string;
  moduleTitle: string | null;
  lessonTitle: string | null;
  teacherName: string;
  materials: ClassMaterialDto[];
}

export interface ScheduleDto {
  timezone: string;
  nextClass: ClassSessionDto | null;
  today: ClassSessionDto[];
  thisWeek: ClassSessionDto[];
  upcoming: ClassSessionDto[];
  past: ClassSessionDto[];
}

export type HomeworkState = 'not_started' | 'in_progress' | 'submitted' | 'needs_revision' | 'completed';
export type EffortLevel = 'needs_attention' | 'good_effort' | 'high_effort';

export interface HomeworkReviewDto {
  score: number;
  effort: EffortLevel;
  status: 'reviewed' | 'needs_revision' | 'completed';
  feedback: string;
  reviewedAt: string;
}

export interface HomeworkSubmissionDto {
  id: string;
  attemptNumber: number;
  submittedAt: string | null;
  studentComment: string;
  contentText: string;
  contentUrl: string | null;
  status: HomeworkState;
  review: HomeworkReviewDto | null;
}

export interface HomeworkSummaryDto {
  id: string;
  title: string;
  instructions: string;
  publishedAt: string;
  dueAt: string | null;
  xpReward: number;
  classTitle: string | null;
  state: HomeworkState;
  latestSubmission: HomeworkSubmissionDto | null;
}

export interface PortfolioProjectDto {
  id: string;
  projectId: string;
  title: string;
  shortDescription: string;
  reflection: string;
  learned: string;
  skills: string[];
  technologies: string[];
  demoUrl: string | null;
  coverPath: string | null;
  screenshots: string[];
  completionDate: string | null;
}

export interface PortfolioDto {
  id: string;
  title: string;
  visibility: 'private' | 'shared';
  projects: PortfolioProjectDto[];
  skills: Array<{ code: string; title: string; level: number }>;
}

export interface MentorSlotDto {
  id: string;
  mentorId: string;
  mentorName: string;
  mentorTitle: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  available: boolean;
}

export interface MentorBookingDto {
  id: string;
  mentorId: string;
  mentorName: string;
  startsAt: string;
  endsAt: string;
  status: 'reserved' | 'confirmed' | 'completed' | 'cancelled' | 'rescheduled' | 'no_show';
  meetingUrl: string | null;
}

export interface TeacherGroupDto {
  id: string;
  name: string;
  courseTitle: string;
  timezone: string;
  studentCount: number;
  nextClassAt: string | null;
}

export interface TeacherStudentDto {
  id: string;
  firstName: string;
  progressPercent: number;
  projectTitle: string | null;
}

export interface ParentReportDto {
  id: string;
  studentId: string;
  studentFirstName: string;
  periodStart: string;
  periodEnd: string;
  payload: Record<string, unknown>;
  teacherComment: string;
  status: 'draft' | 'ready_for_review' | 'approved' | 'sent' | 'failed';
}

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'excused';
export type TeacherClassStatus = 'scheduled' | 'rescheduled' | 'in_progress' | 'completed' | 'cancelled';

export interface TeacherAttendanceDto {
  studentId: string;
  studentName: string;
  status: AttendanceStatus | null;
  suggestedStatus: AttendanceStatus | null;
  note: string;
  confirmedAt: string | null;
}

export interface TeacherSessionDto extends ClassSessionDto {
  groupId: string;
  groupName: string;
  lessonId: string | null;
  teacherNotes: string;
  attendance: TeacherAttendanceDto[];
  homeworkIds: string[];
}

export interface TeacherHomeworkDto {
  id: string;
  groupId: string;
  groupName: string;
  classSessionId: string | null;
  title: string;
  instructions: string;
  publishAt: string | null;
  dueAt: string | null;
  xpReward: number;
  status: 'draft' | 'published' | 'closed' | 'archived';
  submissionCount: number;
  reviewCount: number;
  needsRevisionCount: number;
  resources?: ClassMaterialDto[];
}

export interface TeacherSubmissionDto {
  id: string;
  homeworkId: string;
  homeworkTitle: string;
  groupId: string;
  groupName: string;
  studentId: string;
  studentName: string;
  attemptNumber: number;
  submittedAt: string | null;
  studentComment: string;
  contentText: string;
  contentUrl: string | null;
  status: HomeworkState;
  review: HomeworkReviewDto | null;
  attachments: ClassMaterialDto[];
  previousAttempts: HomeworkSubmissionDto[];
}

export interface TeacherPrivateNoteDto {
  id: string;
  studentId: string;
  category: 'general' | 'learning' | 'project' | 'mentoring';
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeacherStudentDetailDto extends TeacherStudentDto {
  groupId: string;
  groupName: string;
  courseTitle: string;
  moduleTitle: string;
  xp: number;
  level: string;
  attendance: { present: number; late: number; absent: number; excused: number };
  homework: { assigned: number; submitted: number; needsRevision: number; averageScore: number | null; effort: EffortLevel | null };
  projects: ProjectDto[];
  portfolio: PortfolioDto | null;
  mentorBookings: MentorBookingDto[];
  notes: TeacherPrivateNoteDto[];
  attentionReasons: string[];
  recentActivityAt: string | null;
}

export interface TeacherMentorAvailabilityDto {
  id: string;
  mentorId: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: 'open' | 'blocked' | 'booked' | 'cancelled';
}

export interface TeacherMentorBookingDto extends MentorBookingDto {
  studentId: string;
  studentName: string;
  projectTitle: string | null;
}

export interface TeacherReportDto extends ParentReportDto {
  groupId: string;
  groupName: string;
  approvedAt: string | null;
}

export interface TeacherWorkspaceDto {
  teacher: { id: string; name: string; title: string; timezone: string };
  metrics: { todayClasses: number; awaitingReview: number; resubmitted: number; mentorToday: number; reportsPending: number };
  groups: Array<TeacherGroupDto & { courseId: string; scheduleLabel: string; progressPercent: number; attendanceRate: number; recentHomework: string | null }>;
  sessions: TeacherSessionDto[];
  homework: TeacherHomeworkDto[];
  submissions: TeacherSubmissionDto[];
  students: TeacherStudentDetailDto[];
  mentor: { mentorId: string | null; availability: TeacherMentorAvailabilityDto[]; bookings: TeacherMentorBookingDto[] };
  reports: TeacherReportDto[];
  lessons: Array<{ id: string; title: string; moduleTitle: string }>;
  attention: Array<{ studentId: string; studentName: string; reasons: string[] }>;
}

export interface TeacherSearchDto {
  students: Array<{ id: string; label: string; meta: string }>;
  groups: Array<{ id: string; label: string; meta: string }>;
  homework: Array<{ id: string; label: string; meta: string }>;
  projects: Array<{ id: string; label: string; meta: string }>;
}

export interface AiConversationDto {
  id: string;
  title: string;
  courseId: string | null;
  lessonId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessageDto {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AiContextDto {
  firstName: string;
  courseTitle: string | null;
  moduleTitle: string | null;
  lessonTitle: string | null;
  lessonSummary: string | null;
  projectTitle: string | null;
  projectSummary: string | null;
  projectStage: string | null;
  nextProjectTask: string | null;
  conversationSummary: string;
  recentMessages: AiMessageDto[];
}
