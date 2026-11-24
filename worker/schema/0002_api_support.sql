-- Additive migration. Applied to rea-video-db on 2026-11-24 statement by statement via the
-- Cloudflare D1 API. NOT run through `wrangler d1 migrations` (ALTER ... ADD COLUMN is not
-- idempotent), so there is intentionally no migrations_dir in wrangler.toml.
ALTER TABLE jobs ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE jobs ADD COLUMN upload_id TEXT;
ALTER TABLE jobs ADD COLUMN upload_mode TEXT;
ALTER TABLE jobs ADD COLUMN started_at TEXT;
ALTER TABLE jobs ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN summary_json TEXT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idem_key)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS callback_nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
