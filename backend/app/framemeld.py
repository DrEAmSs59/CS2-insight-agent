"""Process-boundary adapter for the external FrameMeld runtime.

This module intentionally communicates with FrameMeld only through its public
command-line interface and media files.  It must not import, link, vendor, or
mirror FrameMeld's GPL-licensed processing implementation or render policies.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Sequence


FRAMEMELD_DELIVERY_FPS = 60
FRAMEMELD_SOURCE_FPS_TOLERANCE = 0.5
FRAMEMELD_PROTOCOL = "org.framemeld.cli"
FRAMEMELD_MIN_API_VERSION = 1
FRAMEMELD_ROUTE = "-framemeld"
FRAMEMELD_LEGACY_ROUTE = "-blur"

# The second marker is accepted only so already-built FrameMeld runtimes remain
# usable while their public help text still carries the former product name.
_HELP_MARKERS = ("FrameMeld", "FFmpeg Insight headless Blur mode")


@dataclass(frozen=True)
class FrameMeldCapability:
    route: str
    api_version: int | None
    legacy: bool = False
    features: frozenset[str] = frozenset()


def _run_probe(path: str, *args: str) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            [path, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def _capability_from_json(result: subprocess.CompletedProcess[str] | None) -> FrameMeldCapability | None:
    if result is None or result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout)
        api_version = int(payload.get("api_version"))
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if payload.get("protocol") != FRAMEMELD_PROTOCOL or api_version < FRAMEMELD_MIN_API_VERSION:
        return None
    raw_features = payload.get("features")
    features = frozenset(
        str(item)
        for item in raw_features
        if isinstance(item, str) and item
    ) if isinstance(raw_features, list) else frozenset()
    return FrameMeldCapability(
        route=FRAMEMELD_ROUTE,
        api_version=api_version,
        features=features,
    )


def _help_identifies_framemeld(result: subprocess.CompletedProcess[str] | None) -> bool:
    if result is None or result.returncode != 0:
        return False
    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    return any(marker in output for marker in _HELP_MARKERS)


@lru_cache(maxsize=16)
def _probe_framemeld_cached(path: str, modified_ns: int) -> FrameMeldCapability | None:
    del modified_ns

    capability = _capability_from_json(_run_probe(path, FRAMEMELD_ROUTE, "--capabilities-json"))
    if capability is not None:
        return capability

    if _help_identifies_framemeld(_run_probe(path, FRAMEMELD_ROUTE, "--help")):
        return FrameMeldCapability(route=FRAMEMELD_ROUTE, api_version=None)

    if _help_identifies_framemeld(_run_probe(path, FRAMEMELD_LEGACY_ROUTE, "--help")):
        return FrameMeldCapability(route=FRAMEMELD_LEGACY_ROUTE, api_version=None, legacy=True)
    return None


def probe_framemeld(ffmpeg_bin: Path) -> FrameMeldCapability | None:
    """Return the supported public FrameMeld CLI route, if available."""

    resolved = Path(ffmpeg_bin).resolve()
    try:
        modified_ns = resolved.stat().st_mtime_ns
    except OSError:
        modified_ns = 0
    return _probe_framemeld_cached(str(resolved), modified_ns)


def supports_framemeld(ffmpeg_bin: Path) -> bool:
    return probe_framemeld(ffmpeg_bin) is not None


def normalize_source_fps_values(source_fps_values: Sequence[object]) -> list[float]:
    values: list[float] = []
    for raw in source_fps_values:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value >= 1.0:
            values.append(value)
    return values


def framemeld_sources_are_compatible(source_fps_values: Sequence[object]) -> bool:
    """Protect source identity before the single external FrameMeld pass.

    Insight Agent does not duplicate FrameMeld's profile table.  It only makes
    sure the editor has not collapsed materially different source timelines
    into one reported frame rate before handing the file to FrameMeld.
    """

    values = normalize_source_fps_values(source_fps_values)
    return (
        bool(values)
        and len(values) == len(source_fps_values)
        and max(values) - min(values) <= FRAMEMELD_SOURCE_FPS_TOLERANCE
    )


def framemeld_working_fps(source_fps_values: Sequence[object]) -> float:
    values = normalize_source_fps_values(source_fps_values)
    if not values:
        raise ValueError("FrameMeld requires a readable source frame rate")
    if max(values) - min(values) > FRAMEMELD_SOURCE_FPS_TOLERANCE:
        raise ValueError("FrameMeld sources must use one frame-rate family")
    return max(values)


def build_framemeld_command(
    *,
    ffmpeg_bin: Path,
    source_path: Path,
    output_path: Path,
    video_encode_args: Sequence[str],
    capability: FrameMeldCapability | None = None,
) -> list[str]:
    """Build a 60 FPS automatic FrameMeld render command.

    Interpolation targets, duplicate repair, sample counts, weights, and blur
    strength are deliberately omitted.  They are FrameMeld-owned policy.
    """

    resolved_capability = capability or probe_framemeld(ffmpeg_bin)
    if resolved_capability is None:
        raise ValueError("The configured executable does not expose FrameMeld")

    options = [str(item) for item in video_encode_args]

    def value_after(*names: str) -> str | None:
        for name in names:
            try:
                index = options.index(name)
            except ValueError:
                continue
            if index + 1 < len(options):
                return options[index + 1]
        return None

    codec = value_after("-c:v", "-codec:v", "-vcodec") or "h264"
    quality = value_after("-cq", "-crf", "-global_quality", "-qp_i", "-qp_p") or "20"
    encoder_device = value_after("-gpu")

    command = [
        str(ffmpeg_bin),
        resolved_capability.route,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "--performance-mode",
        "balanced",
        "--blur-output-fps",
        str(FRAMEMELD_DELIVERY_FPS),
        "-c:v",
        codec,
        "-cq",
        quality,
    ]
    if "host-managed-encoder-fallback" in resolved_capability.features:
        command.append("--host-managed-encoder-fallback")
    if encoder_device is not None and codec.casefold().endswith("_nvenc"):
        command.extend(["-gpu", encoder_device])
    command.extend(["-c:a", "copy", str(output_path)])
    return command
