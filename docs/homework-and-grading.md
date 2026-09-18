# Homework, submissions, and grading

Homework belongs to a group/course and may reference a module, lesson, and class session. Drafts are invisible to students; published rows require `publish_at`. Resources use HTTPS links or private file metadata.

Each resubmission inserts a new `homework_submissions` row with an increasing attempt number. Historical attempts are never updated into a replacement attempt. Supported content is text, comment, HTTPS URL, and authorized image/file metadata.

Submission lifecycle: `not_started`, `in_progress`, `submitted`, `needs_revision`, `completed`.

Reviews contain:

- integer score from 0 through 10;
- effort: `needs_attention`, `good_effort`, `high_effort`;
- written feedback and revision/completion status;
- reviewer and timestamps.

`review_homework_submission` validates authorization and values. A trigger writes every insert/change to `homework_review_events`. Reviews may return work for another attempt.

Grades never award XP, change levels, lock lessons, rank students, or control course progression. XP continues through idempotent `xp_events` tied to participation, completion, and creation.
