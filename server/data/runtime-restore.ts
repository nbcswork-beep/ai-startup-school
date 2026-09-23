import { AppError } from '../errors/app-error.js';
import type { DeployEnvironment } from '../config/env.js';
import type { PilotRuntimeState, PilotRuntimeStore } from './pilot-runtime-store.js';
import {
  REDACTED_CREDENTIAL_FIELDS,
  createRuntimeSnapshot,
  summarizeRuntimeState,
  type RuntimeSnapshot,
  type SnapshotCounts
} from './state-snapshot.js';

export interface RestorePlan {
  namespace: string;
  targetEnvironment: DeployEnvironment;
  snapshotEnvironment: DeployEnvironment;
  environmentMismatch: boolean;
  /** True when the target namespace holds no state yet, so there is nothing to overwrite. */
  targetInitialized: boolean;
  current: SnapshotCounts | null;
  incoming: SnapshotCounts;
  /** People whose credentials are carried over from the live state. */
  credentialsPreserved: string[];
  /** People the snapshot says had credentials that the live state can no longer supply. */
  credentialsUnrecoverable: string[];
}

export class RestoreRefusedError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, 409, message, details);
    this.name = 'RestoreRefusedError';
  }
}

/**
 * Re-attaches credential material that was stripped from the snapshot. Restoring must never
 * clear a teacher's password or a pending activation token, so those fields always come from the
 * live state rather than from the file.
 */
export function mergeRuntimeCredentials(
  incoming: PilotRuntimeState,
  live: PilotRuntimeState | null
): { state: PilotRuntimeState; preserved: string[]; unrecoverable: string[] } {
  const state = structuredClone(incoming);
  const preserved: string[] = [];
  const unrecoverable: string[] = [];
  for (const person of Object.values(state.directory)) {
    const existing = live?.directory[person.id];
    let carried = false;
    for (const field of REDACTED_CREDENTIAL_FIELDS) {
      const value = existing?.[field] ?? null;
      person[field] = value;
      if (value) carried = true;
    }
    if (existing?.activationExpiresAt !== undefined) person.activationExpiresAt = existing.activationExpiresAt;
    if (carried) preserved.push(person.id);
  }
  for (const id of incoming.directory ? Object.keys(incoming.directory) : []) {
    const person = state.directory[id];
    const hadCredentials = Boolean(live?.directory[id]?.passwordHash || live?.directory[id]?.activationTokenHash);
    if (person && !hadCredentials && person.roles.some(role => role === 'teacher' || role === 'mentor' || role === 'admin')) {
      unrecoverable.push(id);
    }
  }
  return { state, preserved, unrecoverable };
}

export async function planRuntimeRestore(
  store: PilotRuntimeStore,
  snapshot: RuntimeSnapshot,
  targetEnvironment: DeployEnvironment
): Promise<RestorePlan> {
  const status = await store.status();
  const live = status.initialized ? await store.read() : null;
  const merged = mergeRuntimeCredentials(snapshot.state, live);
  return {
    namespace: status.namespace,
    targetEnvironment,
    snapshotEnvironment: snapshot.environment,
    environmentMismatch: snapshot.environment !== targetEnvironment,
    targetInitialized: status.initialized,
    current: live ? summarizeRuntimeState(live) : null,
    incoming: summarizeRuntimeState(snapshot.state),
    credentialsPreserved: merged.preserved,
    credentialsUnrecoverable: merged.unrecoverable
  };
}

export interface ApplyRestoreOptions {
  /**
   * Persists the pre-restore snapshot and resolves with its location. A restore is abandoned if
   * this rejects, so the previous state is never overwritten without a recoverable copy.
   */
  backup(snapshot: RuntimeSnapshot): Promise<string>;
  allowEnvironmentMismatch?: boolean;
  now?: Date;
}

export async function applyRuntimeRestore(
  store: PilotRuntimeStore,
  snapshot: RuntimeSnapshot,
  plan: RestorePlan,
  options: ApplyRestoreOptions
): Promise<{ backupLocation: string | null; restoredCounts: SnapshotCounts }> {
  if (plan.environmentMismatch && !options.allowEnvironmentMismatch) {
    throw new RestoreRefusedError(
      'RESTORE_ENVIRONMENT_MISMATCH',
      `Refusing to restore a "${plan.snapshotEnvironment}" snapshot into the "${plan.targetEnvironment}" environment. `
      + 'Pass --allow-environment-mismatch only when this is deliberate.',
      { snapshotEnvironment: plan.snapshotEnvironment, targetEnvironment: plan.targetEnvironment }
    );
  }

  let backupLocation: string | null = null;
  if (plan.targetInitialized) {
    const live = await store.read();
    const preRestore = createRuntimeSnapshot(live, {
      environment: plan.targetEnvironment,
      namespace: plan.namespace,
      ...(options.now ? { generatedAt: options.now } : {})
    });
    backupLocation = await options.backup(preRestore);
    if (!backupLocation) {
      throw new RestoreRefusedError('RESTORE_BACKUP_FAILED', 'Pre-restore backup did not report a location; restore aborted.');
    }
  }

  const live = plan.targetInitialized ? await store.read() : null;
  const merged = mergeRuntimeCredentials(snapshot.state, live);
  await store.replace(merged.state);
  return { backupLocation, restoredCounts: summarizeRuntimeState(merged.state) };
}
