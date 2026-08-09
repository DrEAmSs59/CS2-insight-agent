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

from .video_export_log import export_event


FRAMEMELD_DELIVERY_FPS = 60
FRAMEMELD_SOURCE_FPS_TOLERANCE = 0.5
FRAMEMELD_PROTOCOL = "org.framemeld.cli"
FRAMEMELD_MIN_API_VERSION = 1
FRAMEMELD_ROUTE = "-framemeld"
FRAMEMELD_LEGACY_ROUTE = "-blur"
FRAMEMELD_STATUS_FEATURE = "structured-status-json-v1"
FRAMEMELD_STATUS_PREFIX = "framemeld-status:"
FRAMEMELD_STATUS_PROTOCOL = "org.framemeld.status"
FRAMEMELD_AMD_HARD_TIMEOUT_SECONDS = 12 * 60 * 60
FRAMEMELD_AMD_STALL_TIMEOUT_SECONDS = 15 * 60
FRAMEMELD_INTEL_HARD_TIMEOUT_SECONDS = 12 * 60 * 60
FRAMEMELD_INTEL_STALL_TIMEOUT_SECONDS = 15 * 60

# The second marker is accepted only so already-built FrameMeld runtimes remain
# usable while their public help text still carries the former product name.
_HELP_MARKERS = ("FrameMeld", "FFmpeg Insight headless Blur mode")


@dataclass(frozen=True)
class FrameMeldCapability:
    route: str
    api_version: int | None
    legacy: bool = False
    features: frozenset[str] = frozenset()


@dataclass(frozen=True)
class FrameMeldFailure:
    domain: str
    event: str
    encoder: str
    devices: dict[str, object]
    detail: str
    payload: dict[str, object]


@dataclass(frozen=True)
class FrameMeldExecutionPolicy:
    branch: str
    encoder: str
    hard_timeout_seconds: float
    stall_timeout_seconds: float


def _framemeld_policy_for_encoder(encoder: object) -> FrameMeldExecutionPolicy | None:
    normalized = str(encoder or "").casefold()
    if normalized.endswith("_amf"):
        return FrameMeldExecutionPolicy(
            branch="amd_amf",
            encoder=normalized,
            hard_timeout_seconds=FRAMEMELD_AMD_HARD_TIMEOUT_SECONDS,
            stall_timeout_seconds=FRAMEMELD_AMD_STALL_TIMEOUT_SECONDS,
        )
    if normalized.endswith("_qsv"):
        # Intel is deliberately isolated from the AMD policy so either branch
        # can evolve or be disabled without changing NVIDIA/CPU exports.
        return FrameMeldExecutionPolicy(
            branch="intel_qsv",
            encoder=normalized,
            hard_timeout_seconds=FRAMEMELD_INTEL_HARD_TIMEOUT_SECONDS,
            stall_timeout_seconds=FRAMEMELD_INTEL_STALL_TIMEOUT_SECONDS,
        )
    return None


def framemeld_execution_policy(command: Sequence[object]) -> FrameMeldExecutionPolicy | None:
    """Return the opt-in precise policy for an explicit AMF or QSV command."""

    options = [str(item) for item in command]
    if "--status-json-lines" not in options:
        return None
    for name in ("-c:v", "-codec:v", "-vcodec"):
        try:
            index = options.index(name)
        except ValueError:
            continue
        if index + 1 < len(options):
            return _framemeld_policy_for_encoder(options[index + 1])
    return None


def parse_framemeld_status_events(*outputs: object) -> list[dict[str, object]]:
    """Parse opt-in FrameMeld JSON-line events from mixed process output."""

    events: list[dict[str, object]] = []
    for raw in outputs:
        if not raw:
            continue
        for line in str(raw).replace("\r", "\n").splitlines():
            marker = line.find(FRAMEMELD_STATUS_PREFIX)
            if marker < 0:
                continue
            encoded = line[marker + len(FRAMEMELD_STATUS_PREFIX) :].strip()
            try:
                payload = json.loads(encoded)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("protocol") != FRAMEMELD_STATUS_PROTOCOL:
                continue
            events.append(payload)
    return events


_FRAMEMELD_DIAGNOSTIC_EVENTS = frozenset(
    {
        "device_inventory",
        "device_mapping",
        "encoder_binding",
        "first_frame",
        "first_packet",
        "performance_summary",
    }
)


def log_framemeld_diagnostic_events(
    events: Sequence[dict[str, object]],
    *,
    branch: str,
) -> None:
    """Copy bounded FrameMeld diagnostics into the dedicated export log."""

    seen: set[str] = set()
    performance_summary: dict[str, object] | None = None
    for payload in events:
        event_name = str(payload.get("event") or "")
        if event_name not in _FRAMEMELD_DIAGNOSTIC_EVENTS:
            continue
        fields = {
            str(key): value
            for key, value in payload.items()
            if key not in {"protocol", "version", "event"}
        }
        fields["branch"] = branch
        fields["diagnostic_source"] = "framemeld_status"
        fields["framemeld_status_version"] = payload.get("version")
        export_event(event_name, **fields)
        seen.add(event_name)
        if event_name == "performance_summary":
            performance_summary = payload

    # Very long jobs retain only a bounded stderr tail.  The final performance
    # summary repeats the first-observation timings, so preserve the named
    # events even if the original early JSON line has rolled out of capture.
    if performance_summary is None:
        return
    for event_name, observed_key, elapsed_key, stage in (
        ("first_frame", "first_frame_observed", "first_frame_ms", "frame_engine"),
        ("first_packet", "first_packet_observed", "first_packet_ms", "encoder_muxer"),
    ):
        if event_name in seen or not performance_summary.get(observed_key):
            continue
        export_event(
            event_name,
            status="observed",
            branch=branch,
            diagnostic_source="framemeld_performance_summary",
            stage=stage,
            elapsed_ms=performance_summary.get(elapsed_key),
            measurement="recovered_from_final_performance_summary",
            upper_bound=True,
        )


def framemeld_failure_from_result(result: object) -> FrameMeldFailure | None:
    events = parse_framemeld_status_events(
        getattr(result, "stdout", ""),
        getattr(result, "stderr", ""),
    )
    for payload in reversed(events):
        if payload.get("status") != "failed":
            continue
        domain = str(payload.get("failure_domain") or "unknown")
        if domain == "frame_engine":
            detail_candidates = (
                payload.get("detail"),
                payload.get("vspipe_stderr_tail"),
                payload.get("ffmpeg_stderr_tail"),
            )
        else:
            detail_candidates = (
                payload.get("detail"),
                payload.get("ffmpeg_stderr_tail"),
                payload.get("vspipe_stderr_tail"),
            )
        detail = str(next((item for item in detail_candidates if item), ""))
        raw_devices = payload.get("devices")
        devices = dict(raw_devices) if isinstance(raw_devices, dict) else {}
        return FrameMeldFailure(
            domain=domain,
            event=str(payload.get("event") or "unknown"),
            encoder=str(payload.get("encoder") or ""),
            devices=devices,
            detail=detail,
            payload=payload,
        )
    return None


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
    encoder_adapter: object | None = None,
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

    adapter_payload: dict[str, object] = {}
    if encoder_adapter is not None:
        for key in (
            "name",
            "vendor",
            "stable_id",
            "luid",
            "device_id",
            "driver_version",
            "kind",
            "enumeration_index",
            "encoder_device_index",
        ):
            value = getattr(encoder_adapter, key, None)
            if value not in (None, ""):
                adapter_payload[key] = value

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
    # AMF and QSV are separate opt-in policy branches.  The explicit encoder
    # backend is the boundary; GPU model names are diagnostic metadata only.
    precise_policy = _framemeld_policy_for_encoder(codec)
    if precise_policy is not None and FRAMEMELD_STATUS_FEATURE in resolved_capability.features:
        command.append("--status-json-lines")
        if adapter_payload:
            command.extend(
                [
                    "--host-encoder-adapter-json",
                    json.dumps(adapter_payload, ensure_ascii=False, separators=(",", ":")),
                ]
            )
    if encoder_device is not None and codec.casefold().endswith("_nvenc"):
        command.extend(["-gpu", encoder_device])
    command.extend(["-c:a", "copy", str(output_path)])
    return command
