// REA VIDEO API Worker. Heavy processing never runs here: uploads go straight to R2 via presigned
// URLs, analysis runs in GitHub Actions, results come back through an HMAC-authenticated callback.
import { verifyAccessJwt, userIdFromClaims, verifyCallback } from "./auth.js";
import { presignR2, sha256Hex } from "./sigv4.js";
import {
  DEFAULT_MAX_UPLOAD_BYTES, JOB_ID_RE, MAX_PARTS_PER_REQUEST, PART_SIZE, SINGLE_PUT_MAX,
  inputKey, jobPrefix, keyInside, kindForKey, looksLikeVideo, resultPrefix, safeFileName, validateCreate,
} from "./validate.js";

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra } });
const err = (status, message, extra = {}) => json({ error: message, ...extra }, status);

const MAX_BODY = 64 * 1024;
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
  if (!text) return { text, value: {} };
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

const r2cfg = (env) => ({
  accountId: env.R2_ACCOUNT_ID, bucket: env.R2_BUCKET_NAME,
  accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
});
const maxBytes = (env) => Number(env.MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD_BYTES;
const maxConcurrent = (env) => Number(env.MAX_CONCURRENT_JOBS) || 2;
const nowIso = () => new Date().toISOString();

// ---------- rate limiting & idempotency (D1) ----------
async function rateLimit(db, bucket, limit, windowSec) {
  const win = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  await db.prepare("INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1").bind(bucket, win).run();
  const row = await db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?").bind(bucket, win).first();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(win - 86400).run();
  return row.count <= limit;
}

// ---------- row helpers ----------
const publicJob = (j) => ({
  id: j.id, status: j.status, filename: j.original_filename, size: j.file_size, content_type: j.content_type,
  language: j.language, created_at: j.created_at, updated_at: j.updated_at, started_at: j.started_at,
  completed_at: j.completed_at, error: j.error_message, upload_mode: j.upload_mode,
  summary: j.summary_json ? safeParse(j.summary_json) : null,
});
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function getOwnedJob(env, userId, id) {
  if (!JOB_ID_RE.test(id)) return null;
  // ownership is enforced in SQL: another user's id is indistinguishable from a missing one
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND user_id = ?").bind(id, userId).first();
}
async function transition(env, id, from, to, sets = "", binds = []) {
  const fromList = Array.isArray(from) ? from : [from];
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = ?, updated_at = ?${sets} WHERE id = ? AND status IN (${fromList.map(() => "?").join(",")})`,
  ).bind(to, nowIso(), ...binds, id, ...fromList).run();
  return (res.meta?.changes ?? 0) > 0;
}

// ---------- handlers ----------
async function createJob(env, userId, request) {
  if (!(await rateLimit(env.DB, `create:${userId}`, 30, 3600))) return err(429, "rate limit exceeded");
  const { text, value } = await readJson(request);
  const v = validateCreate(value, maxBytes(env));
  if (v.error) return err(v.code || 400, v.error);
  const { filename, size, contentType, language } = v.value;

  const idem = request.headers.get("idempotency-key");
  const reqHash = await sha256Hex(text);
  if (idem) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idem)) return err(400, "bad Idempotency-Key");
    const claimed = await env.DB.prepare("INSERT OR IGNORE INTO idempotency_keys (user_id, idem_key, request_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, idem, reqHash, Math.floor(Date.now() / 1000)).run();
    if ((claimed.meta?.changes ?? 0) === 0) {
      const prev = await env.DB.prepare("SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE user_id = ? AND idem_key = ?").bind(userId, idem).first();
      if (prev.request_hash !== reqHash) return err(422, "Idempotency-Key reused with a different request");
      if (!prev.response_json) return err(409, "request in progress");
      return json(JSON.parse(prev.response_json), prev.status_code, { "idempotent-replay": "true" });
    }
  }

  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const mode = size > SINGLE_PUT_MAX ? "multipart" : "single";
  const key = inputKey(userId, id);
  await env.DB.prepare(
    "INSERT INTO jobs (id, user_id, status, input_key, result_prefix, original_filename, content_type, file_size, language, upload_mode) VALUES (?, ?, 'UPLOADING', ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, userId, key, resultPrefix(userId, id), filename, contentType, size, language, mode).run();
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  const body = { job: publicJob(job), upload: { mode, part_size: mode === "multipart" ? PART_SIZE : null, parts: mode === "multipart" ? Math.ceil(size / PART_SIZE) : 1 } };
  if (idem) {
    await env.DB.prepare("UPDATE idempotency_keys SET status_code = 201, response_json = ? WHERE user_id = ? AND idem_key = ?").bind(JSON.stringify(body), userId, idem).run();
  }
  return json(body, 201);
}

async function uploadUrl(env, userId, job, request) {
  if (job.status !== "UPLOADING") return err(409, `job is ${job.status}`);
  if (!(await rateLimit(env.DB, `upurl:${userId}`, 600, 3600))) return err(429, "rate limit exceeded");
  const { value } = await readJson(request);
  const cfg = r2cfg(env);
  if (job.upload_mode === "single") {
    const url = await presignR2(cfg, { method: "PUT", key: job.input_key, expires: 900 });
    return json({ mode: "single", url, expires_in: 900 });
  }
  let uploadId = job.upload_id;
  if (!uploadId) {
    const mp = await env.BUCKET.createMultipartUpload(job.input_key, { httpMetadata: { contentType: job.content_type } });
    // only one concurrent creator wins; the loser aborts its own upload and re-reads
    const res = await env.DB.prepare("UPDATE jobs SET upload_id = ? WHERE id = ? AND upload_id IS NULL").bind(mp.uploadId, job.id).run();
    if ((res.meta?.changes ?? 0) === 0) {
      await mp.abort().catch(() => {});
      uploadId = (await env.DB.prepare("SELECT upload_id FROM jobs WHERE id = ?").bind(job.id).first()).upload_id;
    } else uploadId = mp.uploadId;
  }
  const total = Math.ceil(job.file_size / PART_SIZE);
  const nums = Array.isArray(value.part_numbers) ? value.part_numbers : [];
  if (nums.length < 1 || nums.length > MAX_PARTS_PER_REQUEST || !nums.every((n) => Number.isInteger(n) && n >= 1 && n <= total)) {
    return err(400, `part_numbers must be 1-${MAX_PARTS_PER_REQUEST} integers within 1..${total}`);
  }
  const parts = await Promise.all([...new Set(nums)].map(async (n) => ({
    part_number: n,
    url: await presignR2(cfg, { method: "PUT", key: job.input_key, expires: 900, query: { partNumber: String(n), uploadId } }),
  })));
  return json({ mode: "multipart", part_size: PART_SIZE, total_parts: total, parts, expires_in: 900 });
}

async function uploadComplete(env, userId, job, request) {
  if (job.status === "READY") return json({ job: publicJob(job) }); // idempotent
  if (job.status !== "UPLOADING") return err(409, `job is ${job.status}`);
  const { value } = await readJson(request);
  if (job.upload_mode === "multipart") {
    if (!job.upload_id) return err(409, "no multipart upload in progress");
    const total = Math.ceil(job.file_size / PART_SIZE);
    const parts = value.parts;
    if (!Array.isArray(parts) || parts.length !== total) return err(400, `expected ${total} parts`);
    const clean = parts.map((p) => ({ partNumber: p?.part_number, etag: p?.etag }));
    if (!clean.every((p, i) => p.partNumber === i + 1 && typeof p.etag === "string" && /^"?[A-Za-z0-9-]{8,64}"?$/.test(p.etag))) {
      return err(400, "parts must be ordered 1..N with valid etags");
    }
    try {
      await env.BUCKET.resumeMultipartUpload(job.input_key, job.upload_id).complete(clean.map((p) => ({ partNumber: p.partNumber, etag: p.etag.replace(/"/g, "") })));
    } catch {
      return err(422, "could not complete multipart upload; retry or re-upload parts");
    }
  }
  const head = await env.BUCKET.head(job.input_key);
  if (!head) return err(422, "object not found in storage");
  if (head.size !== job.file_size) {
    await failUpload(env, job, `size mismatch (declared ${job.file_size}, stored ${head.size})`);
    return err(422, "uploaded size does not match declared size; object rejected");
  }
  const first = await env.BUCKET.get(job.input_key, { range: { offset: 0, length: 16 } });
  const bytes = first ? new Uint8Array(await first.arrayBuffer()) : new Uint8Array();
  if (!looksLikeVideo(bytes)) {
    await failUpload(env, job, "file content is not a recognised video container");
    return err(422, "file content is not a recognised video container");
  }
  await env.DB.prepare("INSERT OR IGNORE INTO job_objects (job_id, object_key, object_kind, size_bytes) VALUES (?, ?, 'original', ?)").bind(job.id, job.input_key, head.size).run();
  if (!(await transition(env, job.id, "UPLOADING", "READY", ", upload_id = NULL"))) return err(409, "job state changed");
  return json({ job: publicJob(await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first()) });
}

async function failUpload(env, job, message) {
  await env.BUCKET.delete(job.input_key).catch(() => {}); // rejected object only: never a verified user upload
  await transition(env, job.id, "UPLOADING", "FAILED", ", error_message = ?", [message]);
}

async function analyze(env, userId, job) {
  if (!["READY", "FAILED"].includes(job.status)) return err(409, `job is ${job.status}`);
  if (job.status === "FAILED" && !job.input_key) return err(409, "nothing to analyze");
  if (!(await env.BUCKET.head(job.input_key))) return err(409, "source video is missing from storage");
  if (!(await rateLimit(env.DB, `analyze:${userId}`, 20, 3600))) return err(429, "rate limit exceeded");
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('QUEUED','PROCESSING')").bind(userId).first();
  if (active.n >= maxConcurrent(env)) return err(429, `at most ${maxConcurrent(env)} analyses may run at once`);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return err(503, "analysis backend is not configured");
  const prev = job.status;
  if (!(await transition(env, job.id, prev, "QUEUED", ", error_message = NULL, started_at = NULL, completed_at = NULL, workflow_run_id = NULL"))) return err(409, "job state changed");
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW || "analyze-r2.yml"}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "rea-video-worker", "content-type": "application/json",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "byga-integration",
      // inputs are server-derived only; nothing from the client body is forwarded
      inputs: { job_id: job.id, input_key: job.input_key, output_prefix: job.result_prefix, language: job.language },
    }),
  });
  if (res.status !== 204) {
    await transition(env, job.id, "QUEUED", prev, ", error_message = ?", [`dispatch failed (HTTP ${res.status})`]);
    return err(502, "could not start the analysis workflow; try again");
  }
  return json({ job: publicJob(await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first()) }, 202);
}

async function listJobs(env, userId, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);
  const rows = await env.DB.prepare("SELECT * FROM jobs WHERE user_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT ?").bind(userId, limit).all();
  const stats = await env.DB.prepare(
    "SELECT COUNT(*) AS total, SUM(status='COMPLETED') AS completed, SUM(status='FAILED') AS failed, SUM(status IN ('QUEUED','PROCESSING')) AS running, COALESCE(SUM(file_size),0) AS bytes FROM jobs WHERE user_id = ? AND status != 'DELETED'",
  ).bind(userId).first();
  return json({ jobs: rows.results.map(publicJob), stats: { total: stats.total || 0, completed: stats.completed || 0, failed: stats.failed || 0, running: stats.running || 0, bytes: stats.bytes || 0 } });
}

async function results(env, job) {
  if (job.status !== "COMPLETED") return err(409, `job is ${job.status}`);
  const rows = await env.DB.prepare("SELECT object_key, object_kind, size_bytes FROM job_objects WHERE job_id = ? AND object_kind != 'original' ORDER BY object_key").bind(job.id).all();
  const cfg = r2cfg(env);
  const files = [];
  for (const o of rows.results) {
    if (!keyInside(o.object_key, jobPrefix(job.user_id, job.id))) continue; // defence in depth
    const name = safeFileName(o.object_key);
    files.push({
      key: o.object_key.slice(jobPrefix(job.user_id, job.id).length), kind: o.object_kind, size: o.size_bytes, name,
      url: await presignR2(cfg, { method: "GET", key: o.object_key, expires: 300, query: { "response-content-disposition": `attachment; filename="${name}"` } }),
    });
  }
  return json({ job: publicJob(job), files, expires_in: 300 });
}

async function deleteJob(env, userId, job) {
  if (job.status === "DELETED") return json({ ok: true, status: "DELETED" });
  if (["QUEUED", "PROCESSING"].includes(job.status)) return err(409, "analysis is running; wait for it to finish");
  if (job.status !== "DELETING") {
    if (!(await transition(env, job.id, ["UPLOADING", "READY", "COMPLETED", "FAILED"], "DELETING", ", delete_attempts = delete_attempts + 1"))) return err(409, "job state changed");
  } else {
    await env.DB.prepare("UPDATE jobs SET delete_attempts = delete_attempts + 1, updated_at = ? WHERE id = ?").bind(nowIso(), job.id).run();
  }
  const prefix = jobPrefix(userId, job.id); // ends with '/', so it can never match another job
  try {
    if (job.upload_id) await env.BUCKET.resumeMultipartUpload(job.input_key, job.upload_id).abort().catch(() => {});
    const keys = new Set();
    const known = await env.DB.prepare("SELECT object_key FROM job_objects WHERE job_id = ?").bind(job.id).all();
    for (const r of known.results) if (r.object_key.startsWith(prefix)) keys.add(r.object_key);
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) keys.add(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const all = [...keys];
    for (let i = 0; i < all.length; i += 1000) await env.BUCKET.delete(all.slice(i, i + 1000));
    const left = await env.BUCKET.list({ prefix, limit: 1 });
    if (left.objects.length > 0) throw new Error("objects remain after delete");
  } catch {
    await env.DB.prepare("UPDATE jobs SET error_message = ?, updated_at = ? WHERE id = ?").bind("deletion incomplete; retry delete", nowIso(), job.id).run();
    return err(502, "deletion incomplete; job stays DELETING, retry the delete", { status: "DELETING", retryable: true });
  }
  await env.DB.prepare("DELETE FROM job_objects WHERE job_id = ?").bind(job.id).run();
  await env.DB.prepare("UPDATE jobs SET status = 'DELETED', deleted_at = ?, updated_at = ?, error_message = NULL, upload_id = NULL WHERE id = ?").bind(nowIso(), nowIso(), job.id).run();
  return json({ ok: true, status: "DELETED" });
}

// ---------- internal callbacks (GitHub Actions -> Worker) ----------
async function internal(env, request, url, id, action) {
  const raw = await request.clone().text();
  try {
    await verifyCallback({ secret: env.CALLBACK_SECRET, headers: request.headers, method: request.method, path: url.pathname, body: raw, db: env.DB });
  } catch {
    return err(401, "unauthorized");
  }
  if (!JOB_ID_RE.test(id)) return err(404, "not found");
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first();
  if (!job) return err(404, "not found");
  const { value } = await readJson(request);
  const runId = value.run_id !== undefined ? String(value.run_id).replace(/[^0-9]/g, "").slice(0, 20) : null;

  if (action === "started") {
    const ok = await transition(env, id, "QUEUED", "PROCESSING", ", started_at = ?, workflow_run_id = ?", [nowIso(), runId]);
    return ok ? json({ ok: true }) : err(409, `job is ${job.status}`);
  }
  if (action === "failed") {
    const msg = String(value.message || "analysis failed").replace(/[\u0000-\u001f]/g, " ").slice(0, 500);
    const ok = await transition(env, id, ["QUEUED", "PROCESSING"], "FAILED", ", error_message = ?, workflow_run_id = COALESCE(?, workflow_run_id)", [msg, runId]);
    return ok ? json({ ok: true }) : err(409, `job is ${job.status}`);
  }
  // completed: every reported object must exist under this job's result prefix with the stated size
  if (!["QUEUED", "PROCESSING"].includes(job.status)) return err(409, `job is ${job.status}`);
  const objs = Array.isArray(value.objects) ? value.objects : [];
  if (objs.length < 1 || objs.length > 5000) return err(400, "objects must contain 1..5000 entries");
  const rp = job.result_prefix + "/";
  const verified = [];
  for (const o of objs) {
    if (!keyInside(o?.key, rp)) return err(400, "object key outside result prefix");
    const head = await env.BUCKET.head(o.key);
    if (!head) return err(422, "reported object is missing from storage");
    verified.push({ key: o.key, size: head.size });
  }
  if (!verified.some((o) => /\/report\.(html|md)$|\/breakdown\.json$/.test(o.key))) return err(422, "no report or breakdown among outputs");
  const stmts = verified.map((o) => env.DB.prepare("INSERT OR IGNORE INTO job_objects (job_id, object_key, object_kind, size_bytes) VALUES (?, ?, ?, ?)").bind(id, o.key, kindForKey(o.key), o.size));
  await env.DB.batch(stmts);
  const summary = value.summary && typeof value.summary === "object" ? JSON.stringify(value.summary).slice(0, 4000) : null;
  const ok = await transition(env, id, ["QUEUED", "PROCESSING"], "COMPLETED", ", completed_at = ?, error_message = NULL, summary_json = ?, workflow_run_id = COALESCE(?, workflow_run_id)", [nowIso(), summary, runId]);
  return ok ? json({ ok: true, objects: verified.length }) : err(409, "job state changed");
}

// ---------- router ----------
async function authenticate(env, request) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    return { userId: await userIdFromClaims(claims), email: claims.email || null };
  } catch {
    return null;
  }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") return json({ ok: true, service: "rea-video" });

  const mi = path.match(/^\/api\/internal\/jobs\/([^/]+)\/(started|completed|failed)$/);
  if (mi && method === "POST") return internal(env, request, url, mi[1], mi[2]);

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return err(503, "authentication is not configured");
  const auth = await authenticate(env, request);
  if (!auth) return err(401, "unauthorized");
  const { userId } = auth;

  if (method !== "GET" && method !== "HEAD") {
    // CSRF defence in depth: browser requests with an Origin must be same-origin
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return err(403, "cross-origin request rejected");
  }

  if (path === "/api/me" && method === "GET") return json({ email: auth.email, user_id: userId.slice(0, 8) });
  if (path === "/api/status" && method === "GET") {
    let db = false, storage = false;
    try { await env.DB.prepare("SELECT 1").first(); db = true; } catch {}
    try { await env.BUCKET.list({ limit: 1 }); storage = true; } catch {}
    return json({
      ok: db && storage, database: db, storage,
      uploads_configured: !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME),
      analysis_configured: !!(env.GITHUB_TOKEN && env.GITHUB_REPO && env.CALLBACK_SECRET),
      max_upload_bytes: maxBytes(env), version: "0.1.0",
    });
  }
  if (path === "/api/jobs" && method === "POST") return createJob(env, userId, request);
  if (path === "/api/jobs" && method === "GET") return listJobs(env, userId, url);

  const m = path.match(/^\/api\/jobs\/([^/]+)(?:\/(upload-url|upload-complete|analyze|results))?$/);
  if (m) {
    const job = await getOwnedJob(env, userId, m[1]);
    if (!job || job.status === "DELETED") return err(404, "not found");
    const sub = m[2];
    if (!sub && method === "GET") return json({ job: publicJob(job) });
    if (!sub && method === "DELETE") return deleteJob(env, userId, job);
    if (sub === "upload-url" && method === "POST") return uploadUrl(env, userId, job, request);
    if (sub === "upload-complete" && method === "POST") return uploadComplete(env, userId, job, request);
    if (sub === "analyze" && method === "POST") return analyze(env, userId, job);
    if (sub === "results" && method === "GET") return results(env, job);
  }
  return err(404, "not found");
}

// Abort multipart uploads that were never completed (does not touch verified user data).
export async function cleanupStaleUploads(env, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - 24 * 3600_000).toISOString();
  const stale = await env.DB.prepare("SELECT id, input_key, upload_id FROM jobs WHERE status = 'UPLOADING' AND created_at < ? LIMIT 50").bind(cutoff).all();
  for (const j of stale.results) {
    if (j.upload_id) await env.BUCKET.resumeMultipartUpload(j.input_key, j.upload_id).abort().catch(() => {});
    await env.DB.prepare("UPDATE jobs SET status = 'FAILED', error_message = 'upload abandoned and aborted', upload_id = NULL, updated_at = ? WHERE id = ? AND status = 'UPLOADING'").bind(nowIso(), j.id).run();
  }
  await env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(Math.floor(nowMs / 1000) - 86400).run();
  return stale.results.length;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (e) {
        if (e?.status) return err(e.status, e.message);
        console.error("unhandled", e?.name); // never log message/URLs: they may embed signed values
        return err(500, "internal error");
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : err(404, "not found");
  },
  async scheduled(_event, env) {
    await cleanupStaleUploads(env);
  },
};
