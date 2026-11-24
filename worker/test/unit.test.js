import test from "node:test";
import assert from "node:assert/strict";
import { presign, presignR2 } from "../src/sigv4.js";
import { verifyAccessJwt, _resetJwksCache, verifyCallback, hmacHex, callbackSigningString } from "../src/auth.js";
import { cleanFilename, keyInside, looksLikeVideo, validateCreate, kindForKey } from "../src/validate.js";
import { makeAccess, makeDb, mp4Bytes } from "./helpers.js";

test("SigV4 presign reproduces the AWS documented reference signature", async () => {
  const url = await presign({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expires: 86400, now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  await assert.rejects(() => presign({ method: "GET", host: "h", path: "/", accessKeyId: "a", secretAccessKey: "b", expires: 0 }), /expires/);
});

test("R2 presign encodes keys and includes extra query params", async () => {
  const url = await presignR2({ accountId: "acc", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK" },
    { method: "PUT", key: "users/u/jobs/j/input/original", query: { partNumber: "2", uploadId: "x y" }, now: new Date("2026-01-01T00:00:00Z") });
  assert.ok(url.startsWith("https://acc.r2.cloudflarestorage.com/b/users/u/jobs/j/input/original?"));
  assert.match(url, /partNumber=2/); assert.match(url, /uploadId=x%20y/); assert.match(url, /X-Amz-Expires=300/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
  await assert.rejects(() => presignR2({}, { method: "GET", key: "k" }), /not configured/);
});

test("Access JWT: valid, wrong audience, wrong issuer, expired, bad signature, unknown kid", async () => {
  const a = await makeAccess();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ keys: [a.jwk] }) });
  const opts = { teamDomain: a.team, aud: a.aud, fetchImpl };
  _resetJwksCache();
  const claims = await verifyAccessJwt(await a.token("alice"), opts);
  assert.equal(claims.sub, "alice");
  for (const [over, re] of [[{ aud: ["other"] }, /audience/], [{ iss: "https://evil.example.com" }, /issuer/], [{ exp: 1 }, /expired/], [{ sub: "" }, /subject/]]) {
    await assert.rejects(async () => verifyAccessJwt(await a.token("bob", over), opts), re);
  }
  const other = await makeAccess();
  await assert.rejects(async () => verifyAccessJwt(await a.token("eve", {}, other.pair.privateKey), opts), /signature/);
  await assert.rejects(() => verifyAccessJwt("a.b.c", opts));
  await assert.rejects(() => verifyAccessJwt("x", { ...opts, aud: undefined }), /not configured/);
});

test("callback HMAC: valid, tampered body, stale, replay, short secret", async () => {
  const db = makeDb(); const secret = "s".repeat(40); const path = "/api/internal/jobs/abc/started"; const body = '{"run_id":1}';
  const sign = async (ts, nonce, b = body) => {
    const h = new Headers({ "x-rea-timestamp": String(ts), "x-rea-nonce": nonce, "x-rea-signature": await hmacHex(secret, await callbackSigningString(ts, nonce, "POST", path, b)) });
    return h;
  };
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyCallback({ secret, headers: await sign(now, "n".repeat(20)), method: "POST", path, body, db }), true);
  await assert.rejects(async () => verifyCallback({ secret, headers: await sign(now, "n".repeat(20)), method: "POST", path, body, db }), /replayed/);
  await assert.rejects(async () => verifyCallback({ secret, headers: await sign(now, "m".repeat(20)), method: "POST", path, body: body + " ", db }), /signature/);
  await assert.rejects(async () => verifyCallback({ secret, headers: await sign(now - 1000, "p".repeat(20)), method: "POST", path, body, db }), /stale/);
  await assert.rejects(async () => verifyCallback({ secret: "short", headers: await sign(now, "q".repeat(20)), method: "POST", path, body, db }), /not configured/);
});

test("validation: filenames, create body, keys, magic bytes", () => {
  assert.equal(cleanFilename("../../etc/passwd.mp4"), "passwd.mp4");
  assert.equal(cleanFilename("a.exe"), null); assert.equal(cleanFilename("noext"), null);
  const ok = { filename: "a.mp4", size: 10, content_type: "video/mp4" };
  assert.ok(validateCreate(ok, 100).value);
  assert.equal(validateCreate({ ...ok, size: 101 }, 100).code, 413);
  assert.ok(validateCreate({ ...ok, size: 1.5 }, 100).error); assert.ok(validateCreate({ ...ok, content_type: "text/html" }, 100).error);
  assert.ok(validateCreate({ ...ok, language: "fr" }, 100).error);
  const p = "users/u/jobs/j/";
  assert.ok(keyInside(p + "results/report.html", p));
  for (const bad of [p, p + "../x", p + "a//b", "users/u/jobs/other/x", p + "a\\b", p + "./x", 5]) assert.equal(keyInside(bad, p), false, String(bad));
  assert.ok(looksLikeVideo(mp4Bytes())); assert.equal(looksLikeVideo(new TextEncoder().encode("<html>not video at all")), false);
  assert.equal(kindForKey("users/u/jobs/j/results/frames/a.jpg"), "frame");
  assert.equal(kindForKey("users/u/jobs/j/results/report.html"), "report");
  assert.equal(kindForKey("users/u/jobs/j/results/breakdown.json"), "metadata");
});
