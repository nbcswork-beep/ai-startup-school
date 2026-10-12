# Homework file attachments

Students attach files to a homework attempt in the Student App; teachers open them in Teacher OS.
The bytes live in a **private Vercel Blob store**; the pilot runtime state (Redis) keeps only metadata.
Vercel's temporary function filesystem is never used for storage.

## Flow

1. `POST /api/v1/homework/:homeworkId/uploads` with `{ name, size }`.
   The server checks the student can see the homework, the extension, the size and the per-attempt
   limits, reserves a record (`status: pending`, expires in 15 minutes) and returns a presigned PUT URL
   for exactly one pathname: `<prefix>/homework/<homeworkId>/<studentId>/<uploadId>/<safe-name>.<ext>`.
2. The browser sends the bytes straight to Blob with that URL (progress is shown). Vercel's 4.5 MB
   function body limit does not apply, and the URL itself enforces the content type and byte size.
3. `POST /api/v1/homework/:homeworkId/uploads/:uploadId/complete`. The server reads the stored object:
   the size must match and the first 4 KB must carry the signature of the declared type. Only then the
   record becomes `ready`. A mismatch deletes the object and the record.
4. Ready files are **drafts** (`HomeworkSummaryDto.draftFiles`) and survive reloads and other devices.
   `DELETE /api/v1/homework/:homeworkId/uploads/:uploadId` removes a draft before sending.
5. `POST /api/v1/homework/:homeworkId/submissions` with `attachmentIds` and `clientRequestId`.
   The attempt stores the file ids; a repeated `clientRequestId` returns the stored attempt instead
   of creating a second one. Text may be empty when a file or link is attached.
6. When a teacher returns work (`needs_revision`), the next attempt starts with the previous files; the
   student can leave some out (they stay in the earlier attempt) and add new ones.

Download links are presigned GET URLs valid for 30 minutes, signed per pathname from one store-wide read
delegation that stays on the server. They appear in `latestSubmission.attachments`, `draftFiles` and
`TeacherSubmissionDto.files` / `previousAttempts[].attachments`. An expired link refreshes the data first.

## Accepted files and checks

| Extension | Stored type | Content check |
|---|---|---|
| pdf | application/pdf | `%PDF-` |
| doc | application/msword | OLE compound file header |
| docx, pptx, xlsx | Office Open XML types | ZIP container header |
| zip | application/zip | ZIP header (or empty ZIP) |
| png | image/png | PNG signature |
| jpg, jpeg | image/jpeg | JPEG SOI marker |
| txt | text/plain | UTF-8 without NUL bytes, or UTF-16 with BOM |

The canonical type comes from the extension, never from the browser. Display names are stripped of paths,
control and bidi characters; storage names keep only letters, digits, `.`, `-`, `_`. Pathnames are built
on the server from UUIDs, so a client cannot choose or traverse a path. Every endpoint requires the
student role, and all lookups are scoped to `request.auth.userId`; Teacher OS shows only submissions
from the teacher's groups. Upload reservation is rate limited (40/min), completion 60/min, submission 20/min.

## Limits (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOMEWORK_UPLOAD_MAX_FILE_MB` | 20 | Largest single file (1–100) |
| `HOMEWORK_UPLOAD_MAX_FILES` | 10 | Files per attempt (1–20) |
| `HOMEWORK_UPLOAD_MAX_TOTAL_MB` | 50 | All files of one attempt together (1–500) |
| `FILE_STORAGE_PREFIX` | deployment environment | First path segment, e.g. `production`, `preview` |
| `LOCAL_UPLOAD_DIR` | `.data/homework-uploads` | Local development only |

## One-time storage setup (owner action)

Uploads stay **off** until a store is connected; the Student App then shows a short notice instead of an
attach button, and text/link submissions keep working.

1. Vercel dashboard → project `assl` → **Storage** → **Create** → **Blob** → access **Private**
   (or `vercel blob create-store aiss-homework-production --access private`). Pick a region close to Kyiv.
2. **Connect** the store to the project for **Production**. Vercel adds `BLOB_STORE_ID` (OIDC) and
   `BLOB_READ_WRITE_TOKEN`; either one enables uploads. Do not copy the token anywhere else.
3. Preferably create a second private store for **Preview** so test files never share a store with
   school data. With one shared store, the default prefix still separates `production/` and `preview/`.
4. Redeploy. Check `GET /api/v1/homework/upload-policy` returns `enabled: true`, then upload a test PDF on
   Preview and open it from Teacher OS.

The presigned browser upload uses the same requests as `@vercel/blob/client`; it has been verified with the
local storage adapter and unit tests, and must be verified once on a Preview deployment with a real store.

## Backups and deletion

`npm run runtime:export` contains file metadata, not file bytes; the Blob store keeps the bytes
(11 nines durability). Removing a draft deletes its object. Files of sent attempts are kept with the
attempt history. Abandoned pending uploads are swept (in batches of 25) on the next reservation.

## Local development and tests

Without Blob credentials, a local run (`NODE_ENV` development/test, no `VERCEL_ENV`) uses
`LocalDevFileStorage`: files go to `LOCAL_UPLOAD_DIR` (memory in tests) through signed, expiring
`/api/v1/dev-storage/objects` URLs. These routes are never registered on Vercel.
Tests: `server/homework-files.unit.test.ts` (API, isolation, limits, signatures, idempotency, revision flow)
and the template cases in `server/homework-resources.unit.test.ts`.

The PostgreSQL backend reports file uploads as unavailable (`FILE_UPLOADS_UNAVAILABLE`); the pilot runs on
the runtime store.
