# Backup and recovery

Supabase or another managed PostgreSQL provider does not by itself prove that the required backup policy exists. Production owners must configure and verify it.

## Required coverage

- PostgreSQL point-in-time recovery or scheduled encrypted backups with documented retention.
- Private object storage inventory/versioning or provider backup appropriate to homework, project, portfolio, and class materials.
- Secure copies of migration files and deployment configuration; secret values remain in the secret manager, not backups of the repository.
- Audit/security-event retention aligned with privacy and incident-response needs.

## Restore test

At least quarterly, restore to an isolated environment, apply/verify migrations, compare row counts and integrity constraints, test private-file references, then run unit and RLS integration suites. Record restore point, duration, gaps, operator, and deletion of the isolated copy. Never connect restored notification outbox workers to production recipients.

## Migration recovery

Migrations are forward-only by default. Before a high-risk migration, take/verify a recoverable database point and document the compensating migration. Do not use destructive cascades to fix deployment errors. If a release fails, stop writers where needed, preserve evidence, restore or apply the reviewed compensating migration, and verify RLS/grants before reopening access.

## Key rotation

Maintain a rotation runbook for JWT signing keys (with a bounded verification overlap), refresh-token pepper (forces reauthentication), Telegram bot token, database password, storage credentials, and external providers. Rotation must include revocation, deployment order, monitoring, and rollback criteria without recording secret values.
