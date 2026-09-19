# Admin Control Center

The Admin application is a separate Vite entry at `/admin.html`. It preserves the Student App and Teacher OS entries and uses only the authenticated BFF boundary under `/api/v1/admin/`.

## Navigation

- Огляд: actionable school metrics and configuration health.
- Учні, Викладачі, Батьки, Групи: scoped operational directories and account state.
- Заняття: schedule inspection and auditable attendance correction.
- Домашні роботи: publication, submission, review, and revision counts.
- Проєкти, Портфоліо: stage/progress and explicit `PRIVATE` / `SHAREABLE` / `PUBLIC` states. Private is the default.
- Менторство, Звіти, Сповіщення: bookings, report approval/delivery state, and a payload-free outbox projection.
- Користувачі: safe account and active-session metadata; raw tokens and hashes never leave the server.
- Система: read-only, allowlisted, server-paginated Data Explorer. It has no SQL input and no generic mutation API.
- Безпека: backend-generated health, deterministic security events, and administrative audit history.

## Privileged API boundary

Every endpoint first validates the ES256 access token, then verifies that its server-side session remains active and that the current database user is active. Admin routes additionally require the current role to be `admin`; the role is never accepted from request bodies, local storage, or query parameters.

Reads:

- `GET /api/v1/admin/bootstrap`
- `GET /api/v1/admin/search?q=`
- `GET /api/v1/admin/explorer/:entity?page=&pageSize=&sort=&direction=&q=`

Explicit mutations:

- account enable/disable/archive;
- attendance correction with a reason;
- portfolio visibility change with a reason;
- guardian relationship revocation;
- eligible parent-report resend after checking an active relationship;
- session-family revocation.

Mutations use strict DTO allowlists, confirmation in the UI, server authorization and validation, transactional PostgreSQL functions, and an audit event with the request correlation ID. Teacher workflows remain the normal path for teaching operations.

## Local QA

Use the seeded admin UUID `14000000-0000-4000-8000-000000000001` as `DEV_USER_ID` with development auth. Development auth is rejected in production. Production Admin login must be connected to a standard web identity provider with MFA/passkey/TOTP support; no custom MFA is implemented here.

## External setup

Apply all migrations and seed data to a non-production test project first. Configure the production identity provider and MFA, private storage buckets and signed access, notification worker, monitoring/alerting, backups, HTTPS proxy trust, explicit origins, and persistent signing keys. Run the RLS integration suite against that environment before release.
