# External setup checklist

- [ ] Create the Supabase project and record its region/project reference.
- [ ] Apply the migration and load production course/achievement content.
- [ ] Provision a least-privilege PostgreSQL connection for the API.
- [ ] Generate and store persistent ES256 application signing keys.
- [ ] Generate and store a strong refresh-token pepper.
- [ ] Add the Telegram bot token to server secret storage.
- [ ] Configure the Telegram Mini App HTTPS URL.
- [ ] Configure the exact production frontend origin in `APP_ORIGINS`.
- [ ] Deploy the Node API and frontend; run `/api/health` smoke check.
- [ ] Run RLS integration tests against a disposable Supabase branch/project.
- [ ] Verify Telegram login on a real device and that refresh/logout cookies are secure.
- [ ] Decide on an AI provider, safety policy, budget, retention period, and incident process before enabling paid AI.
- [ ] Configure monitoring for auth failures, 5xx responses, database saturation, and AI latency/cost.
- [ ] Define backup/restore and data-deletion procedures suitable for student data.
