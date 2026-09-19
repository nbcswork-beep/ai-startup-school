# Security architecture and threat model

## Trust boundaries

The supported path is `browser → authenticated BFF → authorized repository/domain action → PostgreSQL`. Browser state is untrusted. The BFF never returns database credentials, signing material, Telegram bot credentials, refresh-token hashes, raw cookies, notification payloads, or environment secret values.

Access JWTs are ES256, issuer/audience/algorithm/expiry checked, and short-lived. Each protected request also checks the current user status and backing session, so logout, administrative revocation, or account disabling invalidates an otherwise unexpired token. Refresh tokens are opaque random values in `Secure`/`HttpOnly`/`SameSite=Strict` cookies, stored only as peppered hashes, rotated once, and family-revoked on reuse.

PostgreSQL RLS remains enabled. Student ownership, explicit guardian relationships, active teacher assignments, and active admin state are independent database checks. Admin reads use bounded safe projections; writes are named security-definer domain functions with active-admin checks and audit output. No raw SQL endpoint exists.

## Threat model

| Threat actor / event | Asset and attack path | Primary controls | Remaining risk |
|---|---|---|---|
| Malicious student | Modify JS/body to grade work, confirm attendance, change role, or enumerate IDs | role middleware, strict DTOs, RLS ownership, named DB functions, IDOR tests | unknown DB-policy regression until integration suite runs in deployment |
| Compromised student session | Read private child data or persist indefinitely | short JWT TTL, live session check, rotating refresh family, logout/revoke | attacker can act as that student until detected/revoked |
| Guardian probes unrelated child | change student/report/link UUID | active relationship RLS and no self-link endpoint | support mistakes when establishing relationships require process controls |
| Teacher probes another group | modify group/student/session IDs | active assignment checks in repository/RLS/functions | compromised assigned teacher still sees their legitimate groups |
| Compromised admin | broad operational access and harmful domain actions | MFA requirement, explicit actions, confirmation, least-data projections, audit trail, session revocation | admin remains a high-value account; MFA and monitoring are external requirements |
| Stolen refresh token | replay after rotation | opaque 384-bit token, hash+pepper, rotation, reuse detection and family revocation | malware with active browser access may steal current session context |
| Leaked Telegram initData | replay login payload | server HMAC, constant-time comparison, freshness and future-skew checks | exposure inside the accepted freshness window |
| Malicious upload | spoof type, path traversal, oversized content | allowlisted MIME/size, signature sniffing, generated object names, private bucket design, ownership RLS | antivirus/content-disarm service is not yet connected |
| Stored/reflected XSS | homework, feedback, project, portfolio, search text | text escaping in UI, no user HTML rendering, CSP, dangerous schemes rejected | future rich-text features require a vetted sanitizer |
| IDOR | change homework/submission/project/booking/report IDs | server role/ownership checks and RLS tests | policy drift after future schema work |
| Service credential leak | bundled env, logs, error responses | server-only env, log redaction, generic production errors, secret scan | CI/deployment platform configuration remains external |
| Database misconfiguration | RLS/grants absent or stale migration | migrations, policy tests, version health documentation, separate staging | migrations have not been executed in this local environment |

## Web and API controls

- Explicit CORS origins; wildcard or non-HTTPS origins fail production configuration.
- CSP limits scripts to self and Telegram, blocks objects and framing, and restricts connections to self.
- `X-Content-Type-Options`, no-referrer, permissions restrictions, frame protections, and HSTS are provided through Helmet where applicable.
- API responses use `Cache-Control: no-store`.
- Structured logs redact authorization, cookies, set-cookie, Telegram initData, passwords, refresh tokens, and secret-like fields. Full bodies are not deliberately logged.
- Global and endpoint-specific rate limits cover auth, refresh, admin search, report resend, and privileged mutations.
- PostgreSQL parameters are bound. The Data Explorer selects SQL and sort identifiers only from server-owned allowlists.

## Child-data lifecycle

Only necessary display and education data is modeled; no precise location, public social profile, or student messaging is added. Accounts can be active, disabled, or archived without deleting educational history. Deletion and retention periods require a documented legal/product decision before production. Private portfolios and educational files remain non-public by default.
