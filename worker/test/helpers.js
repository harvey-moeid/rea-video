// Test doubles: real SQLite (node:sqlite) behind a D1-shaped API, and an in-memory R2.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const here = new URL("../schema/", import.meta.url);

export function makeDb() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("0001_baseline.sql", here), "utf8"));
  sql.exec(readFileSync(new URL("0002_api_support.sql", here), "utf8"));
  const wrap = (query, args = []) => ({
    bind: (...a) => wrap(query, a),
    first: async () => sql.prepare(query).get(...args) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
  });
  return {
    raw: sql,
    prepare: (q) => wrap(q),
    batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

export class FakeR2 {
  constructor() { this.objects = new Map(); this.uploads = new Map(); this.failDelete = new Set(); }
  async head(key) { const o = this.objects.get(key); return o ? { key, size: o.bytes.length } : null; }
  async get(key, opts) {
    const o = this.objects.get(key); if (!o) return null;
    const r = opts?.range; const b = r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes;
    return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
  async put(key, bytes) { this.objects.set(key, { bytes: new Uint8Array(bytes) }); }
  async delete(keys) {
    for (const k of [].concat(keys)) { if (this.failDelete.has(k)) throw new Error("injected delete failure"); this.objects.delete(k); }
  }
  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0; const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return { objects: page.map((key) => ({ key, size: this.objects.get(key).bytes.length })), truncated, cursor: truncated ? String(start + limit) : undefined };
  }
  async createMultipartUpload(key) {
    const uploadId = "mpu" + this.uploads.size; this.uploads.set(uploadId, { key, parts: new Map(), aborted: false });
    return this.resumeMultipartUpload(key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) {
    const u = this.uploads.get(uploadId);
    return {
      uploadId,
      abort: async () => { u.aborted = true; },
      complete: async (parts) => {
        const bufs = parts.map((p) => { const b = u.parts.get(p.partNumber); if (!b) throw new Error("missing part"); return b; });
        const total = bufs.reduce((n, b) => n + b.length, 0); const out = new Uint8Array(total); let o = 0;
        for (const b of bufs) { out.set(b, o); o += b.length; }
        this.objects.set(key, { bytes: out });
      },
    };
  }
}

export function mp4Bytes(n = 2048) {
  const b = new Uint8Array(n); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]); return b; // "....ftypisom"
}

export function installFetch(handlers) {
  const real = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [match, fn] of handlers) if (String(url).includes(match)) return fn(url, init);
    throw new Error("unexpected fetch " + url);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
