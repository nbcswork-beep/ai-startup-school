# AI Startup School — Telegram Mini App

Mobile-first Student App for AI Startup School. The approved Mini App interface is backed by a Fastify API, PostgreSQL/Supabase schema, server-validated Telegram authentication, progress, projects, XP, achievements, and a provider-neutral AI mentor boundary.

## Screens
- Home
- Learning
- Project
- AI mentor
- Profile

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
