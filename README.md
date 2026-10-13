# AI Startup School — Telegram Mini App

Mobile-first Student App and education platform foundation for AI Startup School. The approved Mini App is backed by Fastify, PostgreSQL/Supabase RLS, server-validated Telegram authentication, live classes, attendance, homework, projects, private portfolios, mentor booking, guardian reporting, XP, achievements, and a provider-neutral AI boundary.

## Screens
- Home
- Learning
- Project
- Portfolio
- Profile

Students have an AI assistant (top bar ✦ and Profile) that talks to real models through the school's own provider connections, with server-side token allowances managed in Admin OS. Setup, accounting rules and security: [docs/AI-ASSISTANT.md](docs/AI-ASSISTANT.md). V2 domain and security documentation starts at [docs/product-v2.md](docs/product-v2.md).

## Local run
```bash
npm install
copy .env.example .env
npm run dev:server
# in another terminal
npm run dev
```

The checked-in development configuration uses an in-memory repository and an explicitly development-only login. The frontend proxies `/api` to `http://127.0.0.1:3000`. PostgreSQL setup and production requirements are in [docs/backend-setup.md](docs/backend-setup.md).

## Verification

```bash
npm run typecheck
npm test
npm run build:all
```

`npm run test:integration` requires `TEST_DATABASE_URL` with the migration and seed applied; it exits with a clear error when no test database is configured.

## Telegram bot
Copy `.env.example` to `.env`, set `BOT_TOKEN` and the HTTPS `MINI_APP_URL`, then run:

```bash
npm run bot
```

Never commit the bot token or API keys.

## Current pilot management

The deployed pilot uses the existing Redis-backed runtime state. Group management, shared lesson/homework status, archives, Admin session extension and test steps are documented in [docs/ACADEMIC-MANAGEMENT.md](docs/ACADEMIC-MANAGEMENT.md). The separate PostgreSQL foundation is not automatically enabled by these features.

Students see only actual sessions and published homework assigned to their active group. Fresh runtime initialization does not invent assignments. Legacy template cleanup, preserved historical data and verification are documented in [docs/STUDENT-REAL-CONTENT.md](docs/STUDENT-REAL-CONTENT.md).

Group membership, attendance and automatic cross-device refresh are documented in [docs/GROUP-SYNCHRONIZATION.md](docs/GROUP-SYNCHRONIZATION.md). Creating or editing a group never generates lessons; schedule each real lesson explicitly.

Students can attach files to homework; they are stored in a private Vercel Blob store, kept as drafts until sent, and listed for teachers in Teacher OS. Storage setup, limits and security checks are in [docs/HOMEWORK-FILES.md](docs/HOMEWORK-FILES.md). Student App buttons and states follow [docs/STUDENT-UI.md](docs/STUDENT-UI.md).

Lesson credit and project stages require Teacher approval. Students submit written stage responses, project notes and HTTPS links; Teachers can return work with feedback or approve the next stage. See [docs/TEACHER-APPROVAL.md](docs/TEACHER-APPROVAL.md) for APIs, migration and test steps.
