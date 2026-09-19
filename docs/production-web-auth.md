# Production web authentication

Teacher OS and Admin Control Center use the existing application JWT, refresh-cookie, session rotation, revocation, and repository RBAC flow. Credentials are an environment-only identity directory; refresh-session state and login throttling are stored in Upstash Redis through its REST API. Student Telegram authentication and student bindings are independent and unchanged.

## Required Vercel configuration

Create one Upstash Redis database from the Vercel Marketplace and make it available to the Production deployment. Configure these server-side Production variables:

- `UPSTASH_REDIS_REST_URL` — HTTPS REST endpoint.
- `UPSTASH_REDIS_REST_TOKEN` — REST token.
- `SESSION_REDIS_PREFIX` — use `aiss:production:sessions:v1`.
- `WEB_AUTH_ACCOUNTS_JSON` — JSON array described below.

Keep the existing `APP_JWT_PRIVATE_KEY_BASE64`, `APP_JWT_PUBLIC_KEY_BASE64`, `SESSION_TOKEN_PEPPER`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_STUDENT_BINDINGS_JSON` values unchanged. Never prefix these variables with `VITE_` and never expose them to browser code.

## Create credentials

Choose each email privately. Generate each password hash in a local interactive terminal:

```powershell
npm run auth:hash-password
```

The command accepts the password only through hidden terminal input, asks for confirmation, and prints one scrypt hash. Do not put the password or hash in Git, shell history, tickets, or chat.

Build `WEB_AUTH_ACCOUNTS_JSON` as one compact JSON value:

```json
[
  {"userId":"12000000-0000-4000-8000-000000000001","email":"OWNER_CHOSEN_EMAIL","passwordHash":"GENERATED_SCRYPT_HASH"},
  {"userId":"12000000-0000-4000-8000-000000000002","email":"OWNER_CHOSEN_EMAIL","passwordHash":"GENERATED_SCRYPT_HASH"}
]
```

The first internal identity is Анохін Максим (`admin`, with Teacher OS and mentor access). The second is Кривич Вадим (`teacher`). Email matching is case-insensitive. Passwords must contain 14–128 characters.

After setting all variables for Production, redeploy the commit that introduced web authentication (or promote its verified Preview deployment). Do not reuse the same `SESSION_REDIS_PREFIX` for unrelated deployments sharing one Redis database.

## Entry points and verification

- Teacher: `/teacher.html` (unauthenticated users are redirected to `/login.html?next=/teacher.html`).
- Admin: `/admin.html` (unauthenticated users are redirected to `/login.html?next=/admin.html`).

Verify that Vadym can enter Teacher OS but receives no Admin access; Maksym can enter both. Click **Вийти**, then confirm that browser Back/Refresh cannot reopen protected data. In Admin → Користувачі, revoke an active test session and confirm its next API request returns `401`. A revoked or expired refresh cookie must not create a new access token.
