# Перенос ИИ-генерации на Google Cloud Run Jobs — подготовка

Статус: **только подготовка**. Код в ветке `prep/cloud-run-worker` (основа — `fix/agent-empty-continuation`). Пока в Vercel не заданы переменные `AI_WORKER_*` и в Admin OS не выбран режим Cloud Run, Student OS работает ровно как раньше: всё генерируется на Vercel.

---

## A. Архитектурный отчёт

### Как работает сейчас

1. Ученик отправляет запрос → `api/ai-stream.ts` (функция Vercel, `maxDuration: 300`).
2. `AiChatService.start()` в одном запросе:
   - проверяет доступ и модель;
   - собирает промпт (история, вложения, урок);
   - резервирует токены (Lua, срок 6 мин);
   - создаёт задание в Redis;
   - генерирует ответ, держа связь с браузером через SSE.
3. Текст пишется в Redis каждую секунду (heartbeat). Если функция замолчала на 60 с, восстановление закрывает задание по сохранённому.
4. Режим агента: если за 250 с (`GENERATION_BUDGET_MS`) работа не закончена, задание завершается с флагом `resume`. Продолжение (до 3 раз, `MAX_AUTO_RESUMES`) **запускает браузер** (`scheduleResume`).
5. Код, который модель пишет внутри большого вызова инструмента, сохраняется контрольными точками (`projects.checkpoint`) и дописывается с точного offset (`append_project_file`).

### Почему бывают обрывы

| Ограничение | Где | Следствие |
|---|---|---|
| Функция Vercel живёт ≤ 300 с, бюджет генерации 250 с | `vercel.json`, `GENERATION_BUDGET_MS` | Большой файл, который модель пишет 4–5 минут, обрывается на середине. Спасают только контрольные точки. |
| Запрос к модели ≤ 280 с | `REQUEST_TIMEOUT_MS` | Даже в отдельном процессе один долгий запрос обрывался бы. |
| Продолжение запускает браузер | `src/ai-chat.js` | Закрыли Mini App — работа стоит до следующего открытия. |
| `RESUMED_KEY` ставился **до** отправки продолжения | `scheduleResume()` | Если запрос продолжения не прошёл (сеть, 429, 503), вкладка больше никогда его не повторяла. **Исправлено.** |
| Резерв токенов живёт 6 мин | `RESERVATION_TTL_MS` | Для долгого процесса резерв истёк бы: списалась бы только оценка, реальный расход не попал бы в баланс. **Добавлено продление.** |
| Промпт собирается только в памяти функции | `start()` | Отдельному воркеру было бы нечего продолжать. **Добавлена спецификация задания.** |
| Восстановление через 60 с тишины | `JOB_STALE_MS` | У Cloud Run холодный старт 10–60 с: задание закрылось бы раньше, чем воркер начал. **Для воркера — отдельные правила.** |
| Сбой записи контрольной точки | `agent/run.ts` | Ошибка Redis при записи черновика роняла весь цикл агента. **Исправлено.** |
| Запись черновика не чаще раза в 750 мс | `agent/run.ts` | Если модель прислала кусок кода и замолчала, кусок не сохранялся до следующего фрагмента. **Исправлено: отложенная запись.** |
| Проект со ссылками на несуществующие файлы считался готовым | `chat.ts` | «Готово», а сайта не хватает. **Исправлено: продолжение, затем честное сообщение.** |
| Приватный Blob вне Vercel | `@vercel/blob` | OIDC Vercel работает только внутри Vercel. Воркеру нужен `BLOB_READ_WRITE_TOKEN`: в коде воркера он используется только на чтение. |

### Другие ограничения, которые останутся после переноса

- **Холодный старт Cloud Run Jobs** 10–60 с: первый шаг агента появится позже, чем сейчас.
- **Живой поток текста недоступен в задачах воркера.** Приложение опрашивает задание примерно раз в секунду. Шаги агента и файлы видны, а промежуточный текст агента и раньше не показывался.
- **На Cloud Run уходит только режим агента.** Обычный чат остаётся на Vercel с тем же пределом 250 с: он короткий и потоковый.
- **Лимит провайдера** (бесплатный NVIDIA: около 40 запросов в минуту) общий для Vercel и воркеров. Ожидание в очереди — не дольше 90 с (`MAX_QUEUE_WAIT_MS`).
- **Upstash.** Воркер пишет heartbeat каждую секунду и продлевает аренду. Час генерации — это примерно 3–4 тысячи команд. На бесплатном тарифе Upstash следите за месячной квотой команд и размером запроса (большие проекты хранятся в Redis).
- **Бюджет токенов одного этапа** задаётся резервом. Долгую работу делят этапы, а не один гигантский запрос.
- **Шаги агента:** «Кроків за одне завдання» (по умолчанию 8) действует на каждый этап.
- **Внешний провайдер может взять плату за прерванный запрос**, даже если не вернул usage. Тогда списывается честная оценка, она отмечена как приблизительная. Гарантировать «ни одного лишнего токена» нельзя: провайдеры не поддерживают идемпотентные запросы.

### Новая схема

```
Ученик → Telegram Mini App → Vercel (api/ai-stream)
          │  проверка входа, модели, лимита; резерв токенов;
          │  задание + спецификация → Upstash Redis
          │  если режим агента и ученик включён в Cloud Run:
          ├─► Google Cloud Run Jobs: run(ai-worker, AI_JOB_ID=<id>)   ← только id
          │      (Vercel OIDC → Google STS → короткий токен сервисного аккаунта)
          ▼
   Приложение получает «start» + «attach» и следит за заданием (GET /ai/jobs/:id)

Cloud Run Job ai-worker (одно выполнение = одно задание и его продолжения)
   1. берёт аренду задания (Lua: только один владелец; повторов — не больше 2)
   2. продлевает аренду и резерв токенов, пока жив
   3. собирает тот же промпт из спецификации (тот же код, что на Vercel)
   4. генерирует (тот же AiChatService, инструменты, контрольные точки, учёт токенов)
   5. в конце этапа: списание, сообщение, файлы → Redis
   6. если нужно продолжение, сам создаёт его и выполняет (не больше 3)
   7. «готово» в Telegram: просит Vercel отправить (POST /api/v1/internal/ai/jobs/:id/notice)
```

**Остаётся на Vercel:** сайт, Mini App, вход, Telegram-бот и уведомления, Admin OS, обычный чат, загрузка файлов, скачивание, проекты и публикация, восстановление и уборка заданий.

**Переносится:** только выполнение агентных заданий.

### Надёжность — что сделано

- **Задание создаётся до вызова модели**, вместе со спецификацией: текст, id вложений, навык, правка, материал урока. Секретов в ней нет.
- **Аренда (lease) с heartbeat.**
  - `claimJobLease`: одно задание — один владелец. Чужой владелец получает `held`, после лимита попыток — `exhausted`.
  - `renewJobLease` продлевает аренду. Запись текста (`flushJob`) и завершение (`claimJobFinalization`) проверяют владельца (fencing): «потерявший» задание воркер не может ничего дописать или закрыть.
- **Падение воркера.** Его аренда истекает, следующая попытка Cloud Run забирает задание.
  - Задание **не начинается заново**: оно закрывается как прерванное с тем, что сохранено. Дальше идёт обычное продолжение с сохранённого offset (`read_project` → `append_project_file`).
  - Дубликата проекта не появляется.
- **Повторная доставка** того же id: завершённое задание воркер пропускает. Продолжение имеет детерминированный id (`resume:<job>`), поэтому браузер и воркер приходят к одному и тому же заданию.
- **Резерв токенов** продлевается при каждом продлении аренды (`extendReservation`). Списание по-прежнему одно и идемпотентно.
- **Задание, которое Cloud Run так и не взял**, ждёт 10 минут и передаётся ещё раз (не больше 2 раз). Потом оно закрывается с сообщением «Сервер генерації не запустився», **без списания**.
- **«Стоп».**
  - Если воркер ещё не взял задание, оно закрывается сразу и бесплатно.
  - Если работает, воркер видит флаг в течение секунды.
- **SIGTERM от Cloud Run.** Текущий этап закрывается как при лимите времени, а продолжение передаётся новому выполнению.
- **Сбой Redis.** Записи текста, шагов и списка файлов переживают кратковременный сбой. Чтение задания повторяется.
- **Завершено — только когда проверено.** Незавершённые файлы и ссылки на отсутствующие файлы не дают пометить работу готовой.
- **Логи воркера** содержат id, этапы, статусы и время. Промптов, ответов, имён, файлов и ключей там нет.

---

## B. Код (ветка `prep/cloud-run-worker`)

| Что | Где |
|---|---|
| Подготовка → сборка промпта → запуск; переключатель Vercel / Cloud Run; аренда; продолжение на сервере; восстановление | `server/ai/chat.ts` |
| Аренда, слоты воркеров, продление резерва, fencing (Lua и память) | `server/ai/store.ts` |
| Запуск Cloud Run Jobs, Vercel OIDC → STS → IAM, токен metadata | `server/ai/cloud-run.ts` |
| Точка входа воркера, конфигурация, логи | `server/worker/main.ts`, `server/worker/ai-worker.ts`, `server/worker/config.ts` |
| Хранилище только для чтения (Blob в воркере) | `server/storage/read-only-storage.ts` |
| Эндпоинт уведомления для воркера | `server/routes/ai-worker.ts` |
| Таймаут запроса и таймаут простоя потока | `server/ai/adapters.ts`, `server/ai/service.ts` |
| Контрольные точки: отложенная запись, повтор, устойчивость к сбою | `server/ai/agent/run.ts` |
| Admin OS: «Де працює режим агента» | `src/admin-ai.js` |
| Исправление `RESUMED_KEY` | `src/ai-chat.js` |
| Образ | `Dockerfile.ai-worker`, `.dockerignore`, `cloudbuild.ai-worker.yaml` |
| Тесты | `server/ai-cloud-worker.unit.test.ts` |

### Переменные окружения

**Vercel** (на шаге 1 — только для окружения *Preview*; *Production* — после вашего решения):

| Переменная | Значение |
|---|---|
| `AI_WORKER_GCP_PROJECT` | ID проекта Google Cloud |
| `AI_WORKER_GCP_REGION` | регион задания, например `europe-west3` |
| `AI_WORKER_JOB_NAME` | имя Cloud Run Job, например `ai-worker-preview` / `ai-worker` |
| `AI_WORKER_WIF_AUDIENCE` | `//iam.googleapis.com/projects/<НОМЕР>/locations/global/workloadIdentityPools/vercel/providers/vercel` |
| `AI_WORKER_DISPATCH_SERVICE_ACCOUNT` | `ai-dispatch@<ID-проекта>.iam.gserviceaccount.com` |
| `AI_WORKER_MAX_CONCURRENT` | сколько заданий одновременно у воркеров (по умолчанию 3) |
| `AI_WORKER_CALLBACK_SECRET` | случайная строка ≥ 32 символов (такая же — в Secret Manager для воркера) |

Если не задана хотя бы одна из первых пяти, воркер выключен. Все ответы идут через Vercel, а в Admin OS видно, какой переменной не хватает. Значения нигде не показываются.

**Cloud Run Job.** Обычные переменные:
- `AI_WORKER_ENVIRONMENT` = `preview` или `production`;
- `SESSION_REDIS_PREFIX` — **точно как в Vercel** для этого окружения (или `AI_REDIS_PREFIX`);
- `AI_WORKER_CALLBACK_URL` — https-адрес сайта;
- для передачи работы новому выполнению: `AI_WORKER_GCP_PROJECT`, `AI_WORKER_GCP_REGION`, `AI_WORKER_JOB_NAME`;
- необязательные: `AI_WORKER_STAGE_BUDGET_MS` (15 мин), `AI_WORKER_MAX_RUNTIME_MS` (55 мин), `AI_WORKER_LEASE_MS` (90 с), `AI_WORKER_MAX_ATTEMPTS` (2), `AI_WORKER_REQUEST_TIMEOUT_MS` (15 мин), `AI_WORKER_IDLE_TIMEOUT_MS` (3 мин).

**Cloud Run Job. Секреты (Secret Manager):**
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`;
- `AI_SECRETS_KEY` (или `SESSION_TOKEN_PEPPER`, см. ниже);
- `BLOB_READ_WRITE_TOKEN` — нужен для фото и сканов;
- `AI_WORKER_CALLBACK_SECRET`.

Воркер проверяет префикс так же, как Vercel: production-воркер не запустится с preview-префиксом, и наоборот.

**Ключ шифрования ключей провайдеров.** Воркер должен расшифровать API-ключи провайдеров, а они зашифрованы на Vercel:
- если в Vercel задан `AI_SECRETS_KEY` — нужен он;
- если нет — ключ выводится из `SESSION_TOKEN_PEPPER`, и тогда воркеру нужен pepper.

Рекомендую первый вариант. Тогда сессионный pepper не покидает Vercel. Но после появления `AI_SECRETS_KEY` ключи провайдеров придётся заново ввести в Admin OS. Это не перевыпуск ключей: вы просто вставляете те же ключи.

---

## C. Инструкция Google Cloud (без кода)

> Ничего из этого я не делал. Все шаги выполняете вы в браузере. Значения секретов никому не отправляйте и в чат не вставляйте.

**0. Регион.** Выберите регион поближе к базе Upstash: в Upstash откройте базу и посмотрите поле *Region*. Если там Frankfurt (eu-central-1), берите `europe-west3`. Дальше везде один и тот же регион.

**1. Проект**
1. Откройте <https://console.cloud.google.com>. Вверху слева нажмите на выбор проекта → **New project**.
2. *Project name*: `student-os-ai` → **Create**.
3. На главной странице проекта (*Dashboard → Project info*) перепишите себе **Project ID** и **Project number**.

**2. Оплата и защита от расходов**
1. Cloud Run работает только с привязанным платёжным аккаунтом (*Billing*), даже в пределах бесплатных лимитов. Привязка — ваше решение, я её не делал.
2. После привязки: **Billing → Budgets & alerts → Create budget**.
   - *Amount*: например 10 USD в месяц.
   - *Alert thresholds*: 50 %, 90 %, 100 %.
   - Письма уйдут вам на почту.
   - Бюджет предупреждает, но сам не выключает сервисы. Настоящие ограничители — шаги 3, 6 и 9: тайм-аут, одна попытка, лимит одновременных заданий и выбор учеников.

**3. Включить API.** **APIs & Services → Library**: найдите каждое и нажмите **Enable**:
- Cloud Run Admin API;
- Artifact Registry API;
- Cloud Build API;
- Secret Manager API;
- IAM Service Account Credentials API;
- Security Token Service API.

**4. Artifact Registry (хранилище образов)**
1. **Artifact Registry → Repositories → Create repository**.
2. *Name*: `student-os`; *Format*: Docker; *Mode*: Standard; *Location type*: Region (ваш регион) → **Create**.
3. Откройте репозиторий → **Cleanup policies** → оставить последние 5 версий. Так старые образы не копят плату за хранение.

**5. Сборка образа из GitHub**
1. **Cloud Build → Triggers → Connect repository**.
   - Выберите GitHub, установите приложение Google Cloud Build для репозитория `nbcswork-beep/ai-startup-school`. Здесь GitHub попросит ваше согласие.
2. **Create trigger**:
   - *Name*: `ai-worker-image`;
   - *Event*: Push to a branch;
   - *Branch*: `^prep/cloud-run-worker$` (позже — `^main$`);
   - *Configuration*: Cloud Build configuration file → `cloudbuild.ai-worker.yaml`;
   - *Substitution variables*: `_REGION` = ваш регион.
3. **Run** — образ появится в `student-os/ai-worker` с тегом коммита.

**6. Сервисные аккаунты.** **IAM & Admin → Service Accounts → Create service account**:
1. `ai-worker` — от его имени работает задание. Роли проекта: **Logs Writer**. Доступ к секретам выдаётся на шаге 7, по каждому секрету отдельно.
2. `ai-dispatch` — его будет «надевать» Vercel. Ролей на проект **не давать**. На шаге 8 он получит только право запускать одно задание.

**7. Секреты.** **Security → Secret Manager → Create secret** — по одному на каждый:

| Имя секрета | Откуда взять значение |
|---|---|
| `upstash-redis-rest-url` | Vercel → Project `assl` → Settings → Environment Variables (или Upstash → база → REST API) |
| `upstash-redis-rest-token` | там же |
| `ai-secrets-key` *(или `session-token-pepper`)* | то же значение, что в Vercel для этого окружения |
| `blob-read-write-token` | Vercel → Storage → ваш Blob store → вкладка `.env.local` / *Tokens* |
| `ai-worker-callback-secret` | придумайте случайные 48 символов; то же значение позже положите в Vercel как `AI_WORKER_CALLBACK_SECRET` |

У каждого секрета: **Permissions → Grant access** → *Principal* `ai-worker@…` → роль **Secret Manager Secret Accessor**.

**8. Cloud Run Job.** Сначала тестовое задание для Preview.
1. **Cloud Run → Jobs → Deploy container**.
   - *Container image URL*: **Select** → `student-os/ai-worker` → последняя версия.
   - *Job name*: `ai-worker-preview`; *Region*: ваш.
   - *Number of tasks*: 1.
2. **Container(s), Volumes, Connections, Security**.
   - *Resources*: Memory 1 GiB, CPU 1.
   - *Task timeout*: 60 minutes.
   - *Number of retries per failed task*: 1.
   - *Parallelism*: 1.
   - **Variables & Secrets → Add variable**:
     - `AI_WORKER_ENVIRONMENT` = `preview`;
     - `SESSION_REDIS_PREFIX` = значение из Vercel для Preview. Если оно не задано, Vercel использует `aiss:preview:sessions:v1`;
     - `AI_WORKER_CALLBACK_URL` = `https://ai-startup-school.vercel.app` (для Preview уведомление может не пройти из-за защиты Preview-доменов — это безопасно, тогда его отправит регулярная уборка);
     - `AI_WORKER_GCP_PROJECT`, `AI_WORKER_GCP_REGION`, `AI_WORKER_JOB_NAME` = `ai-worker-preview`.
   - **Reference a secret** (*Exposed as environment variable*):
     - `UPSTASH_REDIS_REST_URL` ← `upstash-redis-rest-url`;
     - `UPSTASH_REDIS_REST_TOKEN` ← `upstash-redis-rest-token`;
     - `AI_SECRETS_KEY` ← `ai-secrets-key` (или `SESSION_TOKEN_PEPPER` ← `session-token-pepper`);
     - `BLOB_READ_WRITE_TOKEN` ← `blob-read-write-token`;
     - `AI_WORKER_CALLBACK_SECRET` ← `ai-worker-callback-secret`.
   - *Security → Service account*: `ai-worker`.
3. **Create**. Не нажимайте **Execute** вручную: без `AI_JOB_ID` воркер просто завершится с ошибкой конфигурации.
4. Откройте созданное задание → **Permissions → Add principal**:
   - `ai-dispatch@…` → роль **Cloud Run Jobs Executor With Overrides**;
   - `ai-worker@…` → та же роль (чтобы воркер мог передать работу новому выполнению).

**9. Безопасный вход Vercel → Google (без ключей)**
1. В Vercel: **Project `assl` → Settings → Security → Secure Backend Access with OIDC Federation** → включить, *Issuer mode*: **Team**.
2. В Google: **IAM & Admin → Workload Identity Federation → Create pool**.
   - *Name*: `vercel`.
   - *Provider*: **OpenID Connect (OIDC)**, *Provider name*: `vercel`.
   - *Issuer (URL)*: `https://oidc.vercel.com/anokhinmaxim2009-5438s-projects`.
   - *Audiences → Allowed audiences*: `https://vercel.com/anokhinmaxim2009-5438s-projects`.
   - *Attribute mapping*: `google.subject` = `assertion.sub`.
   - *Attribute conditions*: `assertion.project == 'assl'`.
3. **Service Accounts → `ai-dispatch` → Permissions → Grant access**.
   - *Principal*: `principal://iam.googleapis.com/projects/<НОМЕР>/locations/global/workloadIdentityPools/vercel/subject/owner:anokhinmaxim2009-5438s-projects:project:assl:environment:preview`
   - Для Production — такой же, но с окончанием `environment:production`; добавить позже.
   - Роль: **Workload Identity User**.
4. В Vercel: **Settings → Environment Variables**, только для **Preview**. Добавьте переменные из таблицы раздела B.

**10. Ограничение затрат (повторю главное)**
- *Task timeout* 60 минут.
- *Retries* 1.
- `AI_WORKER_MAX_CONCURRENT` = 2–3.
- В Admin OS режим «лише для вибраних».
- Бюджет с оповещениями.

---

## D. План переключения

0. **Сейчас.** Ветка подготовлена, в `main` ничего не слито, в Production ничего не менялось.
1. **Preview.** Сделайте шаги C1–C9 для Preview. Откройте Preview-деплой ветки, в Admin OS → «ШІ · Провайдери» → «Де працює режим агента» должно быть «Сервер генерації підключено». Выберите **«лише для вибраних учнів»** и отметьте одного тестового ученика.
2. **Проверка на Preview тестовым учеником.**
   - Большой сайт в режиме агента → сразу закройте Mini App → откройте через 10–20 минут: работа идёт или готова, пришло уведомление.
   - «Стоп» во время работы.
   - Фото в режиме агента.
   - Файл Word → конспект.
   - Логи: **Cloud Run → Jobs → ai-worker-preview → Logs**.
   - Расход: **Billing → Reports**.
3. **Production, всё ещё выключено.** Только после вашего разрешения:
   - ветка сливается в `main`;
   - без переменных `AI_WORKER_*` в Production всё работает как раньше.
4. **Production, один ученик.**
   - Создайте `ai-worker` для Production: `AI_WORKER_ENVIRONMENT=production`, `SESSION_REDIS_PREFIX` как в Production.
   - Добавьте principal `environment:production` (C9.3).
   - Задайте переменные `AI_WORKER_*` для Production → Redeploy.
   - В Admin OS выберите одного ученика. Наблюдайте 1–3 дня.
5. **Постепенно:** группа → половина учеников → «для всіх». Каждый шаг — переключатель в Admin OS, без передеплоя.

## E. План отката

- **Мгновенно, без передеплоя.** Admin OS → «Де працює режим агента» → **Vercel** → «Зберегти».
  - Новые задания сразу идут через Vercel, как раньше.
  - Уже начатые на воркере заканчиваются там. Если воркер недоступен, их закроет восстановление: прерванные с сохранённым, неначатые — без списания.
- **Полностью выключить воркер.** Удалите переменные `AI_WORKER_*` в Vercel → Redeploy. Код увидит, что воркера нет, и всё пойдёт через Vercel.
- **Если проблема в самом коде этой ветки.** Vercel → Deployments → предыдущий Production → **Instant Rollback**. Сейчас Production — `dpl_GVgSwoPpVZk3oGZDQSKQy9c9Ktn8`.
- **Данные не теряются.** Ключи Redis, id заданий, чатов, проектов и записи списаний те же. Новые поля заданий старый код просто не читает.
- **Остановить расходы Google.** Cloud Run → Jobs → задание → **Delete** (или убрать роль `ai-dispatch`). Vercel продолжит работать сам.

## F. Тесты

`server/ai-cloud-worker.unit.test.ts`. Работают на настоящих Lua-скриптах (эмулятор Redis), тестовом провайдере по HTTP и настоящих маршрутах приложения. Google не вызывается, платные токены не тратятся. Результаты прогона — в отчёте ветки (сообщение коммита / PR).
