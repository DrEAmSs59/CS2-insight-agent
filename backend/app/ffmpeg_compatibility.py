"""Audit a user-selected FFmpeg against the project's verified build baseline."""

from __future__ import annotations

import json
import logging
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any

from .ffmpeg_process import run_process_capture
from .montage_exceptions import MontageComposerError

logger = logging.getLogger(__name__)

_BASELINE_PATH = Path(__file__).with_name("ffmpeg_baseline.json")
_FALLBACK_BASELINE: dict[str, Any] = {
    "schema_version": 1,
    "recommended_name": "ffmpeg-2026-05-06-git-f2e5eff3ff-full_build",
    "reference_version": "2026-05-06-git-f2e5eff3ff-full_build-www.gyan.dev",
    "required_build_flags": [
        "--enable-libx264",
        "--enable-libdav1d",
        "--enable-amf",
        "--enable-libvpl",
        "--enable-nvenc",
        "--enable-vulkan",
        "--enable-opencl",
    ],
    "required_encoders": ["libx264", "h264_nvenc", "h264_amf", "h264_qsv"],
    "required_decoders": ["h264", "hevc", "av1", "vp9"],
    "required_hwaccels": ["cuda", "d3d11va", "d3d12va", "qsv"],
    "minimum_libraries": {
        "libavcodec": "62.30.100",
        "libavformat": "62.15.100",
        "libavfilter": "11.17.100",
    },
}
_COMPATIBILITY_HINT_CODES = {
    "MONTAGE_FFPROBE_FAILED": "MONTAGE_FFMPEG_SOURCE_COMPATIBILITY",
    "MONTAGE_ENCODER_ALL_FAILED": "MONTAGE_FFMPEG_ENCODER_COMPATIBILITY",
}


@lru_cache(maxsize=1)
def load_ffmpeg_baseline() -> dict[str, Any]:
    try:
        return json.loads(_BASELINE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("Could not load FFmpeg baseline manifest; using embedded fallback")
        return dict(_FALLBACK_BASELINE)


def _tokens(output: str) -> set[str]:
    found: set[str] = set()
    for line in output.splitlines():
        columns = line.strip().split()
        if len(columns) >= 2 and re.fullmatch(r"[A-Z.]{6}", columns[0]):
            found.add(columns[1].casefold())
    return found


def _version_tuple(value: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", value)[:3])


def _library_versions(output: str) -> dict[str, str]:
    versions: dict[str, str] = {}
    for name in ("libavcodec", "libavformat", "libavfilter"):
        match = re.search(rf"^{name}\s+(\d+)\.\s*(\d+)\.\s*(\d+)", output, re.MULTILINE)
        if match:
            versions[name] = ".".join(match.groups())
    return versions


def _run(command: list[str]) -> str:
    result = run_process_capture(command, timeout=20)
    if result.returncode != 0:
        raise OSError((result.stderr or result.stdout or "command failed").strip())
    return "\n".join(part for part in (result.stdout, result.stderr) if part)


@lru_cache(maxsize=16)
def _audit_cached(path: str, modified_ns: int) -> dict[str, Any]:
    del modified_ns
    ffmpeg = Path(path)
    baseline = load_ffmpeg_baseline()
    try:
        version_output = _run([str(ffmpeg), "-version"])
        encoder_output = _run([str(ffmpeg), "-hide_banner", "-encoders"])
        decoder_output = _run([str(ffmpeg), "-hide_banner", "-decoders"])
        hwaccel_output = _run([str(ffmpeg), "-hide_banner", "-hwaccels"])
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "compatible": False,
            "audit_failed": True,
            "recommended": baseline["recommended_name"],
            "current_version": "unknown",
            "issues": ["ffmpeg_not_auditable"],
            "detail": str(exc)[-600:],
        }

    first_line = version_output.splitlines()[0] if version_output.splitlines() else ""
    current_version = first_line.removeprefix("ffmpeg version ").split(" Copyright", 1)[0].strip()
    encoders = _tokens(encoder_output)
    decoders = _tokens(decoder_output)
    hwaccels = {line.strip().casefold() for line in hwaccel_output.splitlines()}
    libraries = _library_versions(version_output)
    issues: list[str] = []

    for flag in baseline.get("required_build_flags", []):
        if str(flag) not in version_output:
            issues.append(f"missing_build_flag:{flag}")
    for encoder in baseline.get("required_encoders", []):
        if str(encoder).casefold() not in encoders:
            issues.append(f"missing_encoder:{encoder}")
    for decoder in baseline.get("required_decoders", []):
        if str(decoder).casefold() not in decoders:
            issues.append(f"missing_decoder:{decoder}")
    for hwaccel in baseline.get("required_hwaccels", []):
        if str(hwaccel).casefold() not in hwaccels:
            issues.append(f"missing_hwaccel:{hwaccel}")
    for library, minimum in baseline.get("minimum_libraries", {}).items():
        current = libraries.get(str(library), "")
        if not current or _version_tuple(current) < _version_tuple(str(minimum)):
            issues.append(f"library_too_old:{library}:{current or 'missing'}<{minimum}")

    return {
        "compatible": not issues,
        "audit_failed": False,
        "recommended": baseline["recommended_name"],
        "reference_version": baseline["reference_version"],
        "current_version": current_version or "unknown",
        "issues": issues,
    }


def audit_ffmpeg_compatibility(ffmpeg_bin: Path) -> dict[str, Any]:
    """Return a cached capability comparison for the selected executable."""

    resolved = Path(ffmpeg_bin).resolve()
    try:
        modified_ns = resolved.stat().st_mtime_ns
    except OSError:
        modified_ns = 0
    report = _audit_cached(str(resolved), modified_ns)
    logger.info(
        "FFmpeg baseline audit compatible=%s current=%s recommended=%s issues=%s",
        report.get("compatible"),
        report.get("current_version"),
        report.get("recommended"),
        ",".join(report.get("issues") or []),
    )
    return dict(report)


def add_ffmpeg_compatibility_hint(
    exc: MontageComposerError,
    ffmpeg_bin: Path,
) -> MontageComposerError:
    """Replace selected failures with an actionable compatibility warning."""

    if exc.code not in _COMPATIBILITY_HINT_CODES:
        return exc
    report = audit_ffmpeg_compatibility(ffmpeg_bin)
    if report.get("compatible") or report.get("audit_failed"):
        return exc
    params = dict(exc.params)
    params.update(
        {
            "original_code": exc.code,
            "recommended": report.get("recommended", ""),
            "current_version": report.get("current_version", "unknown"),
            "compatibility_issues": report.get("issues", []),
        },
    )
    return MontageComposerError(_COMPATIBILITY_HINT_CODES[exc.code], **params)
