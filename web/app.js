// REA VIDEO PWA. All data comes from the Worker API; videos go straight to R2 with presigned URLs.
const EXT_MIME = { mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo" };
const ACTIVE = new Set(["QUEUED", "PROCESSING", "UPLOADING", "DELETING"]);
const $app = document.getElementById("app");
const uploads = new Map(); // jobId -> { file, pct, state, error, etags, abort }
let serverStatus = null;
let pollTimer = null;

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) el.append(k instanceof Node ? k : document.createTextNode(String(k ?? "")));
  return el;
}
const fmtBytes = (n) => (n == null ? "—" : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const fmtDate = (s) => (s ? new Date(s).toLocaleString() : "—");
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 4000);
}
async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch(path, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Cannot reach the server. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // expired or missing session anywhere in the app -> back to the password screen
    if (res.status === 401 && path !== "/api/login") showLogin(serverStatus ? "Session expired. Please sign in again." : "");
    const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e;
  }
  return data;
}

// ---------- login ----------
function showLogin(message) {
  clearTimeout(pollTimer);
  document.body.classList.add("anon");
  const input = h("input", { id: "pw", type: "password", name: "password", autocomplete: "current-password", required: true, maxlength: 256 });
  const msg = h("p", { class: "small err", role: "alert" }, message || "");
  const btn = h("button", { class: "btn", type: "submit" }, "Sign in");
  const form = h("form", { class: "card login" }, h("h1", {}, "Sign in"), h("label", { class: "small muted", for: "pw" }, "Password"), input, msg, btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true; msg.textContent = "";
    try {
      await api("POST", "/api/login", { password: input.value });
      document.body.classList.remove("anon");
      serverStatus = null;
      route();
    } catch (err) {
      msg.textContent = err.message; btn.disabled = false; input.select();
    }
  });
  mount(form);
  input.focus();
}
const mount = (...kids) => $app.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const badge = (s) => h("span", { class: `badge ${s}` }, s);

// ---------- upload ----------
function mimeFor(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  return EXT_MIME[ext] ? EXT_MIME[ext] : null;
}
function validateFile(file) {
  if (!mimeFor(file)) return `Unsupported file type. Use: ${Object.keys(EXT_MIME).join(", ")}`;
  if (file.size <= 0) return "The file is empty.";
  const max = serverStatus?.max_upload_bytes;
  if (max && file.size > max) return `File too large: ${fmtBytes(file.size)} (limit ${fmtBytes(max)}).`;
  return null;
}
function xhrPut(url, blob, contentType, onProgress, registerAbort) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    if (contentType) x.setRequestHeader("Content-Type", contentType);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.getResponseHeader("ETag")) : reject(new Error(`Storage rejected the upload (HTTP ${x.status})`)));
    x.onerror = () => reject(new Error("Network error while uploading"));
    x.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { cancelled: true }));
    registerAbort(() => x.abort());
    x.send(blob);
  });
}
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { if (e.cancelled) throw e; last = e; await new Promise((r) => setTimeout(r, 800 * 2 ** i)); }
  }
  throw last;
}
function setUpload(id, patch) {
  const u = uploads.get(id); Object.assign(u, patch);
  const bar = document.querySelector(`[data-up="${id}"] progress`); if (bar) bar.value = u.pct;
  const txt = document.querySelector(`[data-up="${id}"] .uptxt`); if (txt) txt.textContent = uploadText(u);
}
const uploadText = (u) => (u.state === "failed" ? `Failed: ${u.error}` : u.state === "done" ? "Upload complete" : `${u.state === "finishing" ? "Verifying…" : "Uploading"} ${Math.round(u.pct * 100)}%`);

async function runUpload(jobId, file, info) {
  const u = uploads.get(jobId);
  u.abortFns = new Set();
  const reg = (fn) => u.abortFns.add(fn);
  setUpload(jobId, { state: "uploading", error: null });
  try {
    if (info.mode === "single") {
      const { url } = await api("POST", `/api/jobs/${jobId}/upload-url`, {});
      await withRetry(async () => { await xhrPut(url, file, mimeFor(file), (l) => setUpload(jobId, { pct: l / file.size }), reg); });
      await api("POST", `/api/jobs/${jobId}/upload-complete`, {});
    } else {
      const partSize = info.part_size, total = info.parts;
      u.etags = u.etags || new Map(); u.loaded = u.loaded || new Array(total + 1).fill(0);
      const todo = []; for (let n = 1; n <= total; n++) if (!u.etags.has(n)) todo.push(n);
      const report = () => setUpload(jobId, { pct: u.loaded.reduce((a, b) => a + b, 0) / file.size });
      let failure = null;
      const worker = async () => {
        while (todo.length && !failure) {
          const n = todo.shift();
          try {
            const etag = await withRetry(async () => {
              const r = await api("POST", `/api/jobs/${jobId}/upload-url`, { part_numbers: [n] });
              const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
              const tag = await xhrPut(r.parts[0].url, blob, null, (l) => { u.loaded[n] = l; report(); }, reg);
              if (!tag) throw new Error("Storage did not expose the ETag header (R2 CORS must expose ETag)");
              return tag;
            });
            u.etags.set(n, etag); u.loaded[n] = Math.min(partSize, file.size - (n - 1) * partSize);
          } catch (e) { u.loaded[n] = 0; failure = failure || e; }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (failure) throw failure;
      setUpload(jobId, { state: "finishing", pct: 1 });
      const parts = [...u.etags.entries()].sort((a, b) => a[0] - b[0]).map(([part_number, etag]) => ({ part_number, etag }));
      await api("POST", `/api/jobs/${jobId}/upload-complete`, { parts });
    }
    setUpload(jobId, { state: "done", pct: 1 });
    toast("Upload complete. Open the job to start analysis.");
    uploads.delete(jobId);
    route();
  } catch (e) {
    if (e.cancelled) return;
    setUpload(jobId, { state: "failed", error: e.message });
    toast(e.message);
    render();
  }
}
async function startUpload(file) {
  const problem = validateFile(file);
  if (problem) return toast(problem);
  try {
    const created = await api("POST", "/api/jobs", { filename: file.name, size: file.size, content_type: mimeFor(file) }, { "Idempotency-Key": crypto.randomUUID() });
    uploads.set(created.job.id, { file, pct: 0, state: "uploading", error: null, info: created.upload });
    location.hash = "#/";
    runUpload(created.job.id, file, created.upload);
    route();
  } catch (e) { toast(e.message); }
}
function cancelUpload(jobId) {
  const u = uploads.get(jobId);
  if (u?.abortFns) u.abortFns.forEach((f) => { try { f(); } catch {} });
  uploads.delete(jobId);
}

// ---------- cancel a running analysis ----------
// Calls POST /api/jobs/:id/cancel. The Worker marks the job FAILED first (so late runner callbacks are rejected)
// and then asks GitHub to stop the Actions run. `runner_stopped: false` means the run could not be stopped from
// here; it ends by itself at its next callback.
async function cancelAnalysis(id, name, btn) {
  if (!confirm(`Cancel the analysis of "${name}"? The job will be marked as failed and you can start it again later.`)) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api("POST", `/api/jobs/${id}/cancel`);
    toast(r.runner_stopped ? "Analysis cancelled." : "Analysis cancelled. The GitHub run could not be stopped and will end by itself.");
  } catch (e) {
    toast(e.message);
    if (btn) btn.disabled = false;
  }
  route();
}

// ---------- results: "Download all (ZIP)" + inline report ----------
// Everything here runs in the browser only; the Worker is unchanged. Both features fetch the existing
// presigned R2 links directly, so the R2 bucket's CORS policy must allow GET from this app's origin
// (see docs/results-zip-and-report.md).
const ZIP_WARN_BYTES = 500 * 1024 ** 2; // ask before building a ZIP bigger than this (heavy on phones)
const ZIP_MAX_BYTES = 2 * 1024 ** 3;    // hard stop: stay far from ZIP32 and browser Blob limits
const REPORT_RE = /(^|\/)report\.html$/i;

// Minimal "store" (no compression) ZIP writer. Result files are mostly JPEG/MP4/JSON/HTML, so deflate would
// gain little, and skipping it keeps this dependency-free (the app has no bundler).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// entries: [{ path, blob, crc }] -> Blob. Parts are referenced, not copied, so memory stays near 1x.
function buildZip(entries) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // 0x0800 = UTF-8 names
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.blob.size, true); lh.setUint32(22, e.blob.size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.blob.size, true); ch.setUint32(24, e.blob.size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + e.blob.size;
  }
  const cdSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}
// Safe, unique path inside the ZIP (no "..", no leading slash; duplicates get a numeric suffix).
function zipPath(key, used) {
  let p = String(key).split("/").filter((s) => s && s !== "." && s !== "..").join("/") || "file";
  if (used.has(p)) { const i = p.lastIndexOf("."); const [stem, ext] = i > 0 ? [p.slice(0, i), p.slice(i)] : [p, ""]; let n = 2; while (used.has(`${stem}-${n}${ext}`)) n++; p = `${stem}-${n}${ext}`; }
  used.add(p);
  return p;
}
async function fetchBlob(url) {
  const res = await fetch(url, { credentials: "omit" }); // presigned URL: never send app cookies to R2
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
async function downloadAllZip(jobId, jobName, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = "Preparing…";
    // fresh results call: presigned links expire after 5 minutes, so never reuse the ones from page load
    const { files } = await api("GET", `/api/jobs/${jobId}/results`);
    if (!files.length) return toast("No output files to download.");
    const total = files.reduce((a, f) => a + (f.size || 0), 0);
    if (total > ZIP_MAX_BYTES) return toast(`Outputs are ${fmtBytes(total)}, too large to zip in the browser (limit ${fmtBytes(ZIP_MAX_BYTES)}). Download files individually.`);
    if (total > ZIP_WARN_BYTES && !confirm(`The ZIP will be about ${fmtBytes(total)} and is built in memory. This can be slow or fail on a phone. Continue?`)) return;
    const used = new Set(), entries = new Array(files.length);
    let next = 0, done = 0, failure = null;
    const worker = async () => {
      while (!failure && next < files.length) {
        const i = next++, f = files[i];
        try {
          const blob = await withRetry(() => fetchBlob(f.url));
          entries[i] = { path: zipPath(f.key || f.name, used), blob, crc: crc32(new Uint8Array(await blob.arrayBuffer())) };
          btn.textContent = `Zipping ${++done}/${files.length}…`;
        } catch (e) { failure = failure || e; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (failure) {
      throw failure instanceof TypeError
        ? new Error("Could not fetch files from storage. The R2 bucket's CORS rule must allow GET from this site.")
        : failure;
    }
    btn.textContent = "Building ZIP…";
    const zip = buildZip(entries);
    const a = h("a", { href: URL.createObjectURL(zip), download: `${jobName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") || "results"}-results.zip` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast(`ZIP ready (${fmtBytes(zip.size)}).`);
  } catch (e) {
    toast(`ZIP failed: ${e.message}`);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// Resolve a relative reference found in report.html to the output-file key it points at.
function resolveKey(baseDir, ref) {
  let r; try { r = decodeURIComponent(ref); } catch { r = ref; }
  const out = [];
  for (const seg of (baseDir + r).split("/")) { if (seg === "..") out.pop(); else if (seg && seg !== ".") out.push(seg); }
  return out.join("/");
}
// Show report.html inside the detail page. It is fetched as text (a plain <iframe src> would trigger the
// "attachment" download header on the presigned URL), relative frame/file references are rewritten to fresh
// presigned URLs, and it renders in a sandboxed iframe with an opaque origin: scripts may run, but they
// cannot touch the app's cookies or API.
async function loadReport(files, rf, box) {
  try {
    const res = await fetch(rf.url, { credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const base = rf.key.includes("/") ? rf.key.slice(0, rf.key.lastIndexOf("/") + 1) : "";
    const byKey = new Map(files.map((f) => [f.key, f]));
    for (const el of doc.querySelectorAll("[src],[href],[poster]")) {
      for (const attr of ["src", "href", "poster"]) {
        const v = el.getAttribute(attr);
        if (!v || /^([a-z][a-z0-9+.-]*:|#|\/)/i.test(v)) continue; // absolute, data:, anchor, root-relative: leave alone
        const f = byKey.get(resolveKey(base, v.split(/[?#]/)[0]));
        if (!f) continue;
        el.setAttribute(attr, f.url);
        if (el.tagName === "A") { el.setAttribute("target", "_blank"); el.setAttribute("rel", "noopener"); }
      }
    }
    const frame = h("iframe", { class: "report-frame", title: "Report", sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox", referrerpolicy: "no-referrer" });
    frame.srcdoc = "<!doctype html>" + doc.documentElement.outerHTML;
    box.replaceChildren(
      frame,
      frame.requestFullscreen ? h("p", {}, h("button", { class: "btn ghost", onclick: () => frame.requestFullscreen().catch(() => toast("Fullscreen is not available here.")) }, "Fullscreen")) : null);
  } catch (e) {
    box.replaceChildren(h("p", { class: "small err" }, `Could not show the report here (${e instanceof TypeError ? "storage CORS must allow GET from this site" : e.message}). It is still available in Outputs below.`));
  }
}

// ---------- views ----------
function uploadCard(jobId, u) {
  return h("div", { class: "card", "data-up": jobId },
    h("div", { class: "row" }, h("b", {}, u.file.name), h("span", { class: "small muted" }, fmtBytes(u.file.size))),
    h("progress", { max: 1, value: u.pct }),
    h("div", { class: "row" },
      h("span", { class: `uptxt small ${u.state === "failed" ? "err" : "muted"}` }, uploadText(u)),
      h("span", {},
        u.state === "failed" ? h("button", { class: "btn ghost", onclick: () => runUpload(jobId, u.file, u.info) }, "Retry") : null, " ",
        h("button", { class: "btn danger", onclick: async () => { cancelUpload(jobId); try { await api("DELETE", `/api/jobs/${jobId}`); } catch (e) { toast(e.message); } route(); } }, "Cancel"))));
}

function dropZone() {
  const input = h("input", { type: "file", accept: "video/*,.mkv,.mov,.mp4,.m4v,.webm,.avi", hidden: true, onchange: () => { if (input.files[0]) startUpload(input.files[0]); input.value = ""; } });
  const zone = h("div", { class: "drop" },
    h("p", {}, "Drag a video here, or"), h("button", { class: "btn", onclick: () => input.click() }, "Choose video"), input,
    h("p", { class: "small muted" }, serverStatus ? `mp4, mov, mkv, webm, avi · up to ${fmtBytes(serverStatus.max_upload_bytes)}` : ""));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); if (e.dataTransfer.files[0]) startUpload(e.dataTransfer.files[0]); });
  return zone;
}

async function viewHome() {
  const data = await api("GET", "/api/jobs");
  const s = data.stats;
  const stat = (n, l) => h("div", { class: "stat" }, h("b", {}, n), h("span", {}, l));
  const list = data.jobs.filter((j) => !(uploads.has(j.id) && j.status === "UPLOADING"));
  mount(
    h("h1", {}, "Videos"),
    h("div", { class: "stats" }, stat(s.total, "Total jobs"), stat(s.completed, "Completed"), stat(s.failed, "Failed"), stat(s.running, "In progress")),
    dropZone(),
    ...[...uploads.entries()].map(([id, u]) => uploadCard(id, u)),
    h("h2", {}, "History"),
    list.length ? list.map(jobRow) : h("p", { class: "muted" }, "No videos yet. Upload one to get started."),
    h("p", { class: "small muted" }, `Stored: ${fmtBytes(s.bytes)} of originals. Nothing is deleted automatically.`));
  if (data.jobs.some((j) => ["QUEUED", "PROCESSING"].includes(j.status))) schedulePoll(5000);
}
function jobRow(j) {
  const running = ["QUEUED", "PROCESSING"].includes(j.status);
  return h("div", { class: "job" },
    h("div", { class: "row" }, h("span", { class: "name" }, j.filename), badge(j.status)),
    h("div", { class: "small muted" }, `${fmtBytes(j.size)} · ${fmtDate(j.created_at)}`),
    j.error ? h("div", { class: "small err" }, j.error) : null,
    h("div", { class: "row" },
      h("a", { class: "btn ghost", href: `#/job/${j.id}`, style: "text-decoration:none" }, "Details"),
      running ? h("button", { class: "btn danger", onclick: (e) => cancelAnalysis(j.id, j.filename, e.currentTarget) }, "Cancel analysis") : null,
      h("button", { class: "btn danger", disabled: running, onclick: () => removeJob(j.id, j.filename) }, "Delete")));
}
async function removeJob(id, name) {
  if (!confirm(`Delete "${name}" and ALL its analysis results permanently? This cannot be undone.`)) return;
  try {
    await api("DELETE", `/api/jobs/${id}`);
    toast("Deleted.");
  } catch (e) { toast(e.data?.retryable ? "Deletion incomplete. The job stays in DELETING; press Delete again to retry." : e.message); }
  route();
}

async function viewJob(id) {
  const { job } = await api("GET", `/api/jobs/${id}`);
  let files = null;
  if (job.status === "COMPLETED") { try { files = (await api("GET", `/api/jobs/${id}/results`)).files; } catch (e) { toast(e.message); } }
  // report.html (shortest key wins if several) is shown inline; other files stay downloadable
  const reportFile = files ? files.filter((f) => REPORT_RE.test(f.key)).sort((a, b) => a.key.length - b.key.length)[0] : null;
  const reportBox = reportFile ? h("div", { class: "card report" }, h("p", { class: "small muted" }, "Loading report…")) : null;
  const info = [["Status", badge(job.status)], ["File", job.filename], ["Size", fmtBytes(job.size)], ["Language", job.language], ["Created", fmtDate(job.created_at)], ["Started", fmtDate(job.started_at)], ["Finished", fmtDate(job.completed_at)]];
  if (job.summary) info.push(["Verdict", job.summary.verdict ?? "—"], ["Shots", job.summary.shots ?? "—"], ["Confidence", job.summary.confidence ?? "—"]);
  const running = ["QUEUED", "PROCESSING"].includes(job.status);
  mount(
    h("p", {}, h("a", { href: "#/" }, "← All videos")),
    h("h1", {}, job.filename),
    h("div", { class: "card" }, h("dl", {}, info.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    job.error ? h("p", { class: "err" }, job.error) : null,
    h("div", { class: "row" },
      ["READY", "FAILED"].includes(job.status) && job.size ? h("button", { class: "btn", onclick: async () => { try { await api("POST", `/api/jobs/${id}/analyze`); toast("Analysis queued."); } catch (e) { toast(e.message); } route(); } }, job.status === "FAILED" ? "Retry analysis" : "Start analysis") : null,
      running ? h("button", { class: "btn danger", onclick: (e) => cancelAnalysis(id, job.filename, e.currentTarget) }, "Cancel analysis") : null,
      h("button", { class: "btn danger", disabled: running, onclick: async () => { await removeJob(id, job.filename); if (!document.querySelector(".badge.DELETING")) location.hash = "#/"; } }, "Delete video and results")),
    running ? h("p", { class: "muted" }, "Analysis is running on GitHub Actions. This page refreshes automatically.") : null,
    reportBox ? [h("h2", {}, "Report"), reportBox] : null,
    files ? h("div", {}, h("div", { class: "row" }, h("h2", {}, "Outputs"), files.length ? h("button", { class: "btn", onclick: (e) => downloadAllZip(id, job.filename, e.currentTarget) }, "Download all (ZIP)") : null), h("p", { class: "small muted" }, "Download links expire after 5 minutes; reload to get fresh ones."),
      files.map((f) => h("div", { class: "file" }, h("a", { href: f.url, download: f.name, rel: "noopener" }, f.key), h("span", { class: "small muted" }, fmtBytes(f.size))))) : null);
  if (reportFile) loadReport(files, reportFile, reportBox);
  if (["QUEUED", "PROCESSING", "DELETING"].includes(job.status)) schedulePoll(5000);
}

async function viewSettings() {
  const [me, st] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/status")]);
  const yes = (b) => (b ? "OK" : "Not available");
  mount(
    h("h1", {}, "Settings"),
    h("div", { class: "card" }, h("dl", {}, [
      ["Account", "Owner (password login)"], ["Backend", yes(st.ok)], ["Database (D1)", yes(st.database)], ["Storage (R2)", yes(st.storage)],
      ["Direct uploads configured", yes(st.uploads_configured)], ["Analysis dispatch configured", yes(st.analysis_configured)],
      ["Max upload", fmtBytes(st.max_upload_bytes)], ["App version", st.version],
    ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    h("p", { class: "small muted" }, "Videos and results are kept until you delete them. No automatic expiry is configured."),
    h("p", {}, h("button", { class: "btn ghost", onclick: async () => { try { await api("POST", "/api/logout", {}); } catch {} serverStatus = null; showLogin(); } }, "Log out")));
}

// ---------- router ----------
function schedulePoll(ms) { clearTimeout(pollTimer); pollTimer = setTimeout(route, ms); }
function render() { route(); }
async function route() {
  clearTimeout(pollTimer);
  const hash = location.hash || "#/";
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", (hash.startsWith("#/settings") ? "settings" : "home") === a.dataset.nav));
  try {
    if (!serverStatus) serverStatus = await api("GET", "/api/status").catch(() => null);
    const m = hash.match(/^#\/job\/([0-9a-f]{32})$/);
    if (m) await viewJob(m[1]);
    else if (hash === "#/settings") await viewSettings();
    else await viewHome();
  } catch (e) {
    if (e.status === 401) return; // api() already switched to the login screen
    mount(h("p", { class: "err" }, e.message), h("button", { class: "btn", onclick: () => route() }, "Retry"));
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if ([...uploads.values()].some((u) => u.state === "uploading")) { e.preventDefault(); e.returnValue = ""; } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
