# Guardian linking and parent reporting

Guardians and students form a many-to-many relationship through `guardian_student_links`: `pending`, `active`, or `revoked`. Links cannot be created by guessing a student UUID. Invitation secrets exist only as hashes in the private schema and require expiry, one-time consumption, and explicit revocation.

Parent reports are generated per student and period with lifecycle `draft → approved → sent`, or `failed`. Teachers review/edit and approve reports before delivery. Telegram is the initial delivery channel; the private idempotent outbox prevents duplicate sends.

Reports may contain attendance summary, homework attempts/reviews and individual scores, effort, project progress, period XP, level, achievements, portfolio milestones, and teacher comment. Average grade is not the central metric.

Guardians may access only explicitly linked students and guardian-safe approved/sent data. Draft reports stay with assigned teachers/admins. Revoked links immediately fail RLS checks.
