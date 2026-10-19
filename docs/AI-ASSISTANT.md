# AI assistant

Students chat with real models through the school's own API connections. The school buys tokens or credits from providers and resellers; admins hand out internal token allowances to students. These are two different things and the system never converts one into the other on its own.

## What is where

| Part | Files |
|---|---|
| Provider adapters (OpenAI-compatible Chat Completions, Anthropic Messages) | `server/ai/adapters.ts` |
| Key encryption | `server/ai/secret-box.ts` |
| Balances, reservations, chats, usage counters (Redis Lua + in-memory twin) | `server/ai/store.ts` |
| Admin logic: providers, models, access, tokens, resources, analytics | `server/ai/service.ts` |
| Student chat, answer jobs, attachments, agent runs | `server/ai/chat.ts` |
| Agent loop, skills, plugins | `server/ai/agent/` |
| Documents: read and write PDF, Word, Excel, CSV, PowerPoint, text | `server/ai/documents/` |
| Telegram «answer ready» notice | `server/ai/notifier.ts` |
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
| `conv:{student}`, `msgs:{conversation}` | chats and messages, per student; a chat also keeps its lesson/homework link, its memory summary and the student's 👍/👎 votes |
| `runner:slots` | jobs handed to Cloud Run workers and until when (the worker cap) |
| `rl:{provider}:{minute}` | requests sent to a provider in that minute, for its shared request limit (kept 130 s) |
| `job:{id}`, `job:{id}:text`, `jobreq:{request}`, `jobs:active` | answer jobs: status, steps, files, confirmation; the text written so far; request → job; jobs still needing attention (kept 7 days) |
| `atts:{student}`, `att:{id}` | attached files: metadata and the text read from them |
| `gen:{id}` | files the agent made: their source; the file is rebuilt on download |
| `skills`, `plugins` | the school's skills and installed plugins (secrets sealed) |

## Honest token accounting

1. Before calling the provider the server estimates the prompt (o200k tokenizer + 20 % margin) and **reserves** `estimate + max answer tokens` atomically in Redis. If the balance cannot cover a minimal answer the request is refused; parallel requests share the same balance and can never overspend it.
2. The answer is streamed. The provider's own `usage` is read from the stream: OpenAI-compatible `prompt_tokens` (cached included) and `completion_tokens` (reasoning included); Anthropic `input_tokens + cache_creation + cache_read` and `output_tokens`. Reasoning and cached tokens are also stored separately for analytics.
3. The request is **settled** atomically: the real total is charged, capped at what the balance still holds (a balance never goes below zero; any excess is recorded as `uncharged`), the rest of the reservation is released.
4. When the provider reports no usage (some gateways; stopped or broken streams) the charge is an estimate of the prompt plus the text actually received, flagged as approximate in the message, the journal, the admin table and analytics.
5. A provider error before any text costs the student nothing. A reservation that is never settled (crashed function) expires after 6 minutes and charges only its prompt estimate.
6. The client never sends token counts; the request id is derived on the server from the student id and a client UUID, so a retried request runs once.

## Answers run on the server (background jobs)

Every answer is a **job** in Redis, not a browser connection. The streaming function generates it and writes the text to storage every second; the app only watches.

- Closing the Mini App, switching apps, locking the phone or losing the network does not stop the answer. Only **«Стоп»** does (`POST /api/v1/ai/jobs/:id/stop`); the generating function sees the flag within a second.
- A reopened app finds the running job (`GET /api/v1/ai/conversations/:id` returns `job`; the list marks chats «Генерується», «Готово», «Помилка») and follows it with `GET /api/v1/ai/jobs/:id?from=<bytes>`. A retried request with the same `clientRequestId` joins the existing job instead of starting a second answer.
- A job whose function died (crash, the 300 s limit) goes quiet; after 60 s it is finished from what reached storage: the partial answer is saved as «Помилка · відповідь перервалася» and charged by estimate. This recovery runs when the student opens the chat, after every answer, and from the notification worker (`GET /api/v1/notifications/worker`, the external hourly scheduler).
- Exactly one finisher wins (a Lua claim), and settlement is idempotent, so a job is charged once.
- **Telegram notice.** When an answer finishes while the student is not watching, the bot sends «✅ Ваша відповідь від ШІ готова!» (or a short failure notice) with an «Відкрити чат» button that opens the Mini App on that chat (`MINI_APP_URL?ai=<chat id>`). The text never contains the question, the answer or names. No notice when the student was watching (the stream was open, or the app asked within 10 s) or pressed «Стоп». One notice per job, with three retries on Telegram errors. The student must have started the bot; otherwise the notice is skipped.

## Documents

Students attach up to 5 files per message: **PDF** (15 MB), **Word .docx**, **Excel .xlsx** (10 MB), **CSV** (5 MB), **PowerPoint .pptx** (20 MB), **.txt / .md** (2 MB), **ZIP** (5 MB). Old `.doc/.xls/.ppt` get a "save as …x" hint.

| Part | Files |
|---|---|
| Format detection, magic bytes, encodings (UTF-8, Windows-1251) | `server/ai/documents/formats.ts` |
| Reading into Markdown | `server/ai/documents/read.ts` (+ `markdown.ts`, `csv.ts`) |
| Building files from Markdown | `server/ai/documents/write.ts` |

- **Reading keeps structure.** Word headings, lists (nested) and tables come out as Markdown (mammoth). Excel sheets and CSV become Markdown tables (exceljs; up to 400 rows × 40 columns per sheet). PowerPoint gives slide titles, bullets, tables and speaker notes. For PDF, lines are rebuilt from text positions and larger lines become headings (unpdf / pdf.js).
- **Bytes must match the format.** A renamed text file is not accepted as PDF or Office, and Office files are checked to be the right kind of ZIP. Archives that would unpack to more than 120 MB are refused, and so are password-protected files.
- **Scanned PDFs** (no text layer) are detected and marked. With a model on the Anthropic protocol (Claude), the PDF itself is sent to the model, which reads the page images: up to 40 pages and 4.5 MB, charged at about 1,600 tokens per page. With other models the student sees a clear message; there is no OCR on the server.
- **Size limit for the model.** Text is capped at 250,000 characters per file. In agent mode the agent reads long files in parts.

**Making files.** The agent writes Markdown, and the server builds real files: **Word** (docx, with headings, numbered and bulleted lists, tables, quotes, code, links); **PDF** (pdfmake with embedded Roboto, so Cyrillic is embedded; page numbers); **PowerPoint** (pptxgenjs; one slide per `##`, real title placeholders, overflowing slides continue, speaker notes from `>` lines); **Excel** (one sheet per table, numbers as numbers, leading zeros kept, frozen header); **CSV** (UTF-8 with BOM so Excel shows Cyrillic); **md**; **txt**.

- **Checking.** Each made file is read back with the same readers as uploads: the agent and the student see e.g. «3 заголовки, 1 табл., кирилиця на місці».
- **Storage and download.** Only the source is stored (`gen:{id}`); the file is rebuilt on download through a signed 10-minute link (`/api/v1/ai/files?token=`), which Telegram's own downloader can fetch. Deleting a chat deletes its files.

## Agent mode

The «Агент» switch in the composer turns on multi-step work. The admin can turn it off for everyone, and per model.

- **Loop** (`server/ai/agent/run.ts`). The model gets the tools of the enabled plugins and either answers or calls tools; the results go back to it. Limits:
  - the step budget («Кроків за одне завдання», default 8);
  - a token budget reserved up front (never more than the balance; charged once with the sum of all calls);
  - the function's time budget;
  - «Стоп».
  Long tool results are shortened to fit the model's context.
- **Steps, not reasoning.** The student sees what happens («Читаю «Тема.docx»», «Створено «Конспект.docx»», «Перевіряю…») with status and errors. The model's own words between tool calls are not shown.
- **Confirmation.** A tool with the `network` permission (any outside service) stops and asks the student, naming exactly what will be sent and where («Дозволити / Відхилити», 2 minutes, then skipped). The run survives the app being closed and reopened while it waits.
- **Safety.**
  - The tool set of a run comes from the school's configuration only.
  - Text inside documents is data: the prompt says so, and nothing in a document can enable a plugin or a permission.
  - A model without tool support gets a clear error; mark such models in Admin OS («Режим агента» in the model settings).

## Skills (SKILL.md)

A skill is a name, description, «when to use», instructions and a list of tools:

```
---
name: Конспект
description: Стислий структурований конспект теми або документа.
when: Учень просить конспект, тези, стислий виклад…
tools: read_file, create_file
---
Інструкції в Markdown…
```

- **Built-in skills:** Конспект, Пояснення теми, Підготовка до іспиту, Оформлення доповіді, Презентація. They can be edited, disabled, or reset to the shipped version.
- **Admin OS → ШІ · Агент:** create, edit, enable/disable, delete, import one or several `SKILL.md` files (all or nothing; a skill with the same name is replaced), and export one (`SKILL.md`) or all (ZIP of `name/SKILL.md`).
- **Picked by the student:** its instructions go into the system prompt, and in agent mode only its tools are offered.
- **«Авто» in agent mode:** the agent sees the list of enabled skills and loads one itself (`use_skill`) when the task matches. The message shows which skill was used.

## Plugins

Every tool goes through one interface (`server/ai/agent/plugins.ts`): name, description, JSON Schema, permission, run. The core never changes for a new plugin.

- **Built-in:**
  - «Документи» (core: `read_file`, `create_file`);
  - «Навички» (core: `use_skill`);
  - «Калькулятор» (`calculate`, a safe parser, preinstalled);
  - «Вікіпедія» (`wikipedia_search`, network, not installed by default).
- **Imported plugins** are a JSON manifest:
  - fields: `id`, `name`, `version`, `description`, `permissions` (`network`, `compute`), `baseUrl`, `settings`, `secrets` (with the header to send them in), `tools` (with `http: {method, path}`);
  - a generic runner calls them: HTTPS to public addresses only, no redirects, 15 s timeout, answer cut at 12,000 characters, and always after the student's confirmation.
- **Secrets** are sealed with AES-GCM on the server, never returned to the browser, and opened only for the request that needs them. A plugin with missing secrets cannot be enabled.
- **Admin OS:** install, enable/disable, settings, secrets, remove (the core plugins cannot be removed or disabled).

## Rate-limited providers (free NVIDIA and others)

Any provider can have **«Загальний ліміт запитів за хвилину»** (Admin OS → provider → Редагувати). It is one shared line for all students and all functions:

- Every model call — chat answers, each agent step, memory summaries, admin tests — takes a slot in a sliding one-minute window in Redis (`acquireRateSlot`, one Lua script). When the window is full, the answer **waits in line**. The student sees «У черзі · ≈ N с» and a note that it starts by itself; the job keeps `queuedUntil`, so a reopened app shows the same thing. A wait longer than 90 s ends with «Забагато запитів до ШІ одночасно. Спробуйте за хвилину.»
- A **429** from the provider is retried twice, after the provider's `Retry-After` (or 2 s, then 4 s), and only before any text was streamed. A longer cooldown than 30 s is shown as an error instead.
- An answer stopped or given up **while waiting in line** costs nothing: the provider never received it.
- Default: providers at `https://integrate.api.nvidia.com` get **35 requests per minute** (NVIDIA's free key allows about 40, account-wide); other providers have no limit until one is set. An empty field turns the limit off.

**NVIDIA build (free).** Protocol `OpenAI-compatible`, Base URL `https://integrate.api.nvidia.com/v1`, the `nvapi-…` key. NVIDIA describes the free tier as for development and prototyping, not production; the limit is not published and was observed by users at about 40 requests per minute. Only some models call tools (agent mode) and only vision models read photos — press **Фото й інструменти** on each model.

**Model capabilities.** **Фото й інструменти** sends two tiny real requests: one asks the model to call a tool, one shows it a red square. The model is marked «Режим агента» and «Модель розпізнає фотографії» accordingly (both can also be set by hand in the model's settings). Students' balances are not touched.

**Agent model.** «ШІ · Агент» → **Модель для агента**: agent mode uses this model (a stronger one with tools) unless the student picks another model; plain chat keeps the default model.

## Photos

Students attach **JPG, PNG or WebP** photos (of a page, a board, a task) to models marked as seeing photos; with no such model the app does not offer photos.

- The phone shrinks the photo before upload (longest side 1280 px or less, JPEG, at most 130 KB, camera metadata dropped), so it fits every provider's inline-image limit (NVIDIA's endpoints take about 180,000 base64 characters).
- The server checks the bytes really are that image format and stores the photo privately like any attachment.
- The photo goes to the model as an image part before the text (`image_url` data URL for OpenAI-compatible APIs, an `image` block for Anthropic). A follow-up question sends the latest photo message again, at most 4 images.
- A photo is counted as about 4,096 input tokens in the estimate; the charge is what the provider reports.
- If the chosen model does not see photos, the app switches to one that does, unless the student picked the model themself. The server refuses with «Ця модель не розпізнає фото» either way.

## Answer control

- **Редагувати** (last question only) and **Згенерувати ще раз** (last answer) replace the last exchange. The old pair stays stored but is hidden and no longer sent to the model; it is replaced only after the new answer succeeds. Files of the edited question are kept; new files go in a new message.
- **👍 / 👎** under every answer can be changed or taken back. Admin OS → ШІ · Аналітика → «Оцінки відповідей» counts them per model and skill.

## Chat memory

Long chats do not lose their beginning. After an answer, once 8 or more older messages are not yet summarized, the same model writes a short summary (up to 1,200 characters: goal, decisions, facts, open questions). Later requests send the summary plus the newer messages.

- The summary is charged honestly, together with that answer, and the reservation leaves room for it.
- It never makes the student wait: if the provider's request limit is full, it is skipped and made after a later answer.
- The summary is data for the model, not instructions.
- Admin OS → Налаштування → «Стискати довгі діалоги в памʼять» turns it off.

## Lesson and homework help

- **«Спитати ШІ про цей урок»** on a lesson and **«Допомога ШІ з цим завданням»** on a homework open a new chat linked to it.
- The server loads the material itself (lesson summary and content, homework instructions) with the student's own access rules, and adds it to the system prompt as data. A locked lesson or someone else's homework answers 404.
- A chat stays linked to its lesson or homework; another lesson needs a new chat.
- **Homework hint mode** is always on for homework chats: the assistant asks what the student tried, gives one hint at a time, explains on a different example, and does not hand over a finished solution or file. The built-in skill «Підказки до домашнього» is preselected.

## Cloud Run workers for agent answers (prepared, off by default)

Long agent work can run in Google Cloud Run Jobs instead of the 300-second Vercel function. It is **off** until every `AI_WORKER_*` variable is set on Vercel and an admin picks Cloud Run in Admin OS → ШІ · Провайдери → «Де працює режим агента» (for chosen students or everyone). Plain chat always stays on Vercel.

- Vercel stores the job with a **spec** (text, attachment ids, skill, revision, lesson material; never secrets), reserves tokens, and starts one Cloud Run execution with only `AI_JOB_ID`. It authenticates with Vercel OIDC → Google STS → a short-lived token of a service account that may only run that job.
- The worker (`server/worker/`) takes the job's **lease** (one owner; a crashed worker's job is taken over once), renews it with the token reservation, rebuilds the same prompt with the same code, and runs the same engine. Writes and finishing are fenced by the lease. Continuations after a stage's time budget start on the server, bounded by the same three rounds.
- A job no worker took is handed over again after 10 minutes, then ended without a charge. «Стоп» on a job not yet taken ends it at once, free.
- The worker has no bot token and no roster: it asks Vercel to send the «ready» notice (`POST /api/v1/internal/ai/jobs/:id/notice`, shared secret).
- If Google cannot take a job, or the worker cap (`AI_WORKER_MAX_CONCURRENT`) is full, Vercel answers it as before.

Setup, switch-over and rollback: [CLOUD-RUN-WORKER.md](CLOUD-RUN-WORKER.md).

## Dependencies added

`unpdf` (PDF text), `mammoth` (Word → HTML), `docx` (Word output), `pdfmake` (PDF output with Roboto), `exceljs` (Excel in and out), `pptxgenjs` (PowerPoint output), `marked` (Markdown lexer). All are loaded lazily, only when a document is read or made.

- `npm audit` lists advisories in sub-dependencies on code paths this app does not use: `image-size` (pptxgenjs, images only — none are added), `sprintf-js` (mammoth's command-line tool), `uuid` v3/v5/v6 buffers (exceljs uses v4).
- No new environment variables are needed.

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
| `AI_SECRETS_KEY_NEXT` | for Cloud Run workers | the key secrets get a second copy under (Admin OS → «Підготувати ключі для Cloud Run»); older deployments ignore it. See CLOUD-RUN-WORKER.md |
| `AI_REDIS_PREFIX` | optional | separate namespace; must keep the Production/Preview markers |

No provider keys go into environment variables: they are entered in Admin OS and stored encrypted.

## Connecting a provider (Admin OS → ШІ · Провайдери)

1. **Додати провайдера**: name, protocol (`OpenAI-compatible` for OpenAI, OpenRouter, DeepSeek, Qwen/DashScope compatible mode, Groq, Together, most resellers; `Anthropic` for the Messages API), Base URL (HTTPS, public host), API key, optional extra auth headers (`Name: value` per line), optional balance method (OpenRouter `/credits`, DeepSeek `/user/balance`).
2. **Перевірити зʼєднання** — calls `GET /models` with the key.
3. **Моделі з API** — lists what the provider serves; **Додати** creates the model disabled. Providers without `/models`: **Додати модель** with the exact model id from their docs.
4. Edit the model: label for students, family, output/context limits, tariff per 1M tokens (optional, for cost estimates), optional fallback model.
5. **Увімкнути** — the server sends a real test request through the API; only a model that answered becomes visible to students. **Основна** sets the default model.
6. More keys for the same provider (**Додати ключ**) are tried in order when one fails with an auth, quota or rate-limit error, before any text was streamed. The fallback model is tried once under the same rule, and only if the student is allowed to use it.
7. For a provider with a request limit (free NVIDIA, small plans), set **Загальний ліміт запитів за хвилину**, then press **Фото й інструменти** on each model.

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
- `server/ai-improvements.unit.test.ts`: the provider line (real millisecond timestamps in both stores, waiting, giving up, a 429 retry, an answer stopped in line costs nothing), the agent model, the capability check, photos, edit and regenerate, feedback, memory, lesson and homework context.
- `server/ai-assistant.unit.test.ts` runs the whole app: admin setup, a model that does not exist is refused, first grant, exact charge, history, isolation between students, repeated requests, parallel students, fallback and provider failures, approximate usage, stop, blocking, group access, group grants, resources, and the streaming fetch handler.

A real provider was not called in tests (no real key is used). After deploying, connect your provider, press **Перевірити зʼєднання**, enable a model (it sends one real request) and send one message from Student OS.
