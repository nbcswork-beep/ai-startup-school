# Notification scheduler

The notification worker is scheduler-agnostic on purpose. It is a plain authenticated HTTP endpoint,
so any external timer can drive it and the project stays on the Vercel Hobby plan.

**`vercel.json` must not contain an hourly cron.** Hobby accounts are limited to daily cron jobs and
an hourly entry fails the deployment. The repository therefore ships no `crons` block at all.

## Endpoint

```text
GET https://ai-startup-school.vercel.app/api/v1/notifications/worker
Authorization: Bearer <CRON_SECRET>
```

The secret travels in the `Authorization` header and is compared in constant time. Never put it in
the URL, a query string, a redirect target or a commit — anything in a URL ends up in access logs,
browser history and referrer headers.

Recommended cadence: **once per hour**. The worker is designed to tolerate a late or missed run, so a
slightly irregular schedule is fine; see *Catch-up behaviour* below.

## Responses

| Status | Body | Meaning | Action |
| --- | --- | --- | --- |
| `200` | `{"claimed":N,"sent":N,"failed":N}` | Pass completed. `claimed` is how many messages were picked up, `sent` delivered, `failed` will be retried. | None. `claimed: 0` is normal and simply means nothing was due. |
| `401` | `{"error":{"code":"CRON_UNAUTHORIZED"}}` | Missing or wrong `Authorization` header. | Check the header format is exactly `Bearer <secret>` and that `CRON_SECRET` matches the Vercel value. |
| `503` | `{"error":{"code":"NOTIFICATION_WORKER_NOT_CONFIGURED"}}` | `CRON_SECRET` or `TELEGRAM_BOT_TOKEN` is not set on the deployment. | Set the missing variable in Vercel and redeploy. |
| `503` | `{"error":{"code":"RUNTIME_STATE_MISSING"}}` | Production runtime state key is absent. | Do **not** ignore this. Restore from a snapshot — see `docs/backup-and-recovery.md`. |
| `5xx` | — | Upstash or Telegram was unreachable. | Safe to ignore a single occurrence; the next run retries. Investigate if it persists. |

A run that returns `200` with `failed > 0` is not an outage: Telegram rejections are retried with
exponential backoff (5, 10, 20, 40, 80 minutes) up to five attempts.

## Running it twice is safe

Every message carries a persistent idempotency key, and claiming is a compare-and-set against the
shared runtime state. Two schedulers firing at the same instant, a retried webhook, or a manual run
next to the hourly one all produce the same result: each message is delivered once. Tests cover the
same-instant and parallel cases.

## Catch-up behaviour

A late run does not lose messages. Each notification type carries a relevance window, and the worker
delivers anything whose window is still open:

| Notification | Queued when | Still delivered until |
| --- | --- | --- |
| Lesson in 24h | 24h before the lesson | 1h before the lesson |
| Lesson in 1h | 1h before the lesson | the lesson starts |
| Homework published | at publish time | the homework deadline |
| Homework deadline | 24h before the deadline | the deadline |
| Homework overdue | at the deadline | 7 days after the deadline |
| Homework reviewed | when the teacher submits the review | 7 days later |
| Absence (guardian) | when attendance is confirmed | 3 days later |
| Reschedule / cancellation (guardian) | when the teacher changes the class | the lesson slot, minimum 2h |
| Weekly digest (guardian) | Sunday 19:00 Europe/Kyiv | 48h later |

So a scheduler that is three hours late still sends everything. A scheduler that is a day late still
sends the weekly digest, the overdue reminder and the absence alert, but correctly withholds
"tomorrow you have a lesson" for a lesson that has already started. Anything withheld is recorded
with a reason rather than silently dropped.

Catch-up reaches back to the previous run minus a six-hour grace, capped at seven days. A deployment
whose worker has never run reaches back 24 hours, so a first run never floods the queue with history.

## Manual test

Safe to run against production: the endpoint only delivers what is genuinely due, and a run outside
the schedule cannot duplicate anything.

```bash
# Read the secret from the environment; do not paste it on the command line,
# where it would land in shell history.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-startup-school.vercel.app/api/v1/notifications/worker
```

```powershell
curl.exe -sS -H "Authorization: Bearer $env:CRON_SECRET" `
  https://ai-startup-school.vercel.app/api/v1/notifications/worker
```

Expect `200` and a JSON summary. To confirm authentication is actually enforced, repeat without the
header and expect `401`.

## Checking that the scheduler is alive

A silent worker is the failure mode that hides every other notification problem, so Admin Control
Center shows the last run under the health checks:

- **ok** — ran within the last 75 minutes
- **warning** — 75 minutes to 3 hours ago
- **required** — over 3 hours ago, or never

If it says *never*, the external scheduler has not been connected yet.

## Diagnosing a message that did not arrive

The notification list in Admin Control Center carries a status and a safe reason code per message.
No bot token, cron secret, Redis credential or raw Telegram payload is ever stored.

| Reason | What happened |
| --- | --- |
| `HOMEWORK_ALREADY_SUBMITTED` | The student submitted before the reminder went out. |
| `HOMEWORK_ALREADY_REVIEWED` | The work had already been graded. |
| `CLASS_CANCELLED` | The lesson was cancelled after the reminder was queued. |
| `CLASS_RESCHEDULED` | The lesson moved; the stale copy was discarded and a correctly timed one queued. |
| `HOMEWORK_RESCHEDULED` | The deadline moved after the reminder was queued. |
| `REMINDER_WINDOW_EXPIRED` | Delivered too late to be meaningful. |
| `RECIPIENT_INACTIVE` | The account was disabled or archived. |
| `STUDENT_INACTIVE` | The child the message is about is no longer active. |
| `TELEGRAM_BINDING_MISSING` | No Telegram account is linked to the recipient. |
| `GUARDIAN_RELATION_REVOKED` | The guardian is no longer linked to that child. |
| `STALE_UNVERIFIED` | Queued before relevance windows existed and could not be verified. |
| `ENTITY_MISSING` | The lesson or homework it referred to no longer exists. |
| `TELEGRAM_RATE_LIMIT` / `TELEGRAM_TEMPORARY` / `TELEGRAM_NETWORK` | Telegram was unavailable; retried automatically. |
| `TELEGRAM_REJECTED` | Telegram refused the message, usually because the user blocked the bot. |

## Setup checklist

1. Set `CRON_SECRET` in Vercel for Production (long random value, marked sensitive).
2. Confirm `TELEGRAM_BOT_TOKEN` is set for Production.
3. Point an external hourly scheduler at the endpoint with the `Authorization` header.
4. Run the manual test above and confirm `200`.
5. Confirm Admin Control Center shows the worker as **ok** within the hour.
