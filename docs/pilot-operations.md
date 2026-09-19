# Pilot operational setup

The repository contains four pre-created internal student records and two teacher records. It intentionally contains no Telegram user IDs, email addresses, passwords, invite tokens, or other credentials.

## Telegram student binding (current Vercel memory backend)

Collect each student's numeric Telegram user ID through a verified administrator workflow. Do not collect or store Telegram `initData`; it is a short-lived signed authentication payload, not an account identifier to retain.

Add this server-only Vercel Production variable, substituting the verified numeric IDs:

```text
TELEGRAM_STUDENT_BINDINGS_JSON={"illia":"TELEGRAM_ID","ivan":"TELEGRAM_ID","rinat":"TELEGRAM_ID","yuliia":"TELEGRAM_ID"}
```

The accepted keys map to these internal records:

| Key | Internal student | Internal user ID |
| --- | --- | --- |
| `illia` | Анохін Ілля | `10000000-0000-4000-8000-000000000001` |
| `ivan` | Максимчук Іван | `10000000-0000-4000-8000-000000000002` |
| `rinat` | Шамсетдінов Рінат | `10000000-0000-4000-8000-000000000003` |
| `yuliia` | Прохуренко Юлія | `10000000-0000-4000-8000-000000000004` |

Mark the variable as sensitive, scope it to Production, and redeploy. Production fails closed: a valid Telegram account that is not in this mapping receives `TELEGRAM_ACCOUNT_NOT_LINKED` and cannot create an extra demo student.

When PostgreSQL becomes the active backend, insert the same verified mapping into `public.user_identities` from a privileged server/admin process (`provider = 'telegram'`, `provider_subject = numeric Telegram ID`). Do not put that mapping in seed files or client code. Production PostgreSQL also rejects an unknown Telegram identity instead of auto-provisioning it.

## Teacher accounts

Seeded internal users:

- `12000000-0000-4000-8000-000000000001` — Анохін Максим, teacher and mentor
- `12000000-0000-4000-8000-000000000002` — Кривич Вадим, teacher

Invite each teacher to the configured production web identity provider (the architecture reserves `supabase_auth`) using the provider's one-time invitation or password-reset flow. The teacher chooses a password outside Git. Then bind the returned provider subject to the matching internal ID in `public.user_identities` with `provider = 'supabase_auth'`.

Development authentication remains disabled in Production. The current codebase still needs its approved production web-identity login adapter before Teacher OS can consume those invitations; do not enable development auth as a workaround.

## Verification checklist

1. Redeploy after setting the Telegram binding variable.
2. Open the Mini App from each student's Telegram account and verify a unique profile.
3. Verify only Julia's Student Profile says `🐭💗 Мишка`; Teacher/Admin views retain `Прохуренко Юлія`.
4. Verify eight lessons, seven homework items, mentor `Анохін Максим`, and the four-person pilot group.
5. Tap the live-class button and verify it opens `https://meet.google.com/fcj-nfcv-umw`.
