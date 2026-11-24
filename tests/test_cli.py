import subprocess
import sys

import pytest


def run(*a, **k):
    return subprocess.run([sys.executable, "-m", "rea_video", *a], capture_output=True, text=True, timeout=300, **k)


def test_help_lists_core_commands():
    r = run("--help")
    assert r.returncode == 0
    for cmd in ("decompose", "eval", "models", "probe"):
        assert cmd in r.stdout


def test_decompose_help_documents_flags_used_by_the_workflow():
    r = run("decompose", "--help")
    assert r.returncode == 0
    for flag in ("--out", "--lang", "--no-vlm", "--no-stems", "--no-asr"):
        assert flag in r.stdout


def test_models_lists_video_models():
    r = run("models")
    assert r.returncode == 0 and r.stdout.strip()
    assert run("models", "does-not-exist").returncode == 2


def test_decompose_rejects_bad_language_and_missing_file(tmp_path):
    assert run("decompose", "x.mp4", "--lang", "xx").returncode != 0
    r = run("decompose", str(tmp_path / "missing.mp4"), "--out", str(tmp_path / "o"), "--no-vlm")
    assert r.returncode != 0


def test_decompose_valid_video_writes_report(tiny_video, tmp_path):
    out = tmp_path / "o"
    r = run("decompose", str(tiny_video), "--out", str(out), "--lang", "en", "--no-vlm", "--no-stems", "--no-asr", "--no-ocr")
    assert r.returncode == 0, r.stderr[-500:]
    assert (out / "breakdown.json").is_file() and (out / "report.html").is_file()


def test_probe_reports_dimensions(tiny_video):
    r = run("probe", str(tiny_video))
    assert r.returncode == 0 and '"width": 320' in r.stdout


def test_eval_requires_labels_file(tmp_path):
    r = run("eval", str(tmp_path / "nope.yaml"), "-o", str(tmp_path / "o"))
    assert r.returncode != 0
