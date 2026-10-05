# Groups, shared lessons, homework and session extension

These changes target **nbcswork-beep/ai-startup-school**, based on `telegram-vercel-preview` at `f5c991c06fd54a0466151b347bece0479cb830f1`. The landing repository `AI-Startup-School-site-2` is separate.

## Findings and actual storage

The Teacher OS `Нова група` button was explicitly `disabled`, labelled “Групи створює адміністратор”, with no client action or create-group API. The pilot repository returned a hardcoded single group, and several teacher writes did not check group ownership.

Production uses `MemoryRepository` as its domain implementation **with durable Redis REST runtime storage**, not process-only production memory. Its runtime JSON contains the directory, class sessions, attendance, homework, submission attempts/reviews, projects and reports. The same state now includes groups and homework versions. Writes retain the existing optimistic compare-and-set transaction. Development/testing never connects to this live state.

The runtime key is `${PILOT_RUNTIME_REDIS_PREFIX}:state`, or `${SESSION_REDIS_PREFIX}:pilot-runtime:v1:state` when the explicit prefix is absent. Authentication sessions use separate existing Redis keys/indexes. No new service or environment variable is required; preserve the current Redis URL/token and namespace variables. Preview must have a separate namespace from production.

Old states migrate without reseeding or deleting existing records. A one-time cleanup unpublishes recognizable untouched automatic homework and archives untouched original lesson templates; teacher edits, attendance, real linked homework, completed/rescheduled lessons, submissions, reviews and progress are preserved. The eight original pilot session IDs acquire stable schedule numbers; manually created sessions remain independent. Backup export/restore includes groups and the cleanup marker and retains credential redaction. See [STUDENT-REAL-CONTENT.md](STUDENT-REAL-CONTENT.md) for the exact scope.

The Student route previously returned all of `SEEDED_LESSONS` independently of real class sessions. It now derives lesson IDs, titles, dates and visibility from `classSessions` in the student's active current group. The catalog remains only an optional material library explicitly linked by a teacher to an actual session. Empty groups have no lessons or homework. No academic `localStorage` schedule/status copies were found. API responses already used `Cache-Control: no-store`; client reads also request `cache: no-store`.

## Groups and authorization

Teacher/Admin use the same backend create/edit/archive/restore actions. Teachers see assigned groups and can create groups for themselves. Admin sees all groups and can assign another active teacher. Server ownership checks also cover sessions, attendance, homework, reviews, private notes, portfolios and reports.

Creating a group creates only the group. The lesson count, start date, weekdays and time describe its plan; they never create, restore, cancel or move lessons. The planned count starts at zero. Group cards show the actual non-cancelled, non-archived session count. Use **Запланувати заняття** to enter a real title and start/end in Kyiv time, including daylight-saving conversion. Editing a group retains every session ID and date; group/teacher labels update without altering the schedule.

Existing students are selected rather than copied. The existing model has **one current group per student**: adding from another group transfers that membership, with explicit UI wording; removing does not delete the person or history. Multi-group enrollment is not introduced.

Group pages contain Students, Sessions, Attendance, Homework and Projects. Group archive retains all children/results, hides future student content and appears in Admin's Archive filter. Edit → Active restores the group.

## One lesson state and automatic refresh

`classSessions` is the sole persisted schedule. Compatible statuses are `scheduled`, `rescheduled`, `in_progress`, `completed`, `cancelled`, `archived`. The shared server selector returns upcoming lessons only from the student's active current group, with scheduled/rescheduled/in-progress status and a nonexpired end time. Completed/cancelled/archived lessons never remain upcoming.

Protected `GET /api/v1/academic-revision` returns only a hash of the caller's academic scope, including membership, attendance, submissions/reviews, lesson progress and projects with their notes/replies. Visible pages check every **5 seconds**, on focus and visibility changes. Student refresh includes home, schedule, learning route, homework, projects and recoveries; open lesson/homework details also refresh. BroadcastChannel signals other tabs immediately without sending educational records, names or identifiers. Hidden pages pause polling and refresh when shown. A successful mutation refreshes its initiating page immediately. Other devices update on the next poll plus request time; this is not a WebSocket subscription.

Teacher refresh pauses for open modals/menus and unsaved review or class-note edits. Attendance can refresh while being edited: only touched statuses/notes are reapplied to fresh server rows, with focus/cursor preserved. Removed members become read-only historical rows and stop counting as current members. Admin refresh pauses for modals/search. Student homework, stage, project and note drafts survive unrelated refreshes; withdrawn homework disables submission. The backend independently rejects attempts against inactive homework. Failed refreshes retry because their revision is not marked applied.

Teacher/Admin class lists and group session tables default to **Актуальні**. Completed, cancelled and archived records are accessible through explicit history filters. Cancelled/archived attendance is read-only. Student future lists, learning access and recovery cards exclude cancelled/archived sessions on the server.

Notification enqueue and final delivery recheck live group membership/status. Queued reminders cannot resurrect archived/unpublished content or notify a student about another group's work. Guardian summaries/digests also use the student's current group.

## Homework management

Statuses: `draft`, `published`, `unpublished`, `archived`. Teacher → Homework has a `⋯` menu: Edit, Unpublish, Archive, Restore as draft, and Delete only without submission attempts. The Archive filter separates archived assignments. Restoring never silently republishes.

PATCH/DELETE `/api/v1/teacher/homework/:id` require `expectedVersion`. All validation, ownership and deletion checks run on the server inside the atomic mutation. A concurrent submission therefore prevents deletion even from a stale browser. Archive/unpublish preserve all attempts, scores and feedback. Students can read/submit only published assignments in an active current group. Legacy `closed` is migrated to `unpublished`.

## Authentication sessions and existing automatic renewal

Admin → **Користувачі → Активні сесії** retains Revoke and adds **Продовжити**. POST `/api/v1/admin/sessions/:id/extend` is Admin-only and adds **180 days to the existing expiry**, using `expectedExpiresAt` to reject stale duplicate clicks. Expired, revoked, replaced or changed sessions fail. The action is audited; the table refreshes after success.

Redis atomically updates the session record, refresh lookup TTL, family/user index TTLs and active-session expiry score. Session creation/rotation does not shorten an index containing a longer-lived session. Rotation carries the manual extension forward.

The existing auth flow already rotated refresh tokens and renewed `REFRESH_TOKEN_TTL_DAYS` (default 30 days) when the client refreshed authorization. Continued API activity could therefore prolong sessions through that existing flow. There was no separate activity heartbeat that adds 180 days. **No new automatic activity-extension policy was added.**

An admin cannot remotely rewrite another browser's cookie. The extended cookie lifetime reaches it on its next normal refresh; if it stays offline until the old cookie expires, signing in again may still be needed.

If a new activity-renewal policy is approved later, change `server/services/auth-service.ts`, `server/auth/session-store.ts`, `server/routes/auth.ts`, the API refresh clients and session tests. First agree on inactivity and absolute lifetime limits; revoked/disabled accounts must stay ineligible.

## Test steps

Run `npm run typecheck`, `npm test`, `npm run build`. Use isolated local/test data or a separately approved Preview namespace.

1. Teacher → Groups → New group: name/year/start/days/time/teacher. Verify the empty group in Teacher/Admin and all five tabs. Change planned count to 8: no lessons should appear. Use **Запланувати заняття** for each real lesson; verify the entered title and Kyiv date in Teacher/Admin/Student.
2. Add existing students; check Admin and two Student accounts. Verify an unassigned teacher/student cannot manage the group.
3. Teacher/Admin → Classes → Edit: change date, cancel, restore as Scheduled, archive, restore. Open student pages update automatically; reload retains state.
4. Create Draft homework → Publish → Student Learning. Submit and review. Unpublish removes it from Student's active list. Archive removes it from Teacher's active list. Archive retains response/grade/feedback; restore returns Draft; explicit Publish makes it active again.
5. Delete an unused assignment. DELETE for any assignment with attempts returns `409 HOMEWORK_HAS_SUBMISSIONS`, even if the UI was stale.
6. Admin → Users → Active sessions → Extend: verify exactly +180 days, immediate table refresh and retained Revoke. Teacher/student get 403; a stale second request gets 409.
7. Archive/restore a group and remove a student; profiles/history remain. Repeat group form and homework actions at mobile width. Check six current members when only one attendance record exists; membership includes pending/disabled accounts without enabling their login.
8. Follow [TEACHER-APPROVAL.md](TEACHER-APPROVAL.md) to test Teacher-only lesson credit, sequential written project stages, notes, links and replies.

## Boundaries and limitations

No merge, deployment, Vercel environment changes or live runtime mutations are performed during development/testing. Publishing a feature branch may automatically trigger Vercel Preview in this repository; obtain approval for that external deployment step before pushing when deployment approval is absent.

The deployed Redis-backed pilot supports this change. The separate PostgreSQL repository is an earlier foundation with incomplete directory/group support. New group/homework/revision operations, lesson date changes and archiving fail closed with 503 there. A future PostgreSQL switch requires schema/RLS/repository work and database integration tests; this change does not enable that migration.
