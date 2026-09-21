# Telegram bot webhook on Vercel

Production updates are delivered to the existing grammY bot through:

```text
POST https://ai-startup-school.vercel.app/api/telegram/webhook
```

The endpoint is routed through the existing Vercel catch-all function and Fastify application. It rejects requests unless `X-Telegram-Bot-Api-Secret-Token` matches the server-only `TELEGRAM_WEBHOOK_SECRET`. The local `npm run bot` command remains a development-only long-polling entry point and must not run against the Production bot while its webhook is configured.

Required Production environment variables:

- `TELEGRAM_BOT_TOKEN` — existing BotFather token.
- `MINI_APP_URL=https://ai-startup-school.vercel.app` — URL used by `/start` and `/school` buttons.
- `TELEGRAM_WEBHOOK_SECRET` — 16–256 random characters from `A-Z`, `a-z`, `0-9`, `_`, or `-`.
- `CRON_SECRET` — long random server-only secret used by Vercel Cron as `Authorization: Bearer ...`.
- `PARENT_WEEKLY_REPORT_DAY=0` and `PARENT_WEEKLY_REPORT_HOUR_KYIV=19` — optional weekly digest schedule (Sunday 19:00 Europe/Kyiv by default).

Generate a suitable secret locally, store it in Vercel, redeploy, and register the webhook once:

```powershell
npm run bot:set-webhook -- https://ai-startup-school.vercel.app/api/telegram/webhook
```

The helper prompts for the bot token and webhook secret with hidden input. Neither value is accepted as a command-line argument or written to the repository. Registration keeps pending updates and subscribes to `message` and `callback_query` updates required by commands and the Parent cabinet.

The notification worker is exposed at `GET /api/v1/notifications/worker`, protected by `CRON_SECRET`, and scheduled hourly in `vercel.json`. The hourly schedule requires a Vercel plan that supports hourly Cron Jobs; otherwise change the schedule to a supported interval before deploying.
