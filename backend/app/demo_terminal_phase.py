"""Verified offline removal of the rules-state EndOfMatch trigger."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from .demo_playback_compat import DemoPlaybackCompatibilityError


@dataclass(frozen=True)
class TerminalPhaseResult:
    rewritten_fields: int
    first_tick: int | None
    last_tick: int | None


def resolve_terminal_phase_tool() -> Path:
    root = Path(__file__).resolve().parents[2]
    name = "demo-terminal-phase.exe" if sys.platform == "win32" else "demo-terminal-phase"
    for path in (
        root / "tools" / name,
        root / "tools/demo-cosmetic-rewriter/target/release" / name,
        root / "frontend/src-tauri/bundle-resources/tools" / name,
        Path(sys.executable).resolve().parent.parent / "tools" / name,
    ):
        if path.is_file():
            return path
    raise DemoPlaybackCompatibilityError("缺少 Demo 终局兼容组件，请安装完整新版或重新构建 DEM 工具。")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        while chunk := reader.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("invalid phase counter")
    return value


def _audit(raw: object) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("missing phase audit")
    values = raw["values"]
    if not isinstance(values, dict):
        raise ValueError("invalid phase values")
    for phase, count in values.items():
        if not isinstance(phase, str) or str(int(phase)) != phase:
            raise ValueError("invalid phase value")
        _count(count)
    if _count(raw["invalid_fields"]) != 0:
        raise ValueError("unsupported phase encoding")
    if _count(raw["fields_seen"]) != sum(values.values()):
        raise ValueError("inconsistent phase total")
    if _count(raw["terminal_fields"]) != values.get("5", 0):
        raise ValueError("inconsistent terminal phase count")
    for key in ("first_live_tick", "first_terminal_tick", "last_terminal_tick"):
        if raw[key] is not None:
            _count(raw[key])
    return raw


def repair_terminal_phase_in_place(demo: Path) -> TerminalPhaseResult:
    """Only promote a hash-bound candidate after a complete raw-field rescan.

    The tool visits GameRules fields in delta packets, full snapshots and
    instance baselines. It preserves field encoding and refuses to invent a
    live phase when the input has no earlier observed phase 3.
    """
    tool = resolve_terminal_phase_tool()
    before = _sha256(demo)
    try:
        with tempfile.TemporaryDirectory(prefix=".demo-phase-", dir=demo.parent) as directory:
            output = Path(directory) / "candidate.dem"
            completed = subprocess.run(
                [str(tool), "--input", str(demo), "--output", str(output)],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=1800, shell=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if completed.returncode != 0:
                raise ValueError(f"terminal-phase tool failed: {completed.stderr[-2000:]}")
            report = json.loads(completed.stdout)
            if (type(report["schema_version"]) is not int or report["schema_version"] != 1
                    or type(report["replacement_phase"]) is not int or report["replacement_phase"] != 3
                    or type(report["changed"]) is not bool or report["input_sha256"] != before):
                raise ValueError("invalid terminal-phase receipt")
            source, target = _audit(report["input"]), _audit(report["output"])
            count = _count(report["rewritten_fields"])
            if target["terminal_fields"] or count != source["terminal_fields"]:
                raise ValueError("incomplete terminal-phase repair")
            expected = dict(source["values"])
            if count:
                del expected["5"]
                expected["3"] = expected.get("3", 0) + count
                live, first, last = (source[key] for key in
                    ("first_live_tick", "first_terminal_tick", "last_terminal_tick"))
                if live is None or first is None or last is None or not live < first <= last:
                    raise ValueError("no verified earlier live phase")
            if target["values"] != expected or target["fields_seen"] != source["fields_seen"]:
                raise ValueError("unexpected phase changes")
            if target["first_terminal_tick"] is not None or target["last_terminal_tick"] is not None:
                raise ValueError("terminal phase remains")
            if _sha256(demo) != before:
                raise ValueError("source demo changed during terminal-phase repair")
            if not report["changed"]:
                if count or report["output_sha256"] is not None or output.exists() or source != target:
                    raise ValueError("invalid clean terminal-phase receipt")
                return TerminalPhaseResult(0, None, None)
            if (not count or not output.is_file() or report["output_sha256"] == before
                    or report["output_sha256"] != _sha256(output)):
                raise ValueError("terminal-phase output hash mismatch")
            shutil.copymode(demo, output)
            os.replace(output, demo)
            return TerminalPhaseResult(count, source["first_terminal_tick"], source["last_terminal_tick"])
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        raise DemoPlaybackCompatibilityError(f"Demo 终局兼容处理失败：{exc}") from exc
