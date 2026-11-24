# Secrets and manual configuration

Nothing in this repository contains a secret. Values below must be created by the account owner.
Names are fixed; do not paste values into chat, issues or commits.

## 0. Prerequisite: make the dispatch-only workflows registrable (BLOCKER, needs owner decision)
GitHub only registers `workflow_dispatch`-only workflows that exist on the repository's **default branch**. Verified on 2026-11-25: `ci.yml` (has a push trigger) is listed, while `analyze-r2.yml`, `release.yml` and `deploy-cloudflare.yml` return 404 from the runs/dispatch API. The Worker's `analyze` call therefore cannot start a run yet. Choose one (both leave the contents of `main` unchanged only in option A):
- **A (recommended):** Settings > Branches > change the fork's default branch to `byga-integration`. `main` is not modified.
- **B:** copy only the three workflow files into the fork's `main`.
Until one is done, the end-to-end flow stops at "Start analysis" (dispatch fails, the job returns to READY with an error).

## 1. Login password (protects the whole app, no Cloudflare Access)
The Worker shows a password form and, after a correct password, sets an `HttpOnly`, `SameSite=Strict`, `Secure` session cookie (30 days, signed with HMAC-SHA256). There is a single account that owns every job.
1. Choose a password of at least 8 characters (longer is better, e.g. a 4-word passphrase) and set it as Worker secret `AUTH_PASSWORD`.
2. Generate `SESSION_SECRET` (>= 32 random chars, `openssl rand -hex 32`) and set it as a Worker secret.
3. Until both are set and long enough, `/api/login` and the API answer 503 (fail closed).
4. Changing `AUTH_PASSWORD` or `SESSION_SECRET` signs every device out immediately.
5. Wrong guesses are limited to 10 attempts per 15 minutes per IP address (counted in D1).
6. Do not put any Cloudflare Access policy in front of this Worker anymore; the GitHub runner reaches `/api/internal/*` directly and is authenticated by the HMAC callback.

## 2. R2 S3 credentials (two separate tokens, least privilege)
Create R2 API tokens scoped to bucket `rea-video-storage` only:
- **Worker token**: Object Read & Write -> Worker secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` (set as secret or var).
- **Runner token**: Object Read & Write -> GitHub secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

## 3. Worker secrets (`wrangler secret put NAME` in `worker/`, or dashboard)
| Name | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | account id for presigned URLs |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | presign upload/download URLs |
| `GITHUB_TOKEN` | fine-grained PAT, only repo `harvey-moeid/rea-video`, permission **Actions: Read and write** |
| `AUTH_PASSWORD` | the login password (>= 8 chars) |
| `SESSION_SECRET` | signs the session cookie (>= 32 random chars) |
| `CALLBACK_SECRET` | >= 32 random chars (`openssl rand -hex 32`); same value as GitHub `WORKER_CALLBACK_SECRET` |

## 4. GitHub Actions secrets (repo Settings > Secrets > Actions)
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (= `rea-video-storage`), `WORKER_CALLBACK_URL` (= `https://<app host>`, https only), `WORKER_CALLBACK_SECRET`.
For deployment from Actions only: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## 5. R2 bucket CORS (required for direct browser upload)
Bucket stays private. Set CORS on `rea-video-storage` (dashboard > R2 > Settings > CORS policy):
```json
[{
  "AllowedOrigins": ["https://<your app origin>"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600
}]
```
`ExposeHeaders: ETag` is mandatory for multipart uploads. Do **not** add lifecycle rules.

## 6. Deploy
Run the "Deploy to Cloudflare" workflow (needs section 4 deploy secrets) or `cd worker && npx wrangler deploy` from a machine logged in to Cloudflare.
