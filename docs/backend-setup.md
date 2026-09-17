# Backend setup

## Local development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Keep `NODE_ENV=development`, `DATA_BACKEND=memory`, `DEV_AUTH_ENABLED=true`, and `DEV_EPHEMERAL_JWT=true` for credential-free local work.
4. Run `npm run dev:server` and `npm run dev` in separate terminals.

The memory repository is intentionally forbidden when `NODE_ENV=production`. Development authentication is also unavailable in production.

## Supabase/PostgreSQL

1. Create a Supabase project in the desired region.
2. Apply `supabase/migrations/20260917000100_mvp_v1.sql`.
3. Apply `supabase/seed.sql` for development/demo data. Production content should be loaded through a controlled content process instead.
4. Use the direct or session-pooler PostgreSQL connection string as `DATABASE_URL`; set `DATA_BACKEND=postgres`.
5. Keep the database credential only in the server environment. The browser never receives a Supabase service-role key or database credential.

The API starts each student transaction with role `authenticated` and a request JWT claim containing `app_user_id`. RLS uses that UUID for ownership checks. Completion writes run through security-definer functions that validate ownership, prerequisites, task state, and idempotency before awarding XP.

## Application signing keys

Generate an ES256 key pair using your secret-management system. Store the PKCS#8 private PEM and SPKI public PEM as base64 values in `APP_JWT_PRIVATE_KEY_BASE64` and `APP_JWT_PUBLIC_KEY_BASE64`. Persist these keys across restarts and rotate them deliberately by changing `APP_JWT_KEY_ID` while retaining verification keys for the access-token overlap window.

Access tokens last 10 minutes by default and remain in browser memory. Refresh tokens are opaque, hashed with `SESSION_TOKEN_PEPPER`, stored server-side, rotated on every use, and delivered only as secure HTTP-only SameSite cookies.

## Telegram setup

Set `TELEGRAM_BOT_TOKEN` on the server only. Authentication accepts raw `Telegram.WebApp.initData`, checks the HMAC signature and freshness, then maps the validated Telegram user ID to an internal UUID in `user_identities`. `initDataUnsafe` is never used for authentication.

Set the bot menu/Web App URL to the deployed HTTPS frontend and configure `APP_ORIGINS` to that exact origin. Telegram requires the Mini App to be opened from its Web App context for `initData` to be present.

## AI mentor

V1 uses `AI_PROVIDER=mock`. Messages and conversation context are real and persisted; the provider boundary is `server/services/ai-provider.ts`. A future paid provider must be implemented server-side, with its key in secret storage, age-appropriate safety checks, timeouts, and spend limits. No AI key belongs in Vite environment variables.

## Integration tests

Apply the migration and seed to a disposable database, set `TEST_DATABASE_URL`, then run:

```bash
npm run test:integration
```

The suite switches to the `authenticated` database role with different `app_user_id` claims and verifies cross-student project and conversation isolation.
