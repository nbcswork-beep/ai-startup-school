export type UserId = string;

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
