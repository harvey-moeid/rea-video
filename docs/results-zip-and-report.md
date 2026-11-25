# Download all (ZIP) and inline report

Two browser-only features on the job detail page (`web/app.js`). The Worker is **not** changed.

## Download all (ZIP)

- The button sits next to the **Outputs** heading (completed jobs only).
- On click the app calls `GET /api/jobs/:id/results` again to get **fresh** presigned links (they expire after 5 minutes), downloads every file directly from R2 (3 in parallel, 3 retries each), and builds one ZIP in the browser.
- The ZIP is "store" only (no compression) and dependency-free. Paths inside the ZIP are the output keys (e.g. `frames/001.jpg`), sanitised and de-duplicated.
- Guard rails: a confirmation above 500 MB (heavy on phones) and a hard stop above 2 GB. Constants: `ZIP_WARN_BYTES`, `ZIP_MAX_BYTES`.
- The ZIP is built in memory (Blob parts are referenced, not copied), so very large result sets can be slow or fail on a phone. The individual download links still work.

## Report inside the detail page

- If the outputs contain `report.html` (shortest key wins when several), it is shown under **Report**; no download needed.
- It is fetched as text (a plain `<iframe src>` would not work: the presigned URL sends `Content-Disposition: attachment`). Relative `src`/`href`/`poster` references that match an output key (frames, other files) are rewritten to the fresh presigned URLs.
- It renders in `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox">` (no `allow-same-origin`): report scripts get an opaque origin and cannot read the app's cookies or call `/api/*`.
- Frames and other files remain downloadable in **Outputs**.

## Required: R2 CORS

Both features use `fetch()` against the presigned R2 URL, which needs a CORS rule on the bucket allowing `GET` from the app origin. Uploads already need `PUT` and `ETag` exposure; add `GET`:

```json
[{
  "AllowedOrigins": ["https://<your-app-origin>"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600
}]
```

Without it the ZIP button shows "R2 bucket's CORS rule must allow GET" and the report box shows an error pointing to Outputs (plain link downloads keep working).
