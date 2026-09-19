# Production security checklist

Release blockers remain unchecked until verified in the target environment.

- [ ] Production development auth and ephemeral JWT keys are disabled.
- [ ] HTTPS is enforced end-to-end and `TRUST_PROXY` matches the deployment topology.
- [ ] Secrets are externalized; `.env` files are not deployed or committed.
- [ ] Admin identity provider and MFA/passkey/TOTP are configured.
- [ ] Database backups are configured with appropriate retention.
- [ ] A restore procedure has been tested and timed.
- [ ] Every migration is applied and the RLS integration suite passes.
- [ ] Private storage buckets, MIME/size checks, ownership policies, and signed reads are verified.
- [ ] CORS contains only explicit production HTTPS origins.
- [ ] CSP is verified against Student, Teacher, Admin, and Telegram flows.
- [ ] Authentication, search, upload, booking, report resend, and mutation rate limits are tuned at the edge and application.
- [ ] Audit events are written, retained, exported, and protected from ordinary admin modification.
- [ ] Security-event monitoring and actionable alerts are configured.
- [ ] Telegram initData validation and webhook/bot integration are verified on a real device.
- [ ] Signing-key, refresh-pepper, Telegram-token, database-password, and provider-key rotation is rehearsed.
- [ ] Incident contacts, severity criteria, evidence handling, and child-safety escalation are approved.
- [ ] Dependency audit has no unresolved high/critical production finding.
- [ ] Secret scanning runs in CI and repository history has been reviewed.
- [ ] Error responses and production logs have been sampled for secret/PII leakage.
- [ ] Account retention, archival, deletion, and guardian-link policies are approved.
- [ ] Notification worker validates recipient relationships at send time.

## Authorization release matrix

Run automated and manual checks for role escalation, cross-student, cross-group, guardian IDOR, private portfolio, file metadata, session revocation, refresh reuse, invalid sort/pagination, unsafe URL, and audited mutation behavior. UI visibility never counts as an authorization control.
