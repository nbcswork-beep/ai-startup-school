# AI Startup School V2 product foundation

V2 extends the existing Telegram Student App and Fastify/PostgreSQL architecture. It does not replace authentication, UUID identities, XP, projects, achievements, or provider-neutral AI infrastructure.

## Product rhythm

`live class → practice → homework → project work → teacher feedback → progress → portfolio`

The Student App supports a live school. Course content is not treated as the product by itself. Main student navigation is Home, Learning, Project, Portfolio, and Profile. AI conversations remain available in the backend but are not primary navigation.

## Architecture

- Vite mobile frontend consumes versioned `/api/v1` endpoints.
- Fastify owns authentication, validation, role-aware commands, and response shaping.
- PostgreSQL/Supabase is canonical. RLS independently enforces student, guardian, teacher, and admin boundaries.
- Telegram IDs remain external identity subjects; relational keys are UUIDs.
- Storage rows contain metadata only. Private object storage and signed reads are required in production.
- Meeting URLs and mentor URLs accept HTTPS only and are provider-neutral.

## Additive domains

Groups and memberships, live sessions and reschedule history, materials, teacher-confirmed attendance, homework and immutable attempts, review audit history, skills, private portfolios, mentor availability/bookings, guardian links, parent reports, and a private notification outbox.

## Compatibility and deviations

- Existing project IDs, progress, XP events, achievements, sessions, and conversations are preserved.
- Existing project-stage row IDs are retained while their codes are aligned to `idea`, `plan`, `prototype`, `design`, `test`, and a new `launch` stage.
- Technologies remain a bounded text array because they are display metadata; reusable learning skills are normalized.
- Public showcase access is intentionally not implemented. `shared` is only a prepared state and has no anonymous RLS policy.
- Teacher OS and Parent Portal UIs remain future work; this phase supplies backend contracts and Student App surfaces.

## Branding

No standalone approved logo SVG/PNG exists in the repository or Git history. The existing approved HTML/CSS `AI / STARTUP SCHOOL` mark is retained consistently. Supply and approve an official asset before replacing it.
