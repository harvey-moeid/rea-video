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
    throw new Error("Cannot reach the server. Check your connection, or reload to sign in again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
  return data;
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
  return h("div", { class: "job" },
    h("div", { class: "row" }, h("span", { class: "name" }, j.filename), badge(j.status)),
    h("div", { class: "small muted" }, `${fmtBytes(j.size)} · ${fmtDate(j.created_at)}`),
    j.error ? h("div", { class: "small err" }, j.error) : null,
    h("div", { class: "row" },
      h("a", { class: "btn ghost", href: `#/job/${j.id}`, style: "text-decoration:none" }, "Details"),
      h("button", { class: "btn danger", disabled: ["QUEUED", "PROCESSING"].includes(j.status), onclick: () => removeJob(j.id, j.filename) }, "Delete")));
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
  const info = [["Status", badge(job.status)], ["File", job.filename], ["Size", fmtBytes(job.size)], ["Language", job.language], ["Created", fmtDate(job.created_at)], ["Started", fmtDate(job.started_at)], ["Finished", fmtDate(job.completed_at)]];
  if (job.summary) info.push(["Verdict", job.summary.verdict ?? "—"], ["Shots", job.summary.shots ?? "—"], ["Confidence", job.summary.confidence ?? "—"]);
  mount(
    h("p", {}, h("a", { href: "#/" }, "← All videos")),
    h("h1", {}, job.filename),
    h("div", { class: "card" }, h("dl", {}, info.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    job.error ? h("p", { class: "err" }, job.error) : null,
    h("div", { class: "row" },
      ["READY", "FAILED"].includes(job.status) && job.size ? h("button", { class: "btn", onclick: async () => { try { await api("POST", `/api/jobs/${id}/analyze`); toast("Analysis queued."); } catch (e) { toast(e.message); } route(); } }, job.status === "FAILED" ? "Retry analysis" : "Start analysis") : null,
      h("button", { class: "btn danger", disabled: ["QUEUED", "PROCESSING"].includes(job.status), onclick: async () => { await removeJob(id, job.filename); if (!document.querySelector(".badge.DELETING")) location.hash = "#/"; } }, "Delete video and results")),
    ["QUEUED", "PROCESSING"].includes(job.status) ? h("p", { class: "muted" }, "Analysis is running on GitHub Actions. This page refreshes automatically.") : null,
    files ? h("div", {}, h("h2", {}, "Outputs"), h("p", { class: "small muted" }, "Download links expire after 5 minutes; reload to get fresh ones."),
      files.map((f) => h("div", { class: "file" }, h("a", { href: f.url, download: f.name, rel: "noopener" }, f.key), h("span", { class: "small muted" }, fmtBytes(f.size))))) : null);
  if (["QUEUED", "PROCESSING", "DELETING"].includes(job.status)) schedulePoll(5000);
}

async function viewSettings() {
  const [me, st] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/status")]);
  const yes = (b) => (b ? "OK" : "Not available");
  mount(
    h("h1", {}, "Settings"),
    h("div", { class: "card" }, h("dl", {}, [
      ["Account", me.email || "signed in"], ["Backend", yes(st.ok)], ["Database (D1)", yes(st.database)], ["Storage (R2)", yes(st.storage)],
      ["Direct uploads configured", yes(st.uploads_configured)], ["Analysis dispatch configured", yes(st.analysis_configured)],
      ["Max upload", fmtBytes(st.max_upload_bytes)], ["App version", st.version],
    ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]))),
    h("p", { class: "small muted" }, "Videos and results are kept until you delete them. No automatic expiry is configured."));
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
    mount(h("p", { class: "err" }, e.message), h("button", { class: "btn", onclick: () => route() }, "Retry"));
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", (e) => { if ([...uploads.values()].some((u) => u.state === "uploading")) { e.preventDefault(); e.returnValue = ""; } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
