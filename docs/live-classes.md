# Live classes and attendance

`class_sessions` is the source of truth for the Student App and Telegram notifications. A session belongs to a group and course, may reference a module/lesson, records its teacher, `timestamptz` range, provider-neutral HTTPS meeting URL, status, notes, and materials.

Statuses: `scheduled`, `rescheduled`, `in_progress`, `completed`, `cancelled`. `reschedule_class` locks the session, rejects terminal sessions, records the old/new ranges and actor in `class_session_reschedules`, then updates the session.

Materials reference an HTTPS URL or private `file_assets` metadata, never an ordinary relational blob.

Attendance separates provider suggestions from truth:

- `suggested_status` and `suggestion_source` are advisory.
- `status`, `confirmed_by`, and `confirmed_at` are teacher-confirmed.
- `confirm_attendance` verifies the teacher/group/student relationship and always records the actor.
- Opening the meeting URL never marks attendance.

The student schedule endpoint returns next, today, this week, upcoming, and past sessions without creating a large calendar surface. Database values are UTC-safe `timestamptz`; presentation uses the configured group/user timezone.
