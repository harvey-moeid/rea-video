#!/usr/bin/env python3
"""Runner used by the manual R2 analysis workflow (stdlib only).

  run_analysis.py analyze  --input F --out DIR --output-prefix P --lang en --max-bytes N --manifest M
  run_analysis.py callback --event started|completed|failed --job-id ID [--manifest M] [--message TXT]

`analyze` runs `rea-video decompose`, checks that the output is complete and writes a manifest
(object keys + sizes + summary) that the workflow uploads and that `callback completed` reports.
Secrets come from the environment and are never printed.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REQUIRED_OUTPUTS = ("breakdown.json", "report.html")
SAFE_REL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]*(/[A-Za-z0-9][A-Za-z0-9._@+ -]*)*$")
JOB_ID = re.compile(r"^[0-9a-f]{32}$")
PREFIX = re.compile(r"^users/[0-9a-f]{32}/jobs/[0-9a-f]{32}/results$")
MAX_OBJECTS = 5000


class AnalysisError(Exception):
    """Raised with a message that is safe to show the user."""


def collect_manifest(out_dir: Path, output_prefix: str) -> list[dict]:
    if not PREFIX.match(output_prefix):
        raise AnalysisError("invalid output prefix")
    objects = []
    for p in sorted(out_dir.rglob("*")):
        if p.is_symlink():
            raise AnalysisError("output contains a symlink")
        if not p.is_file():
            continue
        rel = p.relative_to(out_dir).as_posix()
        if not SAFE_REL.match(rel) or ".." in rel.split("/"):
            raise AnalysisError("output contains an unsafe file name")
        objects.append({"key": f"{output_prefix}/{rel}", "size": p.stat().st_size, "path": str(p)})
    if len(objects) > MAX_OBJECTS:
        raise AnalysisError(f"too many output files ({len(objects)} > {MAX_OBJECTS})")
    return objects


def check_outputs(out_dir: Path) -> dict:
    missing = [n for n in REQUIRED_OUTPUTS if not (out_dir / n).is_file() or (out_dir / n).stat().st_size == 0]
    if missing:
        raise AnalysisError("analysis output incomplete: missing " + ", ".join(missing))
    try:
        breakdown = json.loads((out_dir / "breakdown.json").read_text(encoding="utf-8"))
        s = breakdown["summary"]
    except (ValueError, KeyError, OSError):
        raise AnalysisError("analysis output incomplete: breakdown.json is not valid")
    return {k: s.get(k) for k in ("verdict", "shots", "confidence", "duration") if k in s}


def run_decompose(video: Path, out_dir: Path, lang: str, timeout: int, extra: list[str] | None = None) -> None:
    cmd = [sys.executable, "-m", "rea_video", "decompose", str(video), "--out", str(out_dir), "--lang", lang, "--no-vlm"] + (extra or [])
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AnalysisError(f"analysis timed out after {timeout}s")
    if proc.returncode != 0:
        # last stderr line only: usually the CLI's one-line error; never the whole log
        tail = (proc.stderr.strip().splitlines() or ["unknown error"])[-1][:300]
        raise AnalysisError(f"rea-video decompose failed (exit {proc.returncode}): {tail}")


def analyze(args) -> dict:
    video, out_dir = Path(args.input), Path(args.out)
    if not video.is_file():
        raise AnalysisError("input video not found")
    size = video.stat().st_size
    if size == 0:
        raise AnalysisError("input video is empty")
    if size > args.max_bytes:
        raise AnalysisError(f"input video too large ({size} > {args.max_bytes} bytes)")
    out_dir.mkdir(parents=True, exist_ok=True)
    run_decompose(video, out_dir, args.lang, args.timeout)
    summary = check_outputs(out_dir)
    objects = collect_manifest(out_dir, args.output_prefix)
    manifest = {"summary": summary, "objects": [{"key": o["key"], "size": o["size"]} for o in objects]}
    Path(args.manifest).write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


# ---- callbacks: same canonical string as worker/src/auth.js -------------------------------------------
def sign(secret: str, ts: str, nonce: str, method: str, path: str, body: bytes) -> str:
    msg = f"{ts}.{nonce}.{method}.{path}.{hashlib.sha256(body).hexdigest()}"
    return hmac.new(secret.encode(), msg.encode(), hashlib.sha256).hexdigest()


def build_callback(base_url: str, secret: str, job_id: str, event: str, payload: dict, now: int | None = None, nonce: str | None = None):
    if not JOB_ID.match(job_id):
        raise AnalysisError("invalid job id")
    if event not in ("started", "completed", "failed"):
        raise AnalysisError("invalid event")
    if len(secret) < 32:
        raise AnalysisError("callback secret not configured")
    if not base_url.startswith("https://"):
        raise AnalysisError("callback url must be https")
    path = f"/api/internal/jobs/{job_id}/{event}"
    body = json.dumps(payload, separators=(",", ":")).encode()
    ts, nonce = str(now or int(time.time())), nonce or secrets.token_urlsafe(18)
    headers = {"content-type": "application/json", "x-rea-timestamp": ts, "x-rea-nonce": nonce,
               "x-rea-signature": sign(secret, ts, nonce, "POST", path, body), "user-agent": "rea-video-runner"}
    return base_url.rstrip("/") + path, headers, body


def send_callback(base_url: str, secret: str, job_id: str, event: str, payload: dict, retries: int = 4) -> None:
    for attempt in range(retries):
        url, headers, body = build_callback(base_url, secret, job_id, event, payload)  # fresh nonce per attempt
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                if 200 <= r.status < 300:
                    return
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500 and e.code != 429:
                raise AnalysisError(f"callback rejected (HTTP {e.code})")
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(min(2 ** attempt * 2, 20))
    raise AnalysisError("callback failed after retries")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="run_analysis")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze")
    a.add_argument("--input", required=True); a.add_argument("--out", required=True)
    a.add_argument("--output-prefix", required=True); a.add_argument("--lang", default="en", choices=["en", "zh"])
    a.add_argument("--max-bytes", type=int, default=200 * 1024 * 1024)
    a.add_argument("--timeout", type=int, default=75 * 60); a.add_argument("--manifest", required=True)
    c = sub.add_parser("callback")
    c.add_argument("--event", required=True, choices=["started", "completed", "failed"])
    c.add_argument("--job-id", required=True); c.add_argument("--manifest"); c.add_argument("--message", default="")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "analyze":
            m = analyze(args)
            print(f"analysis ok: {len(m['objects'])} files, verdict={m['summary'].get('verdict')}")
            return 0
        payload: dict = {"run_id": os.environ.get("GITHUB_RUN_ID", "")}
        if args.event == "completed":
            payload.update(json.loads(Path(args.manifest).read_text(encoding="utf-8")))
        if args.event == "failed":
            payload["message"] = args.message[:500]
        send_callback(os.environ.get("WORKER_CALLBACK_URL", ""), os.environ.get("WORKER_CALLBACK_SECRET", ""), args.job_id, args.event, payload)
        print(f"callback {args.event} delivered")
        return 0
    except AnalysisError as e:
        print(f"error: {e}", file=sys.stderr)
        if args.cmd == "analyze":
            Path(os.environ.get("ANALYSIS_ERROR_FILE", "analysis_error.txt")).write_text(str(e)[:500], encoding="utf-8")
        return 1


if __name__ == "__main__":
    sys.exit(main())
