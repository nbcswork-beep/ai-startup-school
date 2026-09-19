# Incident response

## Triage

1. Assign an incident commander and record timestamps, systems, affected roles, and correlation IDs.
2. Classify impact: authentication/session, child-data confidentiality, integrity of grades/attendance/reports, availability, or credential exposure.
3. Preserve relevant immutable audit/security events, infrastructure logs, database audit evidence, and deployment metadata. Do not copy unnecessary child content into tickets or chat.
4. For suspected child-data exposure, involve the designated privacy/safeguarding owner immediately and follow applicable notification obligations.

## Containment

- Revoke affected session families and disable compromised accounts.
- Rotate exposed signing keys, refresh pepper, Telegram bot token, database credentials, storage/provider keys through their standard provider procedures. Do not paste replacement secrets into source control or incident documents.
- Restrict affected origins/endpoints or pause notification workers if delivery integrity is uncertain.
- Preserve the database and object-store evidence required for investigation before destructive remediation.

## Eradication and recovery

Patch the root cause, add a regression test, review related RLS policies/IDOR paths, deploy through staging, and restore service gradually. Validate login, session rotation/revocation, Student/Guardian/Teacher/Admin boundaries, private storage, notifications, and audit events. If restoring data, follow the tested recovery runbook and reconcile audit/outbox state to prevent duplicate notifications.

## Post-incident

Document impact without exposing child data, detection/response gaps, corrective owners and deadlines. Review retention, monitoring thresholds, credentials, dependencies, and training. Never claim absence of evidence proves absence of compromise.
