-- Baseline schema, reconstructed from the live D1 database `rea-video-db`
-- (cd3ece43-4d12-4e69-9347-e7c11b62fbee) on 2026-11-24. Already applied; kept here so tests
-- and fresh environments can build the same structure.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UPLOADING','READY','QUEUED','PROCESSING','COMPLETED','FAILED','DELETING','DELETED')),
  input_key TEXT NOT NULL,
  result_prefix TEXT NOT NULL,
  original_filename TEXT,
  content_type TEXT,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  deleted_at TEXT,
  error_message TEXT,
  workflow_run_id TEXT
);

CREATE TABLE IF NOT EXISTS job_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('original','frame','audio','report','metadata','other')),
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_job_objects_job ON job_objects(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
