// Local end-to-end test: real PWA in headless Chromium -> real Worker code (SQLite as D1, in-memory R2)
// -> real scripts/run_analysis.py + rea-video on a real video -> signed callback -> UI -> download -> delete.
// Cloudflare itself (R2 S3 endpoint, GitHub dispatch) is simulated; the password login runs for real through the UI; see docs/deployment/testing.md.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, execFile } = require("node:child_process");
const run = (cmd, args, opts) => new Promise((res, rej) => execFile(cmd, args, { ...opts, maxBuffer: 1 << 26 }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const must = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; throw new Error(m); } else console.log("ok  -", m); };

process.on("uncaughtException", (e) => { console.error("UNCAUGHT", e.stack); process.exit(1); });
(async () => {
  const { default: worker } = await import(path.join(ROOT, "worker/src/index.js"));
  const { FakeR2, installFetch, makeDb } = await import(path.join(ROOT, "worker/test/helpers.js"));
  const PASSWORD = "e2e-password-123";
  const SECRET = "e".repeat(48);
  const env = { DB: makeDb(), BUCKET: new FakeR2(), AUTH_PASSWORD: PASSWORD, SESSION_SECRET: "t".repeat(48), R2_ACCOUNT_ID: "acc", R2_BUCKET_NAME: "rea-video-storage",
    R2_ACCESS_KEY_ID: "AK", R2_SECRET_ACCESS_KEY: "SK", GITHUB_TOKEN: "t", GITHUB_REPO: "harvey-moeid/rea-video", GITHUB_REF: "byga-integration", CALLBACK_SECRET: SECRET, MAX_UPLOAD_BYTES: String(100 * 1024 * 1024) };
  const dispatches = [];
  installFetch([
    ["api.github.com", async (_u, init) => { dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }]]);
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  env.ASSETS = { fetch: async (req) => {
    let p = new URL(req.url).pathname; if (p === "/") p = "/index.html";
    const f = path.join(ROOT, "web", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!f.startsWith(path.join(ROOT, "web")) || !fs.existsSync(f)) return new Response("nf", { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { "content-type": types[path.extname(f)] || "application/octet-stream" } });
  } };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, String(v));
    const r = await worker.fetch(new Request(`http://127.0.0.1:${server.address().port}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rea-e2e-"));
  const video = path.join(tmp, "sample.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);

  // Simulated R2 S3 endpoint over HTTPS (self-signed, throwaway cert) with the CORS rules production needs.
  const { presignR2 } = await import(path.join(ROOT, "worker/src/sigv4.js"));
  const r2srv = require("node:https").createServer({ key: fs.readFileSync(process.env.E2E_KEY), cert: fs.readFileSync(process.env.E2E_CERT) }, async (req, res) => {
    const origin = req.headers.origin || "*";
    const cors = { "access-control-allow-origin": origin, "access-control-expose-headers": "ETag", "vary": "Origin" };
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET,PUT", "access-control-allow-headers": "content-type", "access-control-max-age": "600" }); return res.end(); }
    const u = new URL(req.url, "https://acc.r2.cloudflarestorage.com");
    const key = decodeURIComponent(u.pathname.replace(/^\/rea-video-storage\//, ""));
    // verify the presigned signature exactly as R2 would: recompute it from the request parameters
    const q = Object.fromEntries(u.searchParams); const given = q["X-Amz-Signature"];
    const extra = Object.fromEntries(Object.entries(q).filter(([k]) => !k.startsWith("X-Amz-")));
    const d = q["X-Amz-Date"]; const when = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
    const again = await presignR2({ accountId: "acc", bucket: "rea-video-storage", accessKeyId: "AK", secretAccessKey: "SK" }, { method: req.method, key, expires: Number(q["X-Amz-Expires"]), query: extra, now: when });
    if (!again.endsWith("X-Amz-Signature=" + given) || Date.now() > when.getTime() + Number(q["X-Amz-Expires"]) * 1000) { res.writeHead(403, cors); return res.end("SignatureDoesNotMatch"); }
    const chunks = []; for await (const c of req) chunks.push(c); const buf = new Uint8Array(Buffer.concat(chunks));
    if (req.method === "PUT" && q.uploadId) { env.BUCKET.uploads.get(q.uploadId).parts.set(Number(q.partNumber), buf); res.writeHead(200, { ...cors, etag: `"part${q.partNumber}${"0".repeat(8)}"` }); return res.end(); }
    if (req.method === "PUT") { env.BUCKET.objects.set(key, { bytes: buf }); res.writeHead(200, { ...cors, etag: '"abc12345"' }); return res.end(); }
    const o = env.BUCKET.objects.get(key); res.writeHead(o ? 200 : 404, { ...cors, "content-type": "application/octet-stream" }); res.end(o ? Buffer.from(o.bytes) : "");
  });
  await new Promise((r) => r2srv.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))), args: ["--no-proxy-server", `--host-resolver-rules=MAP acc.r2.cloudflarestorage.com 127.0.0.1:${r2srv.address().port}`] });
  const page = await (await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true })).newPage();
  page.on("dialog", (d) => d.accept()); page.on("requestfailed", (r) => console.log("REQFAIL", r.method(), r.url().slice(0, 80), r.failure()?.errorText));
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/");
  await page.waitForSelector("input[type=password]");
  must(!(await page.isVisible("nav")), "signed-out visitors see only the password form (no app navigation)");
  must((await page.evaluate(() => fetch("/api/jobs").then((r) => r.status))) === 401, "API refuses requests without a session");
  await page.fill("input[type=password]", "wrong password"); await page.click("button:has-text(\"Sign in\")");
  await page.waitForSelector("text=wrong password", { timeout: 5000 });
  must(await page.isVisible("input[type=password]"), "wrong password keeps the login form");
  await page.fill("input[type=password]", PASSWORD); await page.click("button:has-text(\"Sign in\")");
  await page.waitForSelector("text=Videos");
  must(await page.isVisible("nav"), "correct password opens the app");
  await page.reload(); await page.waitForSelector("text=Videos");
  must(true, "session survives a page reload (HttpOnly cookie)");
  must((await page.textContent(".stats")).includes("Total jobs"), "dashboard renders stats");
  must((await page.evaluate(() => fetch("/manifest.webmanifest").then((r) => r.json()))).name === "REA VIDEO", "manifest served");

  await page.setInputFiles('input[type=file]', video);
  await page.waitForSelector(".job .badge.READY", { timeout: 15000 }).catch(async (e) => { console.log("DEBUG db:", JSON.stringify(await env.DB.prepare("SELECT status,error_message,file_size FROM jobs").all()), "page:", (await page.textContent("main")).slice(0, 400), "objs:", [...env.BUCKET.objects.entries()].map(([k, v]) => k + ":" + v.bytes.length)); throw e; });
  const jobId = (await env.DB.prepare("SELECT id FROM jobs").first()).id;
  must(env.BUCKET.objects.has((await env.DB.prepare("SELECT input_key k FROM jobs").first()).k), "video uploaded straight to R2 via presigned URL and verified (size + magic bytes)");

  await page.click(".job >> text=Details");
  page.on("response", (r) => r.url().includes("/analyze") && console.log("ANALYZE", r.status()));
  await page.waitForSelector("button:has-text(\"Start analysis\")"); await page.click("button:has-text(\"Start analysis\")"); await page.waitForTimeout(500); console.log("TOAST", await page.textContent("#toast"));
  await page.waitForSelector(".badge.QUEUED", { timeout: 8000 }).catch(async (e) => { console.log("DEBUG2", JSON.stringify(await env.DB.prepare("SELECT status,error_message FROM jobs").all()), (await page.textContent("main")).slice(0, 300), dispatches.length); throw e; });
  must(dispatches.length === 1 && dispatches[0].inputs.job_id === jobId, "analysis dispatched to GitHub with server-derived inputs");

  // ---- runner: real Python script + real rea-video on the stored video, real signed callbacks ----
  const row = await env.DB.prepare("SELECT input_key, result_prefix FROM jobs").first();
  const local = path.join(tmp, "input.bin"); fs.writeFileSync(local, env.BUCKET.objects.get(row.input_key).bytes);
  const py = (args) => run("python3", [path.join(ROOT, "scripts/run_analysis.py"), ...args], { env: { ...process.env, PYTHONPATH: ROOT }, encoding: "utf8" });
  const cb = async (event, payload) => {
    const out = await run("python3", ["-c", `import json,sys;sys.path.insert(0,'${ROOT}/scripts');import run_analysis as r;u,h,b=r.build_callback('https://x.example','${SECRET}','${jobId}','${event}',json.loads(sys.argv[1]));print(json.dumps({'path':u.replace('https://x.example',''),'h':h,'b':b.decode()}))`, JSON.stringify(payload)], { encoding: "utf8" });
    const { path: p, h, b } = JSON.parse(out);
    const r = await fetch0(base + p, { method: "POST", headers: h, body: b }); return r;
  };
  const fetch0 = (url, init) => new Promise((resolve, reject) => { const u = new URL(url); const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: init.method, headers: init.headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }); rq.on("error", reject); rq.end(init.body); });
  must((await cb("started", { run_id: "42" })).status === 200, "runner 'started' callback accepted (Python HMAC == Worker HMAC)");
  const outDir = path.join(tmp, "out"), manifest = path.join(tmp, "manifest.json");
  await py(["analyze", "--input", local, "--out", outDir, "--output-prefix", row.result_prefix, "--lang", "en", "--manifest", manifest]);
  const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
  for (const o of m.objects) env.BUCKET.objects.set(o.key, { bytes: new Uint8Array(fs.readFileSync(path.join(outDir, o.key.slice(row.result_prefix.length + 1)))) });
  const done = await cb("completed", { run_id: "42", ...m });
  must(done.status === 200, `runner 'completed' callback accepted (${m.objects.length} objects)`);

  await page.reload(); await page.waitForSelector(".badge.COMPLETED");
  must((await page.textContent("dl")).includes("Verdict"), "detail shows analysis summary");
  const links = await page.$$eval(".file a", (as) => as.map((a) => a.textContent));
  must(links.includes("results/report.html") && links.includes("results/breakdown.json"), "outputs listed with download links");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('.file a:text-is("results/breakdown.json")')]);
  const body = fs.readFileSync(await dl.path(), "utf8");
  must(JSON.parse(body).summary.shots >= 1, "downloaded breakdown.json is real analysis output");

  await page.click("text=Delete video and results");
  await page.waitForSelector("text=No videos yet", { timeout: 15000 });
  must(env.BUCKET.objects.size === 0, "manual delete removed every R2 object (input + results)");
  must((await env.DB.prepare("SELECT status s FROM jobs").first()).s === "DELETED", "job marked DELETED only after verified removal");
  // ---- scenario 2: a 70 MB file goes through the multipart path (5 parts, 3 in parallel) ----
  const big = path.join(tmp, "big.mp4"); const head = fs.readFileSync(video).subarray(0, 4096);
  const fd = fs.openSync(big, "w"); fs.writeSync(fd, head); fs.ftruncateSync(fd, 70 * 1024 * 1024); fs.closeSync(fd);
  await page.setInputFiles('input[type=file]', big);
  await page.waitForSelector(".job .badge.READY", { timeout: 60000 });
  const bj = await env.DB.prepare("SELECT input_key k, upload_mode m, file_size s FROM jobs WHERE status = 'READY'").first();
  must(bj.m === "multipart" && env.BUCKET.objects.get(bj.k).bytes.length === bj.s, "70 MB upload used multipart, parts assembled to the exact declared size");
  must(env.BUCKET.uploads.size === 1, "exactly one multipart upload was created");
  await page.click(".job .btn.danger");
  await page.waitForSelector("text=No videos yet", { timeout: 15000 });
  must(env.BUCKET.objects.size === 0, "multipart job deleted completely");
  await page.click("nav >> text=Settings"); await page.click("button:has-text(\"Log out\")");
  await page.waitForSelector("input[type=password]");
  must((await page.evaluate(() => fetch("/api/jobs").then((r) => r.status))) === 401, "log out ends the session");
  must(errors.length === 0, "no uncaught browser errors " + errors.join("|"));
  await browser.close(); server.close(); r2srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log("UI E2E PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
