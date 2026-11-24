# Cloudflare storage architecture

Status: infrastructure foundation only. This document does not imply that a Worker, Pages app, or GitHub Actions workflow has been deployed.

## Resources

- Private R2 bucket: `rea-video-storage` (APAC)
- D1 database: `rea-video-db`
- D1 database ID: `cd3ece43-4d12-4e69-9347-e7c11b62fbee`
- Git branch: `byga-integration`; upstream `main` remains untouched.

## Retention policy

Original uploads and analysis outputs are retained until the owner explicitly deletes the job. Do not configure lifecycle expiration for this bucket. The delete endpoint must remove every object belonging to the job and only then mark the D1 job as `DELETED`. If object deletion partially fails, keep the job in `DELETING` and return a retryable error; never report deletion as complete.

## Object layout

```
users/{user_id}/jobs/{job_id}/input/original
users/{user_id}/jobs/{job_id}/frames/{frame_name}
users/{user_id}/jobs/{job_id}/audio/{stem_name}
users/{user_id}/jobs/{job_id}/reports/report.json
users/{user_id}/jobs/{job_id}/reports/VIDEO.md
users/{user_id}/jobs/{job_id}/metadata.json
```

Use opaque user and job identifiers. Do not put email addresses or other personal identifiers in object keys.

## D1 schema

The initial schema is installed in `rea-video-db`:

- `jobs`: ownership, state, input key, result prefix, timestamps, failure details and workflow run ID.
- `job_objects`: object inventory for each job, used to perform complete manual deletion.

Job states: `UPLOADING`, `READY`, `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `DELETING`, `DELETED`.

## Intended request flow

1. Authenticated PWA asks the Worker to create a job.
2. Worker derives the user identity from a verified Cloudflare Access JWT; never trust a client-supplied `user_id`.
3. Worker writes `UPLOADING` metadata and issues a short-lived upload URL for the exact R2 object key.
4. PWA uploads directly to private R2, then confirms completion. Worker validates object existence, size and expected content type before moving to `READY`.
5. User explicitly starts analysis. Worker dispatches a manual GitHub Actions workflow; Python/FFmpeg/ONNX processing runs on the Actions runner, not inside Workers.
6. Runner fetches the source object, runs rea-video, uploads outputs, and calls an authenticated Worker callback.
7. User can list jobs, inspect status, and download results through short-lived authorized URLs.
8. Manual delete transitions the job to `DELETING`, removes all job objects, then marks it `DELETED`.

## API surface to implement

- `POST /api/jobs`
- `POST /api/jobs/:id/upload-url`
- `POST /api/jobs/:id/upload-complete`
- `POST /api/jobs/:id/analyze`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/results`
- `DELETE /api/jobs/:id`

Every operation must enforce job ownership server-side. Signed URLs must be short-lived and scoped to a single object/action. Keep the bucket private; do not publish permanent object URLs.

## Security and operational requirements

- Verify Cloudflare Access JWT signature, issuer, audience and expiry on every user-facing API request.
- Keep R2 S3 credentials and GitHub dispatch credentials in Worker secrets; keep runner credentials in GitHub Actions secrets.
- Validate upload size, media type, job ownership, object key prefix and job state.
- Use multipart uploads for large files and abort incomplete multipart sessions.
- Avoid logging signed URLs, access tokens, uploaded content or secret values.
- Clean temporary files from the Actions runner after each job.
- Add request idempotency and bounded concurrent job dispatch.
- Do not enable lifecycle expiration; storage cleanup is user-triggered only.

## Remaining implementation work

1. Build Worker API and Access authentication.
2. Bind Worker to `rea-video-storage` and `rea-video-db`.
3. Build PWA upload/history/results/delete flows.
4. Add manual GitHub Actions workflow for Python analysis and R2 transfer.
5. Add tests for authorization, upload validation, retries, partial deletion and end-to-end processing.
6. Benchmark CPU, memory, runtime and file-size ceilings on the actual GitHub Actions runner before setting product limits.
