import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import run_analysis as ra  # noqa: E402

PREFIX = "users/" + "a" * 32 + "/jobs/" + "b" * 32 + "/results"
JOB = "b" * 32


def args(video, out, tmp, **kw):
    ns = dict(input=str(video), out=str(out), output_prefix=PREFIX, lang="en", max_bytes=10_000_000, timeout=300, manifest=str(tmp / "m.json"))
    ns.update(kw)
    return type("A", (), ns)()


def test_success_produces_complete_manifest(tiny_video, tmp_path):
    m = ra.analyze(args(tiny_video, tmp_path / "out", tmp_path))
    keys = [o["key"] for o in m["objects"]]
    assert f"{PREFIX}/breakdown.json" in keys and f"{PREFIX}/report.html" in keys
    assert all(k.startswith(PREFIX + "/") and ".." not in k for k in keys)
    assert m["summary"]["shots"] >= 1 and m["summary"]["verdict"]
    assert json.loads((tmp_path / "m.json").read_text())["objects"]


def test_corrupt_video_fails_cleanly(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"this is not a video" * 100)
    with pytest.raises(ra.AnalysisError, match="decompose failed"):
        ra.analyze(args(bad, tmp_path / "out", tmp_path))


def test_missing_empty_and_oversized_inputs(tmp_path, tiny_video):
    with pytest.raises(ra.AnalysisError, match="not found"):
        ra.analyze(args(tmp_path / "nope.mp4", tmp_path / "o", tmp_path))
    empty = tmp_path / "e.mp4"; empty.write_bytes(b"")
    with pytest.raises(ra.AnalysisError, match="empty"):
        ra.analyze(args(empty, tmp_path / "o", tmp_path))
    with pytest.raises(ra.AnalysisError, match="too large"):
        ra.analyze(args(tiny_video, tmp_path / "o", tmp_path, max_bytes=100))


def test_incomplete_output_is_rejected(tmp_path):
    out = tmp_path / "out"; out.mkdir()
    with pytest.raises(ra.AnalysisError, match="incomplete"):
        ra.check_outputs(out)
    (out / "report.html").write_text("<html>x</html>"); (out / "breakdown.json").write_text("{not json")
    with pytest.raises(ra.AnalysisError, match="not valid"):
        ra.check_outputs(out)
    (out / "breakdown.json").write_text(json.dumps({"summary": {"verdict": "v", "shots": 1}}))
    assert ra.check_outputs(out)["shots"] == 1


def test_process_failure_and_timeout(monkeypatch, tmp_path):
    def boom(*a, **k):
        return subprocess.CompletedProcess(a, 2, "", "rea-video: model unavailable\n")
    monkeypatch.setattr(ra.subprocess, "run", boom)
    with pytest.raises(ra.AnalysisError, match="exit 2.*model unavailable"):
        ra.run_decompose(tmp_path / "v.mp4", tmp_path / "o", "en", 5)

    def slow(*a, **k):
        raise subprocess.TimeoutExpired(a, 1)
    monkeypatch.setattr(ra.subprocess, "run", slow)
    with pytest.raises(ra.AnalysisError, match="timed out"):
        ra.run_decompose(tmp_path / "v.mp4", tmp_path / "o", "en", 5)


def test_manifest_rejects_unsafe_names_symlinks_and_bad_prefix(tmp_path):
    out = tmp_path / "o"; out.mkdir()
    (out / "ok.txt").write_text("x")
    assert ra.collect_manifest(out, PREFIX)[0]["key"] == f"{PREFIX}/ok.txt"
    (out / "bad\nname").write_text("x")
    with pytest.raises(ra.AnalysisError, match="unsafe"):
        ra.collect_manifest(out, PREFIX)
    (out / "bad\nname").unlink(); (out / "link").symlink_to(out / "ok.txt")
    with pytest.raises(ra.AnalysisError, match="symlink"):
        ra.collect_manifest(out, PREFIX)
    with pytest.raises(ra.AnalysisError, match="prefix"):
        ra.collect_manifest(out, "users/x/../y")


def test_callback_signature_matches_worker_algorithm():
    # Known answer computed independently with the Worker's canonical string: ts.nonce.METHOD.path.sha256(body)
    url, h, body = ra.build_callback("https://app.example.com/", "s" * 40, JOB, "started", {"run_id": "1"}, now=1_800_000_000, nonce="n" * 20)
    assert url == f"https://app.example.com/api/internal/jobs/{JOB}/started"
    import hashlib, hmac
    msg = f"1800000000.{'n' * 20}.POST./api/internal/jobs/{JOB}/started.{hashlib.sha256(body).hexdigest()}"
    assert h["x-rea-signature"] == hmac.new(b"s" * 40, msg.encode(), hashlib.sha256).hexdigest()
    for bad in [dict(base_url="http://x", secret="s" * 40), dict(base_url="https://x", secret="short")]:
        with pytest.raises(ra.AnalysisError):
            ra.build_callback(bad["base_url"], bad["secret"], JOB, "started", {})
    with pytest.raises(ra.AnalysisError):
        ra.build_callback("https://x", "s" * 40, "../etc", "started", {})
    with pytest.raises(ra.AnalysisError):
        ra.build_callback("https://x", "s" * 40, JOB, "deleted", {})
