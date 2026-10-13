# AI assistant

Students chat with real models through the school's own API connections. The school buys tokens or credits from providers and resellers; admins hand out internal token allowances to students. These are two different things and the system never converts one into the other on its own.

## What is where

| Part | Files |
|---|---|
| Provider adapters (OpenAI-compatible Chat Completions, Anthropic Messages) | `server/ai/adapters.ts` |
| Key encryption | `server/ai/secret-box.ts` |
| Balances, reservations, chats, usage counters (Redis Lua + in-memory twin) | `server/ai/store.ts` |
| Admin logic: providers, models, access, tokens, resources, analytics | `server/ai/service.ts` |
| Student chat and streaming | `server/ai/chat.ts` |
| HTTP routes | `server/routes/ai.ts` |
| Streaming Vercel function | `api/ai-stream.ts` (+ rewrite in `vercel.json`) |
| Student OS screen | `src/ai-chat.js`, `src/ai-markdown.js`, `src/ai-chat.css` |
| Admin OS sections | `src/admin-ai.js`, `src/admin-ai.css` |
| Test doubles | `server/ai/testing/` (Redis emulator running the real Lua, mock provider over HTTP) |

## Data

Everything lives in Upstash Redis under `AI_REDIS_PREFIX` (default `SESSION_REDIS_PREFIX + ':ai:v1'`, so Production and Preview stay separate). No database migration is needed: keys are created on first use.

| Key | Contents |
|---|---|
| `providers`, `models`, `access`, `packages` (hashes), `settings` | configuration; API keys and auth headers only as AES-256-GCM ciphertext |
| `bal:{student}` | `balance`, `reserved`, `used`, `approxUsed`, `inputUsed`, `outputUsed`, `requests`, `blocked`, `monthly`, `period`, `lastActivity`, `lastModel` |
| `res:{student}` | in-flight reservations: `amount:inputEstimate:expiresAt` |
| `done:{request}` | settled request marker (24 h) — a request can be charged once |
| `ledger`, `ledger:{student}` | journal: grants, sets, resets, blocks, monthly renewals (global) and every charge (per student) |
| `usage`, `errors` | last 2000 requests and 200 provider errors |
| `stats:d:{day}`, `stats:h:{hour}` | counters for analytics (Kyiv time), kept 400 days / 3 days |
| `conv:{student}`, `msgs:{conversation}` | chats and messages, per student |

## Honest token accounting

1. Before calling the provider the server estimates the prompt (o200k tokenizer + 20 % margin) and **reserves** `estimate + max answer tokens` atomically in Redis. If the balance cannot cover a minimal answer the request is refused; parallel requests share the same balance and can never overspend it.
2. The answer is streamed. The provider's own `usage` is read from the stream: OpenAI-compatible `prompt_tokens` (cached included) and `completion_tokens` (reasoning included); Anthropic `input_tokens + cache_creation + cache_read` and `output_tokens`. Reasoning and cached tokens are also stored separately for analytics.
3. The request is **settled** atomically: the real total is charged, capped at what the balance still holds (a balance never goes below zero; any excess is recorded as `uncharged`), the rest of the reservation is released.
4. When the provider reports no usage (some gateways; stopped or broken streams) the charge is an estimate of the prompt plus the text actually received, flagged as approximate in the message, the journal, the admin table and analytics.
5. A provider error before any text costs the student nothing. A reservation that is never settled (crashed function) expires after 6 minutes and charges only its prompt estimate.
6. The client never sends token counts; the request id is derived on the server from the student id and a client UUID, so a retried request runs once.

## Files: ZIP both ways

**Student → AI.** The paperclip in the composer attaches one ZIP (up to 5 MB, up to 3 per message through the API).
- The browser uploads it straight to the private Blob store (presigned PUT, as for homework).
- The server checks the size and opens the archive.
  - It reads only text files: UTF-8, no NUL bytes, up to 1 MB each.
  - Its limits: 200 files, 250 000 characters for the model, 8 MB unpacked. Declared sizes are checked before inflating, and inflation is capped, so a small "ZIP bomb" cannot expand.
  - It skips binaries, `node_modules`, `.git` and other build folders, lock files, `.env` files and unsafe paths, and reports each skip with its reason.
- The text is kept in Redis (`att:{id}`) and added to the student's message for the model. The model sees it again in later turns while it fits the model's context limit.
- Tokens are charged as usual; the student sees the estimate before sending.
- An archive is sent once. Deleting the chat deletes it. Unsent uploads are removed after 24 h.

**AI → student.** The system prompt tells the model to write each file as a code block whose info string names the path (```` ```js src/app.js ````).
- When an answer contains such blocks, the message gets a «Завантажити ZIP» button.
- If the model puts a standalone filename directly above a language-only block (for example, `📄 index.html`), that label is also accepted. Markdown headings, numbered labels, and inline-code/bold filenames are supported; prose and unsafe paths are not inferred as filenames. Blocks must be closed.
- Reopening a conversation recomputes archive metadata for saved answers, so older replies in this format can be downloaded without generating or charging for another answer. Stored messages are not rewritten.
- The server builds the ZIP from that message on demand: paths sanitised, up to 100 files and 2 MB.
- It serves the ZIP through a signed link that expires in 10 minutes and names one message of one student. The link carries no session, because Telegram's own downloader fetches it.
- Inside Telegram the app calls `WebApp.downloadFile` (Bot API 8.0). The response carries `Content-Disposition: attachment` and `Access-Control-Allow-Origin: https://web.telegram.org`, as Telegram asks. In a browser it is an ordinary download.

Context sizes matter for archives: the default model context is 16 000 tokens. For project archives, raise «Макс. токенів контексту» of the model in Admin OS. For Claude Haiku 5.5, stay under 100 000 per request: above that the per-token price is five times higher.

## Environment

| Variable | Needed | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | already set | storage |
| `AI_SECRETS_KEY` | recommended | 32 random bytes, base64 — encrypts provider keys. Without it the key is derived from `SESSION_TOKEN_PEPPER`; rotating either one means re-entering provider keys. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `AI_REDIS_PREFIX` | optional | separate namespace; must keep the Production/Preview markers |

No provider keys go into environment variables: they are entered in Admin OS and stored encrypted.

## Connecting a provider (Admin OS → ШІ · Провайдери)

1. **Додати провайдера**: name, protocol (`OpenAI-compatible` for OpenAI, OpenRouter, DeepSeek, Qwen/DashScope compatible mode, Groq, Together, most resellers; `Anthropic` for the Messages API), Base URL (HTTPS, public host), API key, optional extra auth headers (`Name: value` per line), optional balance method (OpenRouter `/credits`, DeepSeek `/user/balance`).
2. **Перевірити зʼєднання** — calls `GET /models` with the key.
3. **Моделі з API** — lists what the provider serves; **Додати** creates the model disabled. Providers without `/models`: **Додати модель** with the exact model id from their docs.
4. Edit the model: label for students, family, output/context limits, tariff per 1M tokens (optional, for cost estimates), optional fallback model.
5. **Увімкнути** — the server sends a real test request through the API; only a model that answered becomes visible to students. **Основна** sets the default model.
6. More keys for the same provider (**Додати ключ**) are tried in order when one fails with an auth, quota or rate-limit error, before any text was streamed. The fallback model is tried once under the same rule, and only if the student is allowed to use it.

## Giving a student tokens (ШІ · Токени)

- **+100K / +500K / +1M / +5M** next to a student, or **Керувати** for a custom amount, set a new balance, reset to zero, block or unblock, monthly auto-renewal (the balance is set to the limit at the start of each Kyiv month; unused tokens do not roll over), per-student models and the student's journal.
- **Видати групі** adds or sets the same amount for every active student of a group in one journaled batch.
- **Моделі групи** / **Моделі учня**: a student rule overrides the group rule; no rule means every enabled model.

## Purchased resources (ШІ · Ресурс API)

Record each purchase: provider, what was bought (tokens, provider credits or money), amount, cost, date, expiry, and optionally the remaining figure from the provider's dashboard. The page shows bought, used (from usage counters since the purchase date; money packages from model tariffs), estimated remaining, confirmed remaining (manual or provider API, with its date), allowances given to students, and warnings for low, expired or over-allocated resources. Estimates are never shown as the provider's confirmed balance.

## Security

- Students reach only their own chats and balance; ids come from the session, foreign ids answer 404.
- Admin endpoints require the admin role and log unauthorized attempts as security events.
- Keys and auth headers never leave the server; responses carry only the last four characters.
- Provider Base URLs must be HTTPS and public (local `http://127.0.0.1` only on a developer machine).
- Provider error messages are shown to admins with key-like strings removed.
- Students' names, ids and Telegram data are not sent to providers; only the system prompt and the conversation.
- Markdown from models is rendered by a whitelist renderer: HTML is escaped, links are limited to http(s)/mailto.
- Rate limits: per student requests per minute and concurrent answers (settings), plus route limits.

## Testing

```bash
npm test
```

- `server/ai/ai-store.unit.test.ts` runs every balance rule twice: against the in-memory store and against the real Lua scripts in a Lua VM (`server/ai/testing/redis-emulator.ts`): reservations, settlement, never negative, 20 parallel reservations, duplicates, blocking, concurrency and rate caps, expired reservations, monthly renewal, journal.
- `server/ai/adapters.unit.test.ts` talks HTTP to `server/ai/testing/mock-provider.ts`: streaming, usage parsing, missing usage, `max_completion_tokens` retry, errors, key redaction, stop, Anthropic, balances.
- `server/ai-assistant.unit.test.ts` runs the whole app: admin setup, a model that does not exist is refused, first grant, exact charge, history, isolation between students, repeated requests, parallel students, fallback and provider failures, approximate usage, stop, blocking, group access, group grants, resources, and the streaming fetch handler.

A real provider was not called in tests (no real key is used). After deploying, connect your provider, press **Перевірити зʼєднання**, enable a model (it sends one real request) and send one message from Student OS.
