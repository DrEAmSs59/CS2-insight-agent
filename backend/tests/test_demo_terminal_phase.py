"""Atomic promotion and verification contract for the offline entity rewriter."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import demo_terminal_phase as phase
from app.demo_playback_compat import DemoPlaybackCompatibilityError


def digest(data):
    return hashlib.sha256(data).hexdigest()


def receipt(source, output, *, changed=True):
    audit = dict(fields_seen=4, values={"2": 1, "3": 1, "5": 2}, first_live_tick=50,
                 first_terminal_tick=100, last_terminal_tick=200, terminal_fields=2, invalid_fields=0)
    target = dict(fields_seen=4, values={"2": 1, "3": 3}, first_live_tick=50,
                  first_terminal_tick=None, last_terminal_tick=None, terminal_fields=0, invalid_fields=0)
    return dict(schema_version=1, changed=changed, input_sha256=digest(source),
                output_sha256=digest(output) if changed else None, replacement_phase=3,
                input=audit if changed else target, output=target, rewritten_fields=2 if changed else 0)


@pytest.fixture
def tool(monkeypatch, tmp_path):
    source = tmp_path / "match.dem"
    source.write_bytes(b"ORIGINAL")
    report = receipt(b"ORIGINAL", b"REPAIRED")
    settings = SimpleNamespace(report=report, output=b"REPAIRED", returncode=0, error=None)
    monkeypatch.setattr(phase, "resolve_terminal_phase_tool", lambda: tmp_path / "tool.exe")

    def run(argv, **kwargs):
        assert argv[1:3] == ["--input", str(source)]
        assert kwargs["shell"] is False
        if settings.error:
            raise settings.error
        if settings.output is not None:
            Path(argv[4]).write_bytes(settings.output)
        return SimpleNamespace(returncode=settings.returncode, stdout=json.dumps(settings.report), stderr="tool failed")

    monkeypatch.setattr(phase.subprocess, "run", run)
    return source, settings


def test_verified_candidate_replaces_input(tool):
    source, _ = tool
    result = phase.repair_terminal_phase_in_place(source)
    assert source.read_bytes() == b"REPAIRED"
    assert result == phase.TerminalPhaseResult(2, 100, 200)
    assert list(source.parent.iterdir()) == [source]


def test_clean_demo_is_not_replaced(tool):
    source, settings = tool
    settings.report = receipt(b"ORIGINAL", None, changed=False)
    settings.output = None
    before = source.stat()
    assert phase.repair_terminal_phase_in_place(source).rewritten_fields == 0
    assert source.read_bytes() == b"ORIGINAL"
    assert source.stat().st_mtime_ns == before.st_mtime_ns
    assert source.stat().st_ino == before.st_ino


@pytest.mark.parametrize("failure", [
    "input_hash", "output_hash", "unchanged_output", "missing_output", "remaining_phase", "wrong_live_phase",
    "wrong_count", "invalid_encoding", "missing_live_history", "non_phase_changes",
    "malformed_receipt", "false_clean", "exit", "timeout",
])
def test_failed_verification_preserves_input_and_cleans_candidate(tool, failure):
    source, settings = tool
    report = settings.report = deepcopy(settings.report)
    if failure == "input_hash": report["input_sha256"] = "bad"
    elif failure == "output_hash": settings.output = b"CORRUPT"
    elif failure == "unchanged_output":
        settings.output = b"ORIGINAL"
        report["output_sha256"] = digest(settings.output)
    elif failure == "missing_output": settings.output = None
    elif failure == "remaining_phase": report["output"]["terminal_fields"] = 1
    elif failure == "wrong_live_phase": report["replacement_phase"] = 4
    elif failure == "wrong_count": report["rewritten_fields"] = 1
    elif failure == "invalid_encoding": report["input"]["invalid_fields"] = 1
    elif failure == "missing_live_history": report["input"]["first_live_tick"] = None
    elif failure == "non_phase_changes": report["output"]["values"] = {"2": 2, "3": 2}
    elif failure == "malformed_receipt": settings.report = []
    elif failure == "false_clean": report["changed"] = False
    elif failure == "exit": settings.returncode = 1
    elif failure == "timeout": settings.error = subprocess.TimeoutExpired("tool", 1800)
    with pytest.raises(DemoPlaybackCompatibilityError):
        phase.repair_terminal_phase_in_place(source)
    assert source.read_bytes() == b"ORIGINAL"
    assert list(source.parent.iterdir()) == [source]


def test_source_change_during_tool_execution_is_not_overwritten(tool, monkeypatch):
    source, _ = tool
    run = phase.subprocess.run

    def mutate_source(*args, **kwargs):
        result = run(*args, **kwargs)
        source.write_bytes(b"EXTERNAL-UPDATE")
        return result

    monkeypatch.setattr(phase.subprocess, "run", mutate_source)
    with pytest.raises(DemoPlaybackCompatibilityError, match="source demo changed"):
        phase.repair_terminal_phase_in_place(source)
    assert source.read_bytes() == b"EXTERNAL-UPDATE"
    assert list(source.parent.iterdir()) == [source]
