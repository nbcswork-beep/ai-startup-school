# Teacher OS

Teacher OS is the protected, desktop-first daily workspace for AI STARTUP SCHOOL teachers and mentors. It is served from `/teacher.html`; the Student App remains at `/` and uses a separate entry bundle and navigation.

## Navigation

- **Огляд** — operational counts, next class, transparent attention reasons, and weekly route.
- **Групи** — assigned groups only, with course progress, attendance, schedule, students, and recent homework.
- **Заняття** — class preparation, safe meeting link, lesson context, materials, private notes, status, reschedule, and attendance.
- **Домашні роботи** — draft/publish lifecycle, assignment summary, review queue, and the next/previous review workspace.
- **Учні** — authorized educational profiles with progress, attendance, homework, projects, portfolio, mentoring, and private notes.
- **Проєкти** — product stage, completion, skills/tags, and links back to the student context.
- **Менторство** — owned availability and booking operations.
- **Звіти** — generated weekly drafts, human comments, explicit review and approval.

## Access and privacy

Every Teacher OS request requires the normal application JWT. Repository reads run with the internal user ID in PostgreSQL session claims, so RLS remains the final boundary. Teacher access is derived from active `group_teachers` assignments; URL IDs and hidden UI are never treated as authorization.

Teachers can access only assigned groups and their students, sessions, homework, submissions, projects, portfolios, educational files, and reports. Teacher private notes are stored in `teacher_private_notes`; class-private notes are stored in `teacher_session_notes`. Neither table has a student or guardian policy. Public student profiles, messaging, raw auth data, and guardian personal data are not part of Teacher OS.

Meeting and material URLs must be HTTPS. Student assets remain in private buckets and are expected to be resolved through short-lived signed access after the existing file authorization checks. Service-role credentials, bot tokens, and storage secrets stay server-side.

## Data and API surface

`GET /api/v1/teacher/bootstrap` returns one authorized operational read model. `GET /api/v1/teacher/search` searches only that authorized scope. Mutations are intentionally narrow: class scheduling/status/reschedule/materials, bulk attendance, homework creation/publish/review, private notes, portfolio text improvements, mentor availability/bookings, and weekly report generation/save/approval.

Class reschedules update the same `class_sessions` source consumed by Student App, preserve history in `class_session_reschedules`, and enqueue notification work. Homework reviews preserve submission attempts and audit review changes. A score never awards XP or changes lesson access.

## External setup and future work

- Apply migrations through `20260919000100_teacher_os.sql` to the managed PostgreSQL/Supabase environment.
- Configure private Supabase Storage buckets and a server-side signed-URL endpoint before enabling production uploads/downloads in Teacher OS. The UI currently supports authorized HTTPS material links; it does not make storage public.
- Connect the outbox worker to Telegram/email delivery. Approval creates an outbox event; delivery and `sent`/`failed` transitions belong to the worker.
- Configure production Telegram/web authentication and disable all development-auth flags.
- A richer calendar, batch report editor, project feedback threads, and Admin Control Center are deliberately outside this phase.
