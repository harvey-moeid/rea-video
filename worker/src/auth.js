// Cloudflare Access JWT verification (RS256) + HMAC verification for GitHub Actions callbacks.
import { sha256Hex } from "./sigv4.js";

const enc = new TextEncoder();
const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

let jwksCache = { at: 0, keys: null, domain: null };

export function _resetJwksCache() {
  jwksCache = { at: 0, keys: null, domain: null };
}

async function loadJwks(teamDomain, fetchImpl, force) {
  const fresh = jwksCache.keys && jwksCache.domain === teamDomain && Date.now() - jwksCache.at < 3600_000;
  if (fresh && !force) return jwksCache.keys;
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("jwks fetch failed");
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys, domain: teamDomain };
  return keys;
}

/** Returns verified claims or throws. Fails closed. */
export async function verifyAccessJwt(token, { teamDomain, aud, fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!teamDomain || !aud) throw new Error("access not configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlToJson(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported alg");
  let keys = await loadJwks(teamDomain, fetchImpl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadJwks(teamDomain, fetchImpl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("bad signature");
  const claims = b64urlToJson(parts[1]);
  if (claims.iss !== `https://${teamDomain}`) throw new Error("bad issuer");
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud;
  if (!audOk) throw new Error("bad audience");
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + 30) throw new Error("not yet valid");
  if (!claims.sub) throw new Error("no subject");
  return claims;
}

/** Opaque, stable, key-safe user id derived from the verified Access subject. */
export async function userIdFromClaims(claims) {
  return (await sha256Hex(`rea-video:user:${claims.sub}`)).slice(0, 32);
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
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
  // constant-time compare via HMAC of both values under a random key
  const rk = crypto.getRandomValues(new Uint8Array(32));
  const k = await crypto.subtle.importKey("raw", rk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [a, b] = await Promise.all([crypto.subtle.sign("HMAC", k, enc.encode(expected)), crypto.subtle.sign("HMAC", k, enc.encode(sig))]);
  if (toHex(a) !== toHex(b)) throw new Error("bad signature");
  await db.prepare("DELETE FROM callback_nonces WHERE created_at < ?").bind(Math.floor(nowMs / 1000) - 900).run();
  try {
    await db.prepare("INSERT INTO callback_nonces (nonce, created_at) VALUES (?, ?)").bind(nonce, Math.floor(nowMs / 1000)).run();
  } catch {
    throw new Error("replayed nonce");
  }
  return true;
}
