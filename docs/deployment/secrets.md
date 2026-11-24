# Secrets and manual configuration

Nothing in this repository contains a secret. Values below must be created by the account owner.
Names are fixed; do not paste values into chat, issues or commits.

## 1. Cloudflare Access (protects the whole app)
1. Zero Trust > Access > Applications > Add > Self-hosted. Domain: the Worker hostname (`rea-video.<subdomain>.workers.dev` or a custom domain you own). Policy: Allow your email.
2. Copy the application **AUD tag** and your **team domain** (`<team>.cloudflareaccess.com`).
3. Put them in `worker/wrangler.toml` `[vars]` as `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, or set them in the dashboard. Until both exist the API answers 503 (fail closed).
4. Do **not** add a bypass policy for `/api/internal/*` unless you want to rely on the HMAC alone. The HMAC callback is verified by the Worker, but Access in front will block the GitHub runner unless you add a Service Auth token or a Bypass rule limited to `/api/internal/*`. Recommended: Bypass for that path only (HMAC + replay protection still apply).

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
