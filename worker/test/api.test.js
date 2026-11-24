import test from "node:test";
import assert from "node:assert/strict";
import worker, { cleanupStaleUploads } from "../src/index.js";
import { _resetJwksCache, hmacHex, callbackSigningString } from "../src/auth.js";
import { FakeR2, installFetch, makeAccess, makeDb, mp4Bytes } from "./helpers.js";
import { PART_SIZE } from "../src/validate.js";

const SECRET = "c".repeat(48);

async function setup(over = {}, githubStatus = 204) {
  _resetJwksCache();
  const access = await makeAccess();
  const env = {
    DB: makeDb(), BUCKET: new FakeR2(), ACCESS_TEAM_DOMAIN: access.team, ACCESS_AUD: access.aud,
    R2_ACCOUNT_ID: "acc", R2_BUCKET_NAME: "rea-video-storage", R2_ACCESS_KEY_ID: "AK", R2_SECRET_ACCESS_KEY: "SK",
    GITHUB_TOKEN: "ghp_test", GITHUB_REPO: "harvey-moeid/rea-video", GITHUB_REF: "byga-integration", CALLBACK_SECRET: SECRET,
    MAX_UPLOAD_BYTES: String(PART_SIZE * 8), ...over,
  };
  const net = installFetch([
    ["cloudflareaccess.com", async () => new Response(JSON.stringify({ keys: [access.jwk] }), { status: 200 })],
    ["api.github.com", async () => new Response(null, { status: githubStatus })],
  ]);
  const call = async (who, method, path, body, headers = {}) => {
    const h = { "content-type": "application/json", ...headers };
    if (who) h["cf-access-jwt-assertion"] = await access.token(who);
    const res = await worker.fetch(new Request("https://app.test" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const callback = async (id, action, payload, { secret = SECRET, nonce = crypto.randomUUID().replaceAll("-", ""), ts = Math.floor(Date.now() / 1000) } = {}) => {
    const path = `/api/internal/jobs/${id}/${action}`; const body = JSON.stringify(payload);
    const sig = await hmacHex(secret, await callbackSigningString(ts, nonce, "POST", path, body));
    const res = await worker.fetch(new Request("https://app.test" + path, { method: "POST", body, headers: { "x-rea-timestamp": String(ts), "x-rea-nonce": nonce, "x-rea-signature": sig } }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { env, call, callback, net };
}

const create = (call, who = "alice", over = {}) => call(who, "POST", "/api/jobs", { filename: "clip.mp4", size: 2048, content_type: "video/mp4", ...over });

async function readyJob(ctx, who = "alice") {
  const c = await create(ctx.call, who); assert.equal(c.status, 201);
  const id = c.body.job.id; const key = (await ctx.env.DB.prepare("SELECT input_key FROM jobs WHERE id=?").bind(id).first()).input_key;
  await ctx.env.BUCKET.put(key, mp4Bytes(2048));
  const done = await ctx.call(who, "POST", `/api/jobs/${id}/upload-complete`, {});
  assert.equal(done.status, 200); assert.equal(done.body.job.status, "READY");
  return { id, key };
}

test("health is public; everything else requires a valid Access JWT", async () => {
  const ctx = await setup();
  assert.equal((await ctx.call(null, "GET", "/api/health")).status, 200);
  assert.equal((await ctx.call(null, "GET", "/api/jobs")).status, 401);
  const bad = await worker.fetch(new Request("https://app.test/api/jobs", { headers: { "cf-access-jwt-assertion": "x.y.z" } }), ctx.env);
  assert.equal(bad.status, 401);
  const unconfigured = await setup({ ACCESS_AUD: "" });
  assert.equal((await unconfigured.call("alice", "GET", "/api/jobs")).status, 503);
  ctx.net.restore();
});

test("full lifecycle: create -> upload -> analyze -> callbacks -> results -> delete -> storage empty", async () => {
  const ctx = await setup();
  const c = await create(ctx.call, "alice", { language: "zh" });
  assert.equal(c.body.upload.mode, "single");
  const id = c.body.job.id;
  const up = await ctx.call("alice", "POST", `/api/jobs/${id}/upload-url`, {});
  assert.equal(up.status, 200); assert.match(up.body.url, /^https:\/\/acc\.r2\.cloudflarestorage\.com\/rea-video-storage\/users\/[0-9a-f]{32}\/jobs\/[0-9a-f]{32}\/input\/original\?/);
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/analyze`)).status, 409); // not uploaded yet
  const key = (await ctx.env.DB.prepare("SELECT input_key FROM jobs WHERE id=?").bind(id).first()).input_key;
  await ctx.env.BUCKET.put(key, mp4Bytes(2048));
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, {})).body.job.status, "READY");
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, {})).status, 200); // idempotent

  const an = await ctx.call("alice", "POST", `/api/jobs/${id}/analyze`);
  assert.equal(an.status, 202); assert.equal(an.body.job.status, "QUEUED");
  const dispatch = ctx.net.calls.find((x) => x.url.includes("api.github.com"));
  assert.match(dispatch.url, /harvey-moeid\/rea-video\/actions\/workflows\/analyze-r2\.yml\/dispatches$/);
  const sent = JSON.parse(dispatch.init.body);
  assert.equal(sent.ref, "byga-integration");
  assert.deepEqual(Object.keys(sent.inputs).sort(), ["input_key", "job_id", "language", "output_prefix"]);
  assert.equal(sent.inputs.input_key, key); assert.equal(sent.inputs.language, "zh");
  assert.equal(sent.inputs.output_prefix, key.replace("/input/original", "/results"));

  assert.equal((await ctx.callback(id, "started", { run_id: 123 })).status, 200);
  assert.equal((await ctx.call("alice", "GET", `/api/jobs/${id}`)).body.job.status, "PROCESSING");
  assert.equal((await ctx.call("alice", "DELETE", `/api/jobs/${id}`)).status, 409); // cannot delete while running

  const rp = sent.inputs.output_prefix;
  await ctx.env.BUCKET.put(`${rp}/report.html`, new TextEncoder().encode("<html>r</html>"));
  await ctx.env.BUCKET.put(`${rp}/breakdown.json`, new TextEncoder().encode("{}"));
  await ctx.env.BUCKET.put(`${rp}/frames/f1.jpg`, new Uint8Array([1, 2, 3]));
  const objects = [`${rp}/report.html`, `${rp}/breakdown.json`, `${rp}/frames/f1.jpg`].map((k) => ({ key: k }));
  const done = await ctx.callback(id, "completed", { objects, summary: { shots: 1 } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const r = await ctx.call("alice", "GET", `/api/jobs/${id}/results`);
  assert.equal(r.body.files.length, 3); assert.ok(r.body.files.every((f) => f.url.includes("X-Amz-Signature=")));
  assert.equal(r.body.job.summary.shots, 1);
  assert.ok(!JSON.stringify(r.body).includes("SK"), "secret must not leak");
  const list = await ctx.call("alice", "GET", "/api/jobs");
  assert.deepEqual(list.body.stats, { total: 1, completed: 1, failed: 0, running: 0, bytes: 2048 });

  const del = await ctx.call("alice", "DELETE", `/api/jobs/${id}`);
  assert.deepEqual(del.body, { ok: true, status: "DELETED" });
  assert.equal(ctx.env.BUCKET.objects.size, 0);
  assert.equal((await ctx.env.DB.prepare("SELECT COUNT(*) n FROM job_objects").first()).n, 0);
  assert.equal((await ctx.call("alice", "GET", `/api/jobs/${id}`)).status, 404);
  assert.equal((await ctx.call("alice", "GET", "/api/jobs")).body.jobs.length, 0);
  ctx.net.restore();
});

test("IDOR: another user cannot see, upload to, analyze, fetch or delete a job", async () => {
  const ctx = await setup();
  const { id, key } = await readyJob(ctx, "alice");
  for (const [m, p] of [["GET", ""], ["POST", "/upload-url"], ["POST", "/upload-complete"], ["POST", "/analyze"], ["GET", "/results"], ["DELETE", ""]]) {
    const res = await ctx.call("mallory", m, `/api/jobs/${id}${p}`, m === "POST" ? {} : undefined);
    assert.equal(res.status, 404, `${m} ${p}`);
  }
  assert.ok(ctx.env.BUCKET.objects.has(key));
  assert.equal((await ctx.call("mallory", "GET", "/api/jobs")).body.jobs.length, 0);
  assert.equal((await ctx.call("alice", "GET", "/api/jobs/not-an-id")).status, 404);
  ctx.net.restore();
});

test("create validation, idempotency and rate limit", async () => {
  const ctx = await setup();
  assert.equal((await create(ctx.call, "alice", { filename: "x.exe" })).status, 400);
  assert.equal((await create(ctx.call, "alice", { size: PART_SIZE * 9 })).status, 413);
  assert.equal((await create(ctx.call, "alice", { content_type: "text/html" })).status, 400);
  const h = { "idempotency-key": "idem-key-0001" };
  const a = await ctx.call("alice", "POST", "/api/jobs", { filename: "a.mp4", size: 10, content_type: "video/mp4" }, h);
  const b = await ctx.call("alice", "POST", "/api/jobs", { filename: "a.mp4", size: 10, content_type: "video/mp4" }, h);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(b.body.job.id, a.body.job.id); assert.equal(b.headers.get("idempotent-replay"), "true");
  const c = await ctx.call("alice", "POST", "/api/jobs", { filename: "other.mp4", size: 10, content_type: "video/mp4" }, h);
  assert.equal(c.status, 422);
  assert.equal((await ctx.env.DB.prepare("SELECT COUNT(*) n FROM jobs").first()).n, 1);
  const cross = await ctx.call("alice", "POST", "/api/jobs", { filename: "a.mp4", size: 10, content_type: "video/mp4" }, { ...h, origin: "https://evil.test" });
  assert.equal(cross.status, 403);
  let last; for (let i = 0; i < 31; i++) last = await create(ctx.call, "bob");
  assert.equal(last.status, 429);
  ctx.net.restore();
});

test("upload-complete rejects size mismatch and non-video content, removing the rejected object", async () => {
  const ctx = await setup();
  let c = await create(ctx.call); let id = c.body.job.id;
  let key = (await ctx.env.DB.prepare("SELECT input_key FROM jobs WHERE id=?").bind(id).first()).input_key;
  await ctx.env.BUCKET.put(key, mp4Bytes(999));
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, {})).status, 422);
  assert.equal(ctx.env.BUCKET.objects.has(key), false);
  assert.equal((await ctx.call("alice", "GET", `/api/jobs/${id}`)).body.job.status, "FAILED");

  c = await create(ctx.call); id = c.body.job.id;
  key = (await ctx.env.DB.prepare("SELECT input_key FROM jobs WHERE id=?").bind(id).first()).input_key;
  await ctx.env.BUCKET.put(key, new TextEncoder().encode("<html>".padEnd(2048, "x")));
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, {})).status, 422);
  c = await create(ctx.call); id = c.body.job.id;
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, {})).status, 422); // nothing uploaded
  ctx.net.restore();
});

test("multipart upload: part URLs, complete with etags, validation of part list", async () => {
  const ctx = await setup();
  const big = await create(ctx.call, "alice", { size: PART_SIZE * 5 + 10 });
  assert.equal(big.body.upload.mode, "multipart"); assert.equal(big.body.upload.parts, 6);
  const id = big.body.job.id;
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-url`, { part_numbers: [7] })).status, 400);
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-url`, { part_numbers: [] })).status, 400);
  const u = await ctx.call("alice", "POST", `/api/jobs/${id}/upload-url`, { part_numbers: [1, 2, 3, 4, 5, 6] });
  assert.equal(u.status, 200); assert.equal(u.body.parts.length, 6);
  assert.match(u.body.parts[1].url, /partNumber=2&uploadId=mpu0/);
  const row = await ctx.env.DB.prepare("SELECT upload_id, input_key FROM jobs WHERE id=?").bind(id).first();
  assert.equal(row.upload_id, "mpu0");
  const again = await ctx.call("alice", "POST", `/api/jobs/${id}/upload-url`, { part_numbers: [1] });
  assert.match(again.body.parts[0].url, /uploadId=mpu0/); assert.equal(ctx.env.BUCKET.uploads.size, 1);
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, { parts: [{ part_number: 1, etag: "abcdef12" }] })).status, 400);

  const up = ctx.env.BUCKET.uploads.get("mpu0");
  const first = mp4Bytes(PART_SIZE);
  up.parts.set(1, first); for (let n = 2; n <= 5; n++) up.parts.set(n, new Uint8Array(PART_SIZE)); up.parts.set(6, new Uint8Array(10));
  const parts = [1, 2, 3, 4, 5, 6].map((n) => ({ part_number: n, etag: `"etag${String(n).padStart(8, "0")}"` }));
  const done = await ctx.call("alice", "POST", `/api/jobs/${id}/upload-complete`, { parts });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.body.job.status, "READY");
  ctx.net.restore();
});

test("analysis: concurrency cap, dispatch failure reverts, callbacks require valid HMAC and state", async () => {
  const ctx = await setup({ MAX_CONCURRENT_JOBS: "1" });
  const a = await readyJob(ctx), b = await readyJob(ctx);
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${a.id}/analyze`)).status, 202);
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${b.id}/analyze`)).status, 429);
  ctx.net.restore();

  const bad = await setup({}, 403);
  const r = await readyJob(bad);
  const res = await bad.call("alice", "POST", `/api/jobs/${r.id}/analyze`);
  assert.equal(res.status, 502);
  const j = (await bad.call("alice", "GET", `/api/jobs/${r.id}`)).body.job;
  assert.equal(j.status, "READY"); assert.match(j.error, /dispatch failed/);
  bad.net.restore();
});

test("callbacks: bad signature, replay, wrong state, outside-prefix and missing objects are rejected", async () => {
  const ctx = await setup();
  const { id } = await readyJob(ctx);
  assert.equal((await ctx.callback(id, "started", {}, { secret: "x".repeat(48) })).status, 401);
  assert.equal((await ctx.callback(id, "started", {})).status, 409); // READY, not QUEUED
  await ctx.call("alice", "POST", `/api/jobs/${id}/analyze`);
  const nonce = "n".repeat(24);
  assert.equal((await ctx.callback(id, "started", {}, { nonce })).status, 200);
  assert.equal((await ctx.callback(id, "started", {}, { nonce })).status, 401); // replay
  assert.equal((await ctx.callback(id, "started", {}, { ts: 1700000000 })).status, 401); // stale
  const rp = (await ctx.env.DB.prepare("SELECT result_prefix FROM jobs WHERE id=?").bind(id).first()).result_prefix;
  assert.equal((await ctx.callback(id, "completed", { objects: [{ key: "users/zzz/jobs/other/results/report.html" }] })).status, 400);
  assert.equal((await ctx.callback(id, "completed", { objects: [{ key: `${rp}/../../x/report.html` }] })).status, 400);
  assert.equal((await ctx.callback(id, "completed", { objects: [{ key: `${rp}/report.html` }] })).status, 422); // missing in R2
  await ctx.env.BUCKET.put(`${rp}/frames/a.jpg`, new Uint8Array([1]));
  assert.equal((await ctx.callback(id, "completed", { objects: [{ key: `${rp}/frames/a.jpg` }] })).status, 422); // no report
  assert.equal((await ctx.callback(id, "failed", { message: "boom\n".repeat(300) })).status, 200);
  const j = (await ctx.call("alice", "GET", `/api/jobs/${id}`)).body.job;
  assert.equal(j.status, "FAILED"); assert.ok(j.error.length <= 500);
  assert.equal((await ctx.callback(id, "completed", { objects: [] })).status, 409);
  assert.equal((await ctx.callback("f".repeat(32), "started", {})).status, 404);
  // failed jobs can be retried
  assert.equal((await ctx.call("alice", "POST", `/api/jobs/${id}/analyze`)).status, 202);
  ctx.net.restore();
});

test("delete: partial failure keeps DELETING and is retryable; never touches another job", async () => {
  const ctx = await setup();
  const a = await readyJob(ctx, "alice"), b = await readyJob(ctx, "alice");
  const prefixA = a.key.replace("input/original", "");
  await ctx.env.BUCKET.put(prefixA + "results/report.html", new Uint8Array([1]));
  await ctx.env.BUCKET.put(prefixA + "results/frames/f.jpg", new Uint8Array([1]));
  ctx.env.BUCKET.failDelete.add(prefixA + "results/frames/f.jpg");
  const first = await ctx.call("alice", "DELETE", `/api/jobs/${a.id}`);
  assert.equal(first.status, 502); assert.equal(first.body.retryable, true);
  assert.equal((await ctx.env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(a.id).first()).status, "DELETING");
  assert.ok(ctx.env.BUCKET.objects.has(b.key), "other job untouched");
  ctx.env.BUCKET.failDelete.clear();
  const second = await ctx.call("alice", "DELETE", `/api/jobs/${a.id}`);
  assert.equal(second.body.status, "DELETED");
  assert.equal([...ctx.env.BUCKET.objects.keys()].some((k) => k.startsWith(prefixA)), false);
  assert.ok(ctx.env.BUCKET.objects.has(b.key));
  assert.equal((await ctx.env.DB.prepare("SELECT delete_attempts n FROM jobs WHERE id=?").bind(a.id).first()).n, 2);
  ctx.net.restore();
});

test("stale unfinished uploads are aborted and marked FAILED; verified jobs untouched", async () => {
  const ctx = await setup();
  const big = await create(ctx.call, "alice", { size: PART_SIZE * 5 + 10 });
  await ctx.call("alice", "POST", `/api/jobs/${big.body.job.id}/upload-url`, { part_numbers: [1] });
  const ok = await readyJob(ctx, "alice");
  await ctx.env.DB.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00.000Z'").run();
  assert.equal(await cleanupStaleUploads(ctx.env), 1);
  assert.equal(ctx.env.BUCKET.uploads.get("mpu0").aborted, true);
  assert.equal((await ctx.call("alice", "GET", `/api/jobs/${big.body.job.id}`)).body.job.status, "FAILED");
  assert.equal((await ctx.call("alice", "GET", `/api/jobs/${ok.id}`)).body.job.status, "READY");
  assert.ok(ctx.env.BUCKET.objects.has(ok.key));
  ctx.net.restore();
});
