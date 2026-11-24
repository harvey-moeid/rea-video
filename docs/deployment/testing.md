# Testing

| Layer | Command | What it proves |
|---|---|---|
| Python engine + runner | `python -m pytest -q` | CLI contract, valid / corrupt / oversized / empty input, failure and timeout handling, incomplete output, HMAC signing |
| Worker API | `cd worker && npm test` | Access JWT checks, IDOR, upload validation, multipart, idempotency, rate limit, callbacks (HMAC, replay, state), partial-delete retry, SigV4 against the AWS reference vector |
| Local UI end-to-end | see below | Real PWA in Chromium + real Worker code + real `rea-video` run + signed callbacks + download + delete |

Local UI E2E (needs ffmpeg, Playwright with Chromium, openssl):
```
openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -days 2 -subj "/CN=acc.r2.cloudflarestorage.com" -addext "subjectAltName=DNS:acc.r2.cloudflarestorage.com"
E2E_KEY=k.pem E2E_CERT=c.pem node e2e/ui.e2e.cjs
```
## What the local tests do NOT prove
Cloudflare Access issuing tokens, real R2 accepting presigned URLs and multipart parts created through the binding, real D1, GitHub accepting the dispatch, and the runner reaching the Worker. Those need the secrets in `secrets.md` and a deployed Worker; use a small sample video for the first live run.
