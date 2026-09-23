# Claude Code handoff — AI Startup School

A new Claude Code session can continue from here without the previous chat history.
No secrets are stored here. Never add tokens, passwords, initData, or Redis credentials to this file.

Last updated: 2026-09-23.

## What this is

A real school heading into a pilot (Pilot v1.0). The goal is stability and polish, not new features.

| Surface | Entry | Auth |
| --- | --- | --- |
| Student App (Telegram Mini App) | `index.html` → `src/main.js`, `src/styles.css`, `src/api.js` | Telegram `initData` → Telegram ID → persistent student mapping. **Children never get email/password.** |
| Teacher OS | `teacher.html` → `src/teacher.js` | Separate web auth (`login.html`) |
| Admin | `admin.html` → `src/admin.js` | Separate web auth |
| Parent Cabinet | Telegram bot (`server/telegram/*`, `server/routes/guardian.ts`) | Telegram ID → guardian relation |
| Public marketing | `marketing/` | — |

## Architecture

- Frontend: plain ES modules + Vite (`vite.config.js`, multi-page build: student / teacher / admin / login). No framework.
- Backend: Fastify (`server/app.ts`, routes in `server/routes/*`). On Vercel it runs as one function, `api/backend.ts`; `vercel.json` rewrites `/api/*` to it.
- Repository interface: `server/data/repository.ts`.
  - `MemoryRepository` (`memory-repository.ts`) is the **pilot backend**. Its state lives in the pilot runtime store.
  - `PostgresRepository` exists, but people-directory and notification features throw "unavailable" there. Do not switch the pilot to Postgres.
- Persistence: `server/data/pilot-runtime-store.ts`. In production that means Upstash Redis REST (`RedisRestPilotRuntimeStore`), under the key prefix `PILOT_RUNTIME_REDIS_PREFIX`, or `${SESSION_REDIS_PREFIX}:pilot-runtime:v1` when that is unset. Sessions and login limiting also use Redis.
  - In production, a missing runtime state is an error (`RUNTIME_STATE_MISSING`). The app does **not** reseed. Restore from backup with `npm run runtime:restore` (see `docs/backup-and-recovery.md`).
  - Schema changes go through `migratePilotRuntimeState()`. Always add defaults for new fields there.
- Seed and pilot directory: `server/data/seed.ts` (`PILOT`, `PILOT_STUDENTS`, `PILOT_TEACHERS`, `SEEDED_LESSONS`).

## Pilot data structure (seed)

- Group: «Пілотна група · 2026», timezone Europe/Kyiv, Google Meet `https://meet.google.com/fcj-nfcv-umw`.
- Students (`fullName` is shown to teachers and admins, `displayName` in the Student App):
  - Анохін Ілля → «Ілля» (the dev-login user, `10000000-…-0001`)
  - Максимчук Іван → «Іван»
  - Шамсетдінов Рінат → «Рінат»
  - Прохуренко Юлія → «🐭💗 Мишка». Teacher and admin views must show «Прохуренко Юлія».
- Teachers: Анохін Максим (teacher and mentor), Кривич Вадим (teacher).
- Course: 8 lessons, module «Від AI до запуску продукту».

## Notifications

- `PilotNotification` records in the runtime store drive **both** Telegram delivery and the in-app panel.
- Telegram delivery: `status`, `sentAt`, `attempts`, `idempotencyKey`. The worker is `GET /api/v1/notifications/worker` with `Authorization: Bearer <CRON_SECRET>` and should run hourly from an external scheduler. `vercel.json` must **not** contain an hourly cron (Hobby plan). See `docs/notification-scheduler.md`.
- Policy (`server/data/notification-policy.ts`): catch-up after a late worker, stale messages for rescheduled lessons are skipped, reminders are suppressed for submitted homework, and the weekly digest is driven by the directory.
- In-app read state: `readAt` is separate from Telegram status. Endpoints:
  - `GET /api/v1/notifications`
  - `POST /api/v1/notifications/read` with `{ notificationIds: [] }`; an empty list means all.
  - Only `student_*` types, only for the authenticated student, and never `skipped` ones. Disabled or archived users get 401.
- UI: the bell in the header opens a bottom sheet on mobile and a popover at 601px and wider. The profile link «Сповіщення» opens the same panel. Unread items are marked read on open but stay highlighted until the panel closes.
- Tests: `server/student-notifications.unit.test.ts`, `server/data/notification-*.unit.test.ts`.

## Telegram Mini App specifics

- `src/main.js` calls `applyTelegramViewport()`. It writes `safeAreaInset` + `contentSafeAreaInset` into `--tg-app-safe-top` and `--tg-app-safe-bottom`.
- The CSS uses `--safe-top` and `--safe-bottom`, which take `max(env(safe-area-inset-*), telegram value)`. Use these for anything pinned to the top or bottom, and never hard-code iPhone offsets.
- The bottom nav is fixed, `--nav-height` (66px) + `--safe-bottom`. `.app-shell` pads the bottom by the nav height + 12px + safe area.
- `viewportStableHeight` is deliberately **not** used for layout. `100dvh` + a fixed nav is enough, and a stale value would add empty space.
- Fonts: Inter (body) and Unbounded (display, weights 700/800 only) from Google Fonts. No other families.

## Branches and commits (as of this handoff)

- Production branch on Vercel: **`telegram-vercel-preview`**. Production = `ai-startup-school.vercel.app`, currently at `7b215e6`.
- `main` on origin is an old visual-lock state (`905cae2`). It is not the deploy branch.
- Work chain (on top of `7b215e6`):
  1. `35de848` feat(backup): runtime state export, recovery CLI, environment guards
  2. `a9fec82` fix(gitignore): `.env.example` stays addable
  3. `79ee37e` fix(notifications): catch-up policy and stale message fixes
  4. `14a51ac` feat: persistent student notifications panel
  5. `1f67942` fix(student): pilot mobile polish for Telegram iPhone
  6. this handoff doc
- Active feature branch: `fix/student-mobile-polish` (pushed to origin). The local `telegram-vercel-preview` is at `a9fec82`, which is ahead of origin. **Do not push it without explicit approval.**
- Safety ref of the working tree as Codex left it: `refs/backup/codex-handoff-2026-09-23` (local only).

## Deployment rules

- Never push `main` or `telegram-vercel-preview`, and never deploy production, without explicit approval from the owner.
- Pushing a feature branch creates a Vercel Preview (project `assl`, team `anokhinmaxim2009-5438s-projects`). Check it with `npx vercel ls assl --scope anokhinmaxim2009-5438s-projects`. The Vercel MCP connector cannot see this project; use the CLI.
- Production requires `DATA_BACKEND=memory` + Upstash Redis, `ALLOW_VOLATILE_DATA_IN_PRODUCTION`, JWT keys, `SESSION_TOKEN_PEPPER`, `WEB_AUTH_ACCOUNTS_JSON`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET`. Dev auth and ephemeral JWT are rejected in production (`server/config/env.ts`).
- Scope Redis prefixes per environment. A Preview must never share the production runtime prefix.
- Before any production deploy: `npm run runtime:export` backup (see `docs/backup-and-recovery.md`).

## Commands

```bash
npm test               # vitest unit tests (172 at handoff)
npm run typecheck
npm run build:all      # vite build + server tsc
# local dev: in-memory, no Redis (dotenv reads .env only; .env.local just holds VERCEL_OIDC_TOKEN)
NODE_ENV=development DATA_BACKEND=memory DEV_AUTH_ENABLED=true DEV_EPHEMERAL_JWT=true \
  SESSION_TOKEN_PEPPER=local-dev npx tsx server/index.ts
npx vite --host 127.0.0.1 --port 5173      # proxies /api → :3000, dev login = Анохін Ілля
npm run qa:mobile      # CDP screenshots via local Chrome (needs both servers)
```

Mobile QA widths: 320, 360, 375, 390, 393, 402, 430. Check `document.documentElement.scrollWidth === clientWidth === innerWidth`, that the last content sits above `.bottom-nav`, and that touch targets are 44px or larger. Screenshots go to `screenshots/`, which is untracked. **Do not commit it**, and do not commit `audit/`, `*.log`, or `*.patch` either.

## What NOT to break

- The pilot critical paths:
  - Student: Telegram → Home → lesson → Meet → homework → submit → teacher review → grade/feedback → progress → project/portfolio.
  - Teacher: login → students → lesson → attendance → homework → review → feedback.
  - Admin: people → Telegram binding → guardian relations → lesson/runtime management.
  - Parent: Telegram → cabinet → learning/homework/progress/attendance/feedback/project → consultation request.
- Telegram auth architecture, the parent cabinet, backend notification semantics (idempotency, catch-up, `readAt` vs delivery), runtime-store persistence and migrations, and production data.
- Visual identity: dark navy, yellow `#ffe436`, cyan, and pink accents, with the Inter + Unbounded pair. No redesigns, glassmorphism, or random gradients. Teacher OS, Admin, and Marketing visuals are out of scope unless asked.
- Tenant isolation: every student and guardian query is scoped to `request.auth.userId`.

## Known blockers and open items

- P0: none known in code. Before inviting students, confirm on a **real iPhone in Telegram** that the fullscreen header clears «Закрити» and «⋯». This was verified only with an emulated `safeAreaInset`/`contentSafeAreaInset` stub.
- P1: the notification worker needs an external hourly scheduler configured and monitored. Production `telegram-vercel-preview` is still at `7b215e6` and does not yet include backup, reliability, notifications, or polish.
- P1: `fix/notification-reliability` and `fix/student-mobile-polish` need owner review, then a merge into `telegram-vercel-preview` (fast-forward is possible).
- P2: the AI mentor page (`#ai`) is outside the nav and was not polished. The error-state retry re-runs full auth.
