# Real student lessons and homework

## Cause and source of truth

`createPilotRuntimeState()` previously inserted eight scheduled pilot templates and seven published homework templates. Separately, `getLearning()` returned the entire built-in lesson catalog, even if sessions were cancelled or no real sessions were assigned. Student page memory then retained the initial route until a reload.

The Redis runtime's `classSessions` is now the source for both the schedule and the learning route. The route includes actual scheduled, rescheduled, in-progress and completed sessions in the student's current active group; cancelled/archived sessions are excluded. Lesson access and completion check current assignment and status on the server. Progress is keyed by the actual session ID. A catalog ID is accepted only as a legacy alias for an explicitly linked, visible assigned session. Optional linked catalog materials never create assignments themselves.

Homework remains in the same runtime's `homework` collection. Only `published` work in the current active group is active for students. Fresh runtime initialization contains no lessons or homework. Creating or editing a group does not generate assignments. Explicitly scheduled sessions and published homework appear normally. No additional environment variable or database is required.

## Existing state cleanup

Migration runs once, recorded by `seededContentCleanupApplied`:

- Original homework IDs `73000000-0000-4000-8000-000000000001` through `...007` are unpublished only when the original group, title, instructions, version and published status still match the automatic template.
- Original lesson IDs `71000000-0000-4000-8000-000000000001` through `...008` are archived only when the original title/catalog link, description and meeting URL still match, the session is scheduled, and there are no manual schedule/status changes, notes, materials, attendance or non-template linked assignments.
- Records, student answers, grades, feedback and progress are retained. Teacher edits and completed/rescheduled sessions are preserved. Legacy progress for the eight original sessions is copied to their actual session IDs without removing the old entries.
- Later explicit restore/publish actions are respected. Export/restore includes the marker, so a restored backup with the marker does not run the cleanup again.

The additional one-time marker `automaticGroupSessionsCleanupApplied` retires untouched placeholders from the former group generator: `scheduleManaged === true`, exact original numbered title, no catalog link, scheduled, no manual changes, meeting URL, description, notes or materials, and no attendance, homework or student progress. These records are archived rather than deleted. Edited or used records remain; later explicit restoration is respected. Existing cancelled records are available in staff history rather than the default active list.

The migrations are evaluated when runtime state is read and persisted with the next normal atomic state mutation. There is no direct live-state cleanup script. Export/restore retains all markers and historical records. Test and development bootstrap can explicitly opt into demo assignments through the test fixture; normal application bootstrap does not.

## Refresh and verification

Student academic refresh reloads home, learning, schedule, homework, projects and recoveries together after a revision change, on focus and every five seconds while visible. Open lesson and homework details refresh as well; removed lessons become unavailable. Homework input is retained if the assignment is withdrawn while a student is typing, and server submission is rejected. Recovery cards also verify the current active group and session status; their homework links require published status. Responses and client requests use `no-store`; there is no separate localStorage lesson list.

Student completion now requests Teacher confirmation. Only approval counts progress, awards XP and opens the following lesson. Project stages use the same review rule with written responses; notes and Teacher replies remain a separate journal. See [TEACHER-APPROVAL.md](TEACHER-APPROVAL.md).

Tests cover empty initialization, direct catalog access denial, one-time template retirement with answers/grades preserved, teacher-edited records, actual group session IDs, cancellation/archive/restore, homework publication/unpublication and restart persistence. Existing tests explicitly create assigned fixtures instead of relying on automatic real-world assignments. Browser scenarios check empty Student Learning, actual group lessons, two student accounts, shared date/status changes, reloads and homework lifecycle using isolated local state.

Publication of the feature branch can trigger the existing Vercel Preview integration. Production promotion or merge requires the owner's approval; verification does not mutate production data.
