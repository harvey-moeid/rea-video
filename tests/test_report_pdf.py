"""write_report_pdf: best-effort report.pdf next to the other outputs (docs/cancel-and-pdf.md)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import run_analysis as ra  # noqa: E402


def _fake_run(monkeypatch, out, behaviour):
    """Replace subprocess.run in run_analysis; behaviour(call_no, env) -> returncode (report.pdf is written on 0)."""
    calls = []

    def fake(cmd, **kw):
        calls.append(kw.get("env"))
        rc = behaviour(len(calls), kw.get("env"))
        if rc == 0:
            (out / "report.pdf").write_bytes(b"%PDF-1.7 test")
        (out / ".report_print.html").write_text("tmp")  # what a killed Chrome leaves behind
        return subprocess.CompletedProcess(cmd, rc, "", "")

    monkeypatch.setattr(ra.subprocess, "run", fake)
    return calls


def test_success_and_cleanup(monkeypatch, tmp_path):
    out = tmp_path / "out"; out.mkdir()
    calls = _fake_run(monkeypatch, out, lambda n, env: 0)
    assert ra.write_report_pdf(out) is True
    assert len(calls) == 1 and (out / "report.pdf").stat().st_size > 0
    assert not (out / ".report_print.html").exists()  # would otherwise fail the manifest's safe-name check


def test_retries_with_no_sandbox_wrapper(monkeypatch, tmp_path):
    out = tmp_path / "out"; out.mkdir()
    chrome = tmp_path / "chrome"; chrome.write_text("#!/bin/sh\n"); chrome.chmod(0o755)
    monkeypatch.setitem(sys.modules, "rea_video.pdf", type("M", (), {"find_browser": staticmethod(lambda: str(chrome))}))
    seen = {}

    def behaviour(n, env):
        if n == 1:
            return 1  # sandbox unavailable
        seen["body"] = Path(env["REA_CHROME"]).read_text()
        return 0

    calls = _fake_run(monkeypatch, out, behaviour)
    assert ra.write_report_pdf(out) is True and len(calls) == 2
    assert "--no-sandbox" in seen["body"] and str(chrome) in seen["body"]
    assert not list(out.glob(".*"))  # no wrapper or temp file inside the uploaded folder


def test_failure_is_non_fatal_and_leaves_no_partial_file(monkeypatch, tmp_path):
    out = tmp_path / "out"; out.mkdir()
    (out / "report.pdf").write_bytes(b"")  # partial output from a crashed Chrome
    monkeypatch.setitem(sys.modules, "rea_video.pdf", type("M", (), {"find_browser": staticmethod(lambda: None)}))
    _fake_run(monkeypatch, out, lambda n, env: 1)
    assert ra.write_report_pdf(out) is False
    assert not (out / "report.pdf").exists() and not (out / ".report_print.html").exists()

    def boom(*a, **k):
        raise subprocess.TimeoutExpired("x", 1)
    monkeypatch.setattr(ra.subprocess, "run", boom)
    assert ra.write_report_pdf(out) is False  # timeout: still no exception
