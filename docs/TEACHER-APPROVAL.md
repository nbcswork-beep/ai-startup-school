# Teacher confirmation and project journal

## Lesson credit

Student **Надіслати на підтвердження** calls the existing lesson completion endpoint. It now records `pending_review` with a version and submission time, returning zero XP. Progress stays zero and the next lesson stays locked. Repeated pending/approved requests have no effect.

Teacher → lesson attendance → **Зарахування уроку** exposes the confirmation queue. `POST /api/v1/teacher/sessions/:sessionId/students/:studentId/review` accepts `{expectedVersion, decision: 'approved' | 'needs_revision', feedback}`. Approval credits that student, awards XP once and opens the following lesson; return requires feedback and allows resubmission. Presence and global class status remain separate: marking a class completed does not approve every student's progress.

## Written project stages

The four actual stages are problem, user, prototype and test. Only the first unapproved stage is writable. Student writes a response (1–20,000 characters), then sends it through `POST /api/v1/projects/:projectId/tasks/:taskId/submit` with `{contentText, expectedVersion}`. Pending stages cannot be resubmitted or self-approved. The legacy task `/complete` endpoint returns `409 TEACHER_REVIEW_REQUIRED`.

Teacher → Projects → the student's project shows the written response and **Перевірити етап**. `POST /api/v1/teacher/students/:studentId/projects/:projectId/tasks/:taskId/review` uses the same version/decision/feedback shape. Return preserves the response and attempt history; the Student edits and resubmits. Approval alone completes the stage, credits XP once and opens the next. The fourth approval completes the project. Progress, stage position and stage title derive from these same tasks rather than a separate frontend checklist.

## Notes, links and feedback

Student **Мій проєкт → Нотатки та посилання** can add a note, an HTTPS link, or both. `POST /api/v1/projects/:projectId/notes` accepts `{contentText, contentUrl?, clientRequestId}`. Text is capped at 20,000 characters, URL at 2,048; URL credentials and non-HTTPS protocols are rejected. UUID client request IDs prevent duplicate retry submissions. The journal retains timestamps, links and Teacher replies alongside the project in Redis.

Teacher → Projects → a note → **Дати фідбек** writes through `POST /api/v1/teacher/students/:studentId/projects/:projectId/notes/:noteId/replies` with `{contentText, clientRequestId}`. Replies require 1–4,000 characters, retain Teacher identity/time and deduplicate retries. There are limits of 200 notes per project and 100 replies per note, plus route and existing global request rate limits. Archived projects/groups cannot receive new journal writes.

Notes and replies do not automatically approve a stage or lesson. A student sees Teacher feedback after the next academic refresh; unrelated refresh preserves the current draft. Reloading retains all saved content. Rendering escapes user text; links use `noopener noreferrer`. No frontend secret or additional environment variable is introduced.

## Authorization, races and history

Student writes are scoped to their own project/current active group. Teacher decisions and replies require the assigned active group (Admin may manage all groups), current membership and the owning project/session. Auth roles, status and versions are checked on the server inside atomic mutations. The decision must match a pending version, so two reviewers/retries cannot award twice or overwrite a newer submission. Return feedback is mandatory. Forging a Teacher role or changing project metadata cannot bypass approval.

`academicApprovalMigrationApplied` runs once for older states. Self-completed lessons without a Teacher review become pending with old completion values retained as legacy metadata. Unreviewed project stages retain IDs, titles, summary, previous status and any responses; the first unapproved stage opens and subsequent stages lock. Previously granted XP is retained and marked to prevent a second award. Teacher-reviewed records are respected. Export/restore includes this marker and all attempts, notes and replies. Migration is persisted by the next ordinary runtime mutation; development does not execute a production cleanup command.

The separate PostgreSQL foundation is not enabled. It fails closed for unsupported new operations and the legacy self-completion bypass until schema/RLS/repository work is implemented and tested.

## Manual verification in isolated data

1. Create a group and assign two existing Students. Schedule real lessons explicitly; planned lesson count alone should show no lessons.
2. Student submits the first lesson for confirmation: zero progress/XP and next lesson locked. Teacher approves: credited progress and next lesson update; the other Student is unaffected.
3. Create a project, write stage one and submit. Stage two remains locked. Teacher returns it with feedback; Student sees the response/comment, edits and resubmits. Teacher approves; stage two opens. Refresh both pages and verify persistence.
4. Try self-approval, another group's Teacher and a stale review version: the server rejects them. Retrying approval must not award XP twice.
5. Add a project note and HTTPS link. Teacher replies. Student receives feedback without reload, keeps an unsent draft and retains saved history after reload. Another Student cannot read or write this project. Check that HTML-like note text is displayed literally.
6. Repeat at mobile width; current page styling and animations remain unchanged. Do not use these tests to mutate production records.
