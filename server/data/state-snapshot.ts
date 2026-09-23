import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import type { DeployEnvironment } from '../config/env.js';
import type { PilotDirectoryPerson, PilotRuntimeState } from './pilot-runtime-store.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Directory fields that are credential material. They are stripped from every export and
 * restored from the live state during recovery, so a snapshot can never be used to
 * exfiltrate or to silently reset a password.
 */
export const REDACTED_CREDENTIAL_FIELDS = ['passwordHash', 'activationTokenHash'] as const;

/** Keys that must never appear anywhere in an exported snapshot. Asserted in tests. */
export const FORBIDDEN_SNAPSHOT_KEYS = [
  'passwordHash', 'activationTokenHash', 'password', 'refreshTokenHash', 'refreshToken',
  'sessionToken', 'botToken', 'telegramBotToken', 'webhookSecret', 'telegramWebhookSecret',
  'cronSecret', 'sessionTokenPepper', 'upstashRedisRestToken', 'redisToken', 'privateKey',
  'appJwtPrivateKeyBase64'
] as const;

export interface SnapshotCounts {
  people: number;
  students: number;
  guardians: number;
  staff: number;
  telegramBindings: number;
  guardianRelations: number;
  groups: number;
  classSessions: number;
  attendance: number;
  homework: number;
  submissions: number;
  reviews: number;
  lessonProgressUsers: number;
  projects: number;
  portfolioItems: number;
  teacherNotes: number;
  teacherReports: number;
  parentContactRequests: number;
  notifications: number;
  auditEvents: number;
  securityEvents: number;
}

export interface RuntimeSnapshot {
  schemaVersion: number;
  generatedAt: string;
  environment: DeployEnvironment;
  namespace: string;
  stateSchemaVersion: number;
  /** Ids of people whose credential fields were stripped, so recovery can report coverage. */
  redactedCredentialUserIds: string[];
  counts: SnapshotCounts;
  state: PilotRuntimeState;
}

export class SnapshotValidationError extends AppError {
  constructor(message: string, public readonly issues: string[] = []) {
    super('SNAPSHOT_INVALID', 400, message, issues.length ? { issues } : undefined);
    this.name = 'SnapshotValidationError';
  }
}

const isoDate = z.string().refine(value => Number.isFinite(Date.parse(value)), 'must be an ISO timestamp');
const record = <T extends z.ZodTypeAny>(value: T) => z.record(z.string(), value);
const looseObject = z.object({});
const personStatus = z.enum(['pending', 'active', 'disabled', 'archived', 'suspended', 'deleted']);

const directoryPersonSchema = z.object({
  id: z.string().min(1),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  roles: z.array(z.enum(['student', 'guardian', 'teacher', 'mentor', 'admin'])),
  status: personStatus,
  groupId: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  telegramId: z.string().nullable(),
  passwordHash: z.null().optional(),
  activationTokenHash: z.null().optional(),
  activationExpiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative()
});

const guardianRelationSchema = z.object({
  id: z.string().min(1),
  guardianId: z.string().min(1),
  studentId: z.string().min(1),
  status: z.enum(['active', 'revoked'])
});

const lessonProgressSchema = z.object({
  progressPercent: z.number(),
  completedAt: z.string().nullable()
});

const stateSchema = z.object({
  schemaVersion: z.number().int().positive(),
  directory: record(directoryPersonSchema),
  telegramBindings: record(z.string().min(1)),
  guardianRelations: z.array(guardianRelationSchema),
  userStatus: record(z.enum(['active', 'disabled', 'archived', 'pending'])),
  xp: record(z.number()),
  streak: record(z.number()),
  lessonProgress: record(record(lessonProgressSchema)),
  projects: record(z.array(looseObject)),
  achievements: record(z.array(z.string())),
  idempotencyKeys: z.array(z.string()),
  classSessions: z.array(looseObject),
  attendance: z.array(looseObject),
  homework: z.array(looseObject),
  submissions: z.array(looseObject),
  portfolioProjects: record(z.array(looseObject)),
  portfolioVisibility: record(z.enum(['private', 'shareable', 'public'])),
  teacherNotes: z.array(looseObject),
  teacherReports: z.array(looseObject),
  adminAuditEvents: z.array(looseObject),
  securityEvents: z.array(looseObject),
  notifications: z.array(looseObject),
  parentContactRequests: z.array(looseObject)
});

const snapshotSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: isoDate,
  environment: z.enum(['production', 'preview', 'development', 'local']),
  namespace: z.string().min(1).max(200),
  stateSchemaVersion: z.number().int().positive(),
  redactedCredentialUserIds: z.array(z.string()).optional(),
  counts: looseObject.optional(),
  state: stateSchema
});

function countReviews(state: PilotRuntimeState): number {
  return state.submissions.filter(item => Boolean((item as { review?: unknown }).review)).length;
}

export function summarizeRuntimeState(state: PilotRuntimeState): SnapshotCounts {
  const people = Object.values(state.directory);
  const has = (person: PilotDirectoryPerson, role: string) => person.roles.includes(role as PilotDirectoryPerson['roles'][number]);
  const groups = new Set(people.map(person => person.groupId).filter((value): value is string => Boolean(value)));
  for (const session of state.classSessions) groups.add(session.groupId);
  return {
    people: people.length,
    students: people.filter(person => has(person, 'student')).length,
    guardians: people.filter(person => has(person, 'guardian')).length,
    staff: people.filter(person => has(person, 'teacher') || has(person, 'mentor') || has(person, 'admin')).length,
    telegramBindings: Object.keys(state.telegramBindings).length,
    guardianRelations: state.guardianRelations.filter(link => link.status === 'active').length,
    groups: groups.size,
    classSessions: state.classSessions.length,
    attendance: state.attendance.length,
    homework: state.homework.length,
    submissions: state.submissions.length,
    reviews: countReviews(state),
    lessonProgressUsers: Object.keys(state.lessonProgress).length,
    projects: Object.values(state.projects).reduce((sum, list) => sum + list.length, 0),
    portfolioItems: Object.values(state.portfolioProjects).reduce((sum, list) => sum + list.length, 0),
    teacherNotes: state.teacherNotes.length,
    teacherReports: state.teacherReports.length,
    parentContactRequests: state.parentContactRequests.length,
    notifications: state.notifications.length,
    auditEvents: state.adminAuditEvents.length,
    securityEvents: state.securityEvents.length
  };
}

/** Removes credential material from a deep copy of the state. The input is never mutated. */
export function redactRuntimeState(state: PilotRuntimeState): { state: PilotRuntimeState; redactedCredentialUserIds: string[] } {
  const copy = structuredClone(state);
  const redactedCredentialUserIds: string[] = [];
  for (const person of Object.values(copy.directory)) {
    const carried = REDACTED_CREDENTIAL_FIELDS.some(field => Boolean(person[field]));
    if (carried) redactedCredentialUserIds.push(person.id);
    person.passwordHash = null;
    person.activationTokenHash = null;
  }
  return { state: copy, redactedCredentialUserIds };
}

export function createRuntimeSnapshot(
  state: PilotRuntimeState,
  context: { environment: DeployEnvironment; namespace: string; generatedAt?: Date }
): RuntimeSnapshot {
  const redacted = redactRuntimeState(state);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: (context.generatedAt ?? new Date()).toISOString(),
    environment: context.environment,
    namespace: context.namespace,
    stateSchemaVersion: state.schemaVersion,
    redactedCredentialUserIds: redacted.redactedCredentialUserIds,
    counts: summarizeRuntimeState(state),
    state: redacted.state
  };
}

/**
 * Validates a snapshot and returns the *original* object rather than the parser output, so
 * fields added by a future schema version survive a round trip instead of being silently
 * dropped during recovery.
 */
export function parseRuntimeSnapshot(input: unknown): RuntimeSnapshot {
  let candidate = input;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new SnapshotValidationError('Snapshot file is not valid JSON');
    }
  }
  const result = snapshotSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 20).map(issue => `${issue.path.map(String).join('.') || 'snapshot'}: ${issue.message}`);
    throw new SnapshotValidationError('Snapshot does not match the expected schema', issues);
  }
  const snapshot = candidate as RuntimeSnapshot;
  if (snapshot.schemaVersion > SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotValidationError(`Snapshot schemaVersion ${snapshot.schemaVersion} is newer than this build supports (${SNAPSHOT_SCHEMA_VERSION})`);
  }
  const leaked = findSnapshotSecrets(snapshot);
  if (leaked.length) {
    throw new SnapshotValidationError('Snapshot carries credential material and was rejected', leaked);
  }
  snapshot.redactedCredentialUserIds ??= [];
  return snapshot;
}

/** Walks a snapshot looking for forbidden keys holding a non-empty value. Used by tests and by the importer. */
export function findSnapshotSecrets(value: unknown, path = 'snapshot', found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSnapshotSecrets(item, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_SNAPSHOT_KEYS as readonly string[]).includes(key) && child !== null && child !== undefined && child !== '') {
      found.push(`${path}.${key}`);
    }
    findSnapshotSecrets(child, `${path}.${key}`, found);
  }
  return found;
}
