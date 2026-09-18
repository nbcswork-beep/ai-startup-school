# Teacher OS foundation

This phase provides backend foundations, not a large teacher frontend.

Versioned teacher endpoints support:

- assigned groups and group students;
- session creation and provider-neutral meeting links;
- transactional rescheduling with history;
- teacher-confirmed attendance;
- draft/published homework;
- score, effort, feedback, completion, and revision review.

RLS and repository checks restrict teachers to active assignments. Important actions carry actor IDs and timestamps. Review changes have an audit ledger. Session changes preserve the original schedule.

Next Teacher OS UI should consume these commands rather than write tables directly. It should add class/material editing, submission queues, project/portfolio review, mentor availability, and parent-report approval using the same authorization model.
