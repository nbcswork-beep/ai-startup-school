# Shared membership, attendance and academic state

## Causes

The previous attendance projection used saved attendance rows as its roster. With one saved row it displayed one student, even when the group had six members. Some projections also treated login activation as membership. Group create/edit generated numbered template sessions, while regular group tables included cancelled history. Those are separate causes, now addressed at their shared server projections and mutation paths.

## One physical store

The deployed pilot uses `MemoryRepository` backed by the existing durable Redis REST runtime JSON. `directory[].groupId` is the student's current membership; `groups`, `classSessions`, `attendance`, `homework`, `submissions`, `lessonProgress` and `projects` live in that same state. Teacher/Admin workspaces capture one snapshot for their projections. They do not maintain separate rosters or lesson/homework status files.

A student has one current group. Membership excludes archived/deleted people, but includes pending/disabled accounts already assigned to the group. This never grants those accounts login access. Auth and notifications retain active-account checks. Admin's global view and the assigned Teacher's view derive the same group count and current names.

Attendance joins **all current members** to any existing attendance rows. Five students without saved attendance remain five visible, unmarked rows; the sixth saved row does not become the entire roster. Former members with saved attendance remain read-only history, excluded from current counts and bulk saves. No student is automatically marked present.

Writes check current membership, Teacher ownership, active group and session status inside the existing atomic compare-and-set mutation. Duplicate, foreign, moved-student or inactive-session requests cannot partially save attendance. Pending/disabled members can have attendance recorded without activating their accounts.

## Lessons and homework

Groups contain planning metadata; creating/editing one never creates or moves lessons. `Запланувати заняття` makes an explicit server record with a real title and validated Kyiv date/time. Actual records supply the staff counts and Student route. No catalog item is an assignment unless explicitly linked to a real visible session.

Current staff lists show scheduled/rescheduled/in-progress sessions. Completed, cancelled and archived history has separate filters. Student schedule, access and recoveries check active membership and status on the server. Homework visibility requires `published`; unpublish/archive retain responses, grades and feedback. A group rename is reflected in the current homework/profile projections rather than a copied old name.

## Refresh and draft safety

Protected `/api/v1/academic-revision` hashes the caller's current scope. Visible pages poll every five seconds, refresh on focus and after local mutations, and pause when hidden. BroadcastChannel carries only an invalidation signal. Requests/responses use `no-store`. There are no academic localStorage copies. A separate browser/device updates on its next successful poll; the implementation does not promise zero network delay.

Attendance refresh merges only fields the Teacher touched, preserving focus/cursor while accepting fresh membership and untouched server statuses. Successfully saved fields stop being dirty. Open Student homework details receive changed instructions and grades; withdrawn work keeps entered text but disables submission. Project/stage/note drafts also survive unrelated feedback refreshes.

## Verification and live limitation

Tests and browser QA cover six current members with one saved attendance row, disabled/pending logins, current vs historical membership, two repository instances, group renames, date/status changes, two Student accounts, reloads, homework lifecycle, review decisions and notes/replies. Backend authorization/version checks run independently of visible buttons.

The owner chose to continue without signing into production. No production roster was read, edited or reseeded, and no claim is made that the six live records were reconciled by this work. Verification uses isolated local data and mocked external services. The existing Preview integration is used for the authorized feature branch; production promotion requires confirmation.
