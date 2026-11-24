// Password login (HMAC-signed session cookie) + HMAC verification for GitHub Actions callbacks.
import { sha256Hex } from "./sigv4.js";

const enc = new TextEncoder();

const toB64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const SESSION_COOKIE = "rea_session";
export const SESSION_TTL_SEC = 30 * 24 * 3600;
export const MIN_PASSWORD_LENGTH = 8;
export const MIN_SESSION_SECRET_LENGTH = 32;

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison: HMAC both values under a throwaway random key, then compare the digests. */
export async function safeEqual(a, b) {
  const rk = crypto.getRandomValues(new Uint8Array(32));
  const k = await crypto.subtle.importKey("raw", rk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([crypto.subtle.sign("HMAC", k, enc.encode(String(a))), crypto.subtle.sign("HMAC", k, enc.encode(String(b)))]);
  return toHex(x) === toHex(y);
}

/** Login is only enabled when both secrets are set and long enough (fails closed otherwise). */
export function authConfigured(env) {
  return typeof env.AUTH_PASSWORD === "string" && env.AUTH_PASSWORD.length >= MIN_PASSWORD_LENGTH
    && typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= MIN_SESSION_SECRET_LENGTH;
}

export async function checkPassword(env, candidate) {
  if (!authConfigured(env) || typeof candidate !== "string" || candidate.length === 0 || candidate.length > 256) {
    // still burn comparable time so a wrong-shape request is not distinguishable by latency
    await safeEqual("x", "y");
    return false;
  }
  return safeEqual(env.AUTH_PASSWORD, candidate);
}

// The signing key depends on BOTH secrets, so changing the password (or the session secret) logs everyone out.
// It is derived rather than stored in the cookie, so the cookie never carries anything password-related.
const sessionKey = (env) => hmacHex(env.SESSION_SECRET, `rea-video:session-key:${env.AUTH_PASSWORD}`);

export async function createSession(env, nowSec = Math.floor(Date.now() / 1000)) {
  const payload = toB64url(enc.encode(JSON.stringify({ sub: "owner", iat: nowSec, exp: nowSec + SESSION_TTL_SEC })));
  const sig = await hmacHex(await sessionKey(env), payload);
  return { value: `${payload}.${sig}`, maxAge: SESSION_TTL_SEC };
}

function readCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Returns { userId } for a valid, unexpired session cookie, otherwise null. Never throws. */
export async function verifySession(env, cookieHeader, nowSec = Math.floor(Date.now() / 1000)) {
  try {
    if (!authConfigured(env)) return null;
    const raw = readCookie(cookieHeader, SESSION_COOKIE);
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[1])) return null;
    const expected = await hmacHex(await sessionKey(env), parts[0]);
    if (!(await safeEqual(expected, parts[1]))) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    if (claims.sub !== "owner" || typeof claims.exp !== "number" || claims.exp <= nowSec) return null;
    if (typeof claims.iat === "number" && claims.iat > nowSec + 60) return null;
    return { userId: await ownerUserId() };
  } catch {
    return null;
  }
}

/** Opaque, stable, key-safe id of the single account that owns every job. */
export async function ownerUserId() {
  return (await sha256Hex("rea-video:user:owner")).slice(0, 32);
}

/** Canonical string the GitHub runner signs: ts.nonce.METHOD.path.sha256(body) */
export async function callbackSigningString(ts, nonce, method, path, body) {
  return `${ts}.${nonce}.${method}.${path}.${await sha256Hex(body)}`;
}

/**
 * Verify server-to-server callback. Replay protection: timestamp window + single-use nonce (stored in D1).
 * Returns true or throws.
 */
export async function verifyCallback({ secret, headers, method, path, body, db, nowMs = Date.now() }) {
  if (!secret || secret.length < 32) throw new Error("callback secret not configured");
  const ts = headers.get("x-rea-timestamp");
  const nonce = headers.get("x-rea-nonce");
  const sig = headers.get("x-rea-signature");
  if (!ts || !nonce || !sig || !/^\d{10}$/.test(ts) || !/^[A-Za-z0-9_-]{16,80}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) {
    throw new Error("bad callback headers");
  }
  if (Math.abs(nowMs / 1000 - Number(ts)) > 300) throw new Error("stale timestamp");
  const expected = await hmacHex(secret, await callbackSigningString(ts, nonce, method, path, body));
  if (!(await safeEqual(expected, sig))) throw new Error("bad signature");
  await db.prepare("DELETE FROM callback_nonces WHERE created_at < ?").bind(Math.floor(nowMs / 1000) - 900).run();
  try {
    await db.prepare("INSERT INTO callback_nonces (nonce, created_at) VALUES (?, ?)").bind(nonce, Math.floor(nowMs / 1000)).run();
  } catch {
    throw new Error("replayed nonce");
  }
  return true;
}
