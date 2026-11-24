// AWS Signature V4 query-string presigning for the Cloudflare R2 S3 API.
// No dependencies; uses WebCrypto only. Never log the URLs this produces.
const enc = new TextEncoder();

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data));
}

// RFC 3986 encoding as required by SigV4.
export function uriEncode(s, keepSlash = false) {
  return [...enc.encode(s)]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c)) return c;
      if (c === "/" && keepSlash) return c;
      return "%" + b.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

/**
 * Presign a request. Path-style for R2: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
 * Pass `host`, `path` and `region` explicitly to test against AWS reference vectors.
 */
export async function presign({
  method,
  host,
  path,
  region = "auto",
  service = "s3",
  accessKeyId,
  secretAccessKey,
  expires = 300,
  query = {},
  now = new Date(),
}) {
  if (!(expires >= 1 && expires <= 604800)) throw new Error("expires out of range");
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
    ...query,
  };
  const canonicalQuery = Object.entries(params)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  let k = await hmac(enc.encode("AWS4" + secretAccessKey), date);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, "aws4_request");
  const signature = toHex(await hmac(k, stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Presign an R2 object operation (GET / PUT / UploadPart). */
export async function presignR2(cfg, { method, key, expires = 300, query = {}, now }) {
  if (!cfg.accountId || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error("R2 S3 credentials are not configured");
  }
  return presign({
    method,
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    path: `/${cfg.bucket}/${uriEncode(key, true)}`,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    expires,
    query,
    now,
  });
}
