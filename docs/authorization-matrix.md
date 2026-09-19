# Authorization matrix

All checks are server/database-side. Frontend visibility is not authorization.

| Domain | Student | Guardian | Teacher | Admin |
|---|---|---|---|---|
| Own profile/progress/XP | own read | report-safe linked data | assigned students | operational |
| Groups/sessions/materials | enrolled groups | report/schedule notices later | assigned groups read/write | all |
| Attendance | own confirmed result | approved report summary | assigned group confirm | all |
| Homework | published assigned homework | approved report summary | assigned group create/review | all |
| Submission attempts | own read/insert | none | assigned students read/review | all |
| Projects | own | report summary | assigned students read | all |
| Portfolio | own private | no direct access in V2 | assigned students read | all |
| Mentor bookings | own | none | assigned mentor bookings | all |
| Parent reports | none | linked approved/sent | assigned students draft/approve | all |
| Auth sessions | own refresh cookie only; no metadata API | none | none | safe metadata and revoke; never token hashes |
| Guardian relationships | none | own active links only | assigned context only | inspect/revoke through audited action |
| Teacher assignments | none | none | own active assignments | inspect; assignment changes require explicit future action |
| Admin configuration | none | none | none | backend-generated health only; no secret values |
| Audit logs/security events | none | none | none | read-only safe projections; application path cannot update/delete |
| Secrets/outbox payload | none | none | none | none; private service only |

Security helpers use canonical `app_user_id` from the signed access token. Telegram IDs, names, email, or phone are never authorization keys. Teacher checks join active group assignments; guardian checks require an active explicit link. Anonymous users have no educational-data grants and no public child portfolio access.
