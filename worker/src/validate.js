// Input validation: filenames, sizes, magic bytes, object keys.
export const ALLOWED_EXT = ["mp4", "m4v", "mov", "mkv", "webm", "avi"];
export const ALLOWED_MIME = [
  "video/mp4",
  "video/x-m4v",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/avi",
];
export const PART_SIZE = 16 * 1024 * 1024; // 16 MiB; >= R2 minimum (5 MiB), all but last part must be equal
export const SINGLE_PUT_MAX = 64 * 1024 * 1024; // larger files use multipart
export const MAX_PARTS_PER_REQUEST = 100;
export const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // conservative; NOT benchmarked. Override with MAX_UPLOAD_BYTES.

export const JOB_ID_RE = /^[0-9a-f]{32}$/;
export const USER_ID_RE = /^[0-9a-f]{32}$/;

export function cleanFilename(name) {
  if (typeof name !== "string") return null;
  const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!base || base.length > 200) return null;
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXT.includes(ext)) return null;
  return base;
}

export function validateCreate(body, maxBytes) {
  if (!body || typeof body !== "object") return { error: "invalid body" };
  const filename = cleanFilename(body.filename);
  if (!filename) return { error: `filename must have one of: ${ALLOWED_EXT.join(", ")}` };
  const size = body.size;
  if (!Number.isInteger(size) || size <= 0) return { error: "size must be a positive integer (bytes)" };
  if (size > maxBytes) return { error: `file too large (max ${maxBytes} bytes)`, code: 413 };
  const contentType = String(body.content_type || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_MIME.includes(contentType)) return { error: "unsupported content_type" };
  const language = body.language === undefined ? "en" : body.language;
  if (!["en", "zh"].includes(language)) return { error: "language must be en or zh" };
  return { value: { filename, size, contentType, language } };
}

export function inputKey(userId, jobId) {
  return `users/${userId}/jobs/${jobId}/input/original`;
}
export function jobPrefix(userId, jobId) {
  return `users/${userId}/jobs/${jobId}/`;
}
export function resultPrefix(userId, jobId) {
  return `users/${userId}/jobs/${jobId}/results`;
}

/** True only if `key` is a safe, normalized key strictly inside `prefix`. */
export function keyInside(key, prefix) {
  if (typeof key !== "string" || key.length > 1024) return false;
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  if (/[\u0000-\u001f\\]/.test(key)) return false;
  return !key.slice(prefix.length).split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

export function kindForKey(key) {
  if (key.includes("/input/")) return "original";
  if (key.includes("/frames/")) return "frame";
  if (/\/(stems|audio)\//.test(key)) return "audio";
  if (/(report|VIDEO)\.(html|md|pdf|json)$/i.test(key) || key.includes("/reports/")) return "report";
  if (/(breakdown|metadata)\.json$/i.test(key)) return "metadata";
  return "other";
}

/** Sniff container magic bytes from the first bytes of the object. */
export function looksLikeVideo(bytes) {
  if (bytes.length < 12) return false;
  const ascii = (a, b) => String.fromCharCode(...bytes.slice(a, b));
  if (ascii(4, 8) === "ftyp") return true; // mp4 / mov / m4v
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // mkv / webm
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ") return true;
  return false;
}

export function safeFileName(key) {
  return key.split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "download";
}
