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

Generate a suitable secret locally, store it in Vercel, redeploy, and register the webhook once:

```powershell
npm run bot:set-webhook -- https://ai-startup-school.vercel.app/api/telegram/webhook
```

The helper prompts for the bot token and webhook secret with hidden input. Neither value is accepted as a command-line argument or written to the repository. Registration keeps pending updates and subscribes only to message updates required by `/start`, `/school`, and `/id`.
