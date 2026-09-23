import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stderr, stdout } from 'node:process';
import { resolveDeployEnvironment, resolveRedisRestCredentials, resolveRuntimeRedisPrefix, assertRedisNamespaceIsolation } from '../server/config/env.js';
import { RedisRestPilotRuntimeStore } from '../server/data/pilot-runtime-store.js';
import { createRuntimeSnapshot, parseRuntimeSnapshot } from '../server/data/state-snapshot.js';
import { applyRuntimeRestore, planRuntimeRestore } from '../server/data/runtime-restore.js';

const USAGE = `AI Startup School — pilot runtime backup and recovery

  Export the live state to a file:
    npm run runtime:export -- --out backups/runtime.json

  Inspect a snapshot against the live state (DRY RUN, writes nothing):
    npm run runtime:restore -- --file backups/runtime.json

  Actually restore it:
    npm run runtime:restore -- --file backups/runtime.json --confirm-restore

Flags
  --file <path>                 snapshot to restore
  --out <path>                  destination for an export
  --confirm-restore             perform the restore (without it the run is a dry run)
  --allow-environment-mismatch  permit restoring a snapshot taken in another environment
  --expect-environment <env>    required when VERCEL_ENV is not set locally
  --backup-dir <dir>            where the pre-restore backup is written (default: backups)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
}

function line(text = '') { stdout.write(`${text}\n`); }

function countsTable(label, current, incoming) {
  const keys = Object.keys(incoming);
  const width = Math.max(...keys.map(key => key.length)) + 2;
  line(label);
  for (const key of keys) {
    const before = current ? String(current[key] ?? 0) : '—';
    const after = String(incoming[key] ?? 0);
    const changed = current && before !== after;
    line(`  ${key.padEnd(width)} ${before.padStart(7)} → ${after.padStart(7)}${changed ? '   *' : ''}`);
  }
}

function openStore(args) {
  const credentials = resolveRedisRestCredentials(process.env);
  if (!credentials) throw new Error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or the KV_REST_API aliases) before running this script.');
  const sessionPrefix = process.env.SESSION_REDIS_PREFIX?.trim() || 'aiss:local:sessions:v1';
  const runtimePrefix = resolveRuntimeRedisPrefix({
    PILOT_RUNTIME_REDIS_PREFIX: process.env.PILOT_RUNTIME_REDIS_PREFIX?.trim() || undefined,
    SESSION_REDIS_PREFIX: sessionPrefix
  });
  const platformEnvironment = resolveDeployEnvironment(process.env);
  assertRedisNamespaceIsolation({
    deployEnvironment: platformEnvironment,
    prefixes: [{ field: 'SESSION_REDIS_PREFIX', value: sessionPrefix }, { field: 'PILOT_RUNTIME_REDIS_PREFIX', value: runtimePrefix }]
  });

  const declared = typeof args['expect-environment'] === 'string' ? args['expect-environment'] : undefined;
  if (declared && !['production', 'preview', 'development', 'local'].includes(declared)) {
    throw new Error(`--expect-environment must be one of production, preview, development, local (received "${declared}")`);
  }
  if (platformEnvironment === 'local' && !declared) {
    throw new Error(
      'VERCEL_ENV is not set, so the target environment is ambiguous. '
      + 'Pass --expect-environment production|preview|development|local so a snapshot can never be restored into the wrong place.'
    );
  }
  if (declared && platformEnvironment !== 'local' && declared !== platformEnvironment) {
    throw new Error(`--expect-environment ${declared} contradicts VERCEL_ENV=${platformEnvironment}.`);
  }
  const environment = declared ?? platformEnvironment;
  // Recovery tooling must read what is actually stored, never seed over a missing key.
  const store = new RedisRestPilotRuntimeStore(credentials.url, credentials.token, runtimePrefix, { bootstrapPolicy: 'require' });
  return { store, environment, runtimePrefix };
}

async function writeSnapshot(path, snapshot) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return target;
}

async function runExport(args) {
  const out = typeof args.out === 'string' ? args.out : undefined;
  if (!out) throw new Error('Pass --out <path> to choose where the export is written.');
  const { store, environment } = openStore(args);
  const status = await store.status();
  if (!status.initialized) throw new Error(`No runtime state exists at "${status.namespace}" — there is nothing to export.`);
  const snapshot = createRuntimeSnapshot(await store.read(), { environment, namespace: status.namespace });
  const target = await writeSnapshot(out, snapshot);
  line(`Exported ${environment} runtime state`);
  line(`  namespace   ${status.namespace}`);
  line(`  generatedAt ${snapshot.generatedAt}`);
  line(`  file        ${target}`);
  line(`  credentials stripped for ${snapshot.redactedCredentialUserIds.length} account(s); they are re-attached from the live state on restore`);
  countsTable('\nContents', null, snapshot.counts);
}

async function runRestore(args) {
  const file = typeof args.file === 'string' ? args.file : undefined;
  if (!file) throw new Error('Pass --file <path> with the snapshot to restore.');
  const snapshot = parseRuntimeSnapshot(await readFile(resolve(file), 'utf8'));
  const { store, environment } = openStore(args);
  const plan = await planRuntimeRestore(store, snapshot, environment);
  const confirmed = args['confirm-restore'] === true;
  const allowMismatch = args['allow-environment-mismatch'] === true;

  line(`Snapshot    ${resolve(file)}`);
  line(`  taken in  ${plan.snapshotEnvironment} at ${snapshot.generatedAt}`);
  line(`  from      ${snapshot.namespace}`);
  line(`Target      ${plan.targetEnvironment}`);
  line(`  namespace ${plan.namespace}`);
  line(`  state      ${plan.targetInitialized ? 'present (will be overwritten)' : 'EMPTY (nothing to overwrite)'}`);
  if (plan.environmentMismatch) {
    line('');
    line(`  !! ENVIRONMENT MISMATCH: a "${plan.snapshotEnvironment}" snapshot into "${plan.targetEnvironment}".`);
    line(`  !! ${allowMismatch ? 'Overridden with --allow-environment-mismatch.' : 'Refused. Pass --allow-environment-mismatch only if this is deliberate.'}`);
  }
  countsTable('\nChange', plan.current, plan.incoming);
  line('');
  line(`Credentials re-attached from the live state for ${plan.credentialsPreserved.length} account(s).`);
  if (plan.credentialsUnrecoverable.length) {
    line(`Staff accounts left without a password (they will need a fresh activation link): ${plan.credentialsUnrecoverable.length}`);
  }

  if (!confirmed) {
    line('');
    line('DRY RUN — nothing was written. Re-run with --confirm-restore to apply.');
    return;
  }

  const backupDir = typeof args['backup-dir'] === 'string' ? args['backup-dir'] : 'backups';
  const result = await applyRuntimeRestore(store, snapshot, plan, {
    allowEnvironmentMismatch: allowMismatch,
    backup: async preRestore => writeSnapshot(`${backupDir}/pre-restore-${preRestore.environment}-${preRestore.generatedAt.replace(/[:.]/g, '-')}.json`, preRestore)
  });
  line('');
  if (result.backupLocation) line(`Pre-restore backup written to ${result.backupLocation}`);
  line(`Restore complete. ${result.restoredCounts.people} people, ${result.restoredCounts.submissions} submissions now live at ${plan.namespace}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) { line(USAGE); return; }
  if (args.out !== undefined && args.file !== undefined) throw new Error('Pass either --out (export) or --file (restore), not both.');
  if (args.out !== undefined) { await runExport(args); return; }
  if (args.file !== undefined) { await runRestore(args); return; }
  line(USAGE);
  throw new Error('Nothing to do: pass --out <path> to export or --file <path> to restore.');
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  stderr.write(`\nruntime-state failed: ${message}\n`);
  if (error && typeof error === 'object' && 'details' in error && error.details) {
    stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exitCode = 1;
});

