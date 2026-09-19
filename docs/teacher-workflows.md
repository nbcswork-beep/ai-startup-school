# Teacher workflows

## Class cycle

1. Open **Заняття** and create a class for an assigned group.
2. Select the lesson, topic, time and duration; optionally add a provider-neutral HTTPS meeting URL.
3. Add presentation/reference links and private preparation notes.
4. Open the meeting from class detail. Reschedule or cancel through explicit actions; changes preserve history and prepare outbox notifications.
5. In **Відвідування**, choose **Усі присутні**, change only exceptions, add optional notes, then explicitly save. Suggested attendance is never authoritative and never overwrites confirmed attendance.
6. Mark the class complete and publish the prepared homework draft.

## Homework and review

Homework can be created for a group and optionally linked to a class. A teacher chooses draft or published state, instructions, deadline and XP reward. Publication is explicit.

The review queue keeps assignment, student, attempt and state visible. The workspace includes the current response, link/attachments metadata, previous attempts and previous feedback. A review records an integer score from 0–10, effort, feedback, and accepted/revision outcome. Unsaved feedback triggers a leave warning; previous/next controls keep the teacher in the queue. Reviews do not modify XP.

## Student support and private notes

The student detail presents course/module progress, attendance, homework, scores/effort, XP/level, projects, portfolio and mentor context for assigned students only. Attention reasons are deterministic and readable, such as repeated revision or no active project.

Private notes are separate from student feedback and parent-report comments. Only the assigned teacher/admin policies can read them. Student and guardian APIs do not serialize them.

Portfolio edits improve title, description, reflection and learning notes. They never change private visibility or publish a portfolio automatically. Production screenshot/asset selection depends on the private signed-file setup documented in `teacher-os.md`.

## Mentoring

Mentors open availability or blocked windows and review bookings with student/project context. Overlapping active availability is rejected, and PostgreSQL exclusion constraints prevent overlapping active bookings for both mentor and student. Booking state changes support confirmed, completed, cancelled, rescheduled and no-show states; meeting URLs remain HTTPS-only.

## Parent reports

1. Generate weekly drafts for an assigned group from attendance, homework, individual review scores/effort, project progress, XP events, achievements and portfolio milestones.
2. Edit the human teacher observation and mark a report `ready_for_review`.
3. Explicitly approve it. Approval requires a non-empty teacher comment and records approver/time.
4. The outbox worker performs normal delivery and updates `sent` or `failed`; Teacher OS does not silently send a draft.

Reports emphasize learning, effort, creation and progress. Average grade is not the headline. Guardians can read only approved/sent reports for an active linked student.

## Failure handling

Empty lists have contextual states, API failures surface as actionable messages, and permission failures show a protected-access screen. All state-changing flows require an explicit final action. Development authentication is for local QA only and must remain disabled in production.
