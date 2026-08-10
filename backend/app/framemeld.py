"""Process-boundary adapter for the external FrameMeld runtime.

This module intentionally communicates with FrameMeld only through its public
command-line interface and media files.  It must not import, link, vendor, or
mirror FrameMeld's GPL-licensed processing implementation or render policies.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Sequence

from .env_utils import get_data_dir
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
FRAMEMELD_DEVICE_INVENTORY_FEATURE = "device-inventory-json-v1"
FRAMEMELD_RIFE_GPU_SELECTION_FEATURE = "rife-gpu-selection-v1"
FRAMEMELD_RIFE_BINDING_FEATURE = "rife-binding-json-v1"
FRAMEMELD_DEVICE_PROTOCOL = "org.framemeld.devices"
FRAMEMELD_AMD_HARD_TIMEOUT_SECONDS = 12 * 60 * 60
FRAMEMELD_AMD_STALL_TIMEOUT_SECONDS = 15 * 60
FRAMEMELD_INTEL_HARD_TIMEOUT_SECONDS = 12 * 60 * 60
FRAMEMELD_INTEL_STALL_TIMEOUT_SECONDS = 15 * 60

# The second marker is accepted only so already-built FrameMeld runtimes remain
# usable while their public help text still carries the former product name.
_HELP_MARKERS = ("FrameMeld", "FFmpeg Insight headless Blur mode")
_DEVICE_CACHE_VERSION = 1
_DEVICE_CACHE_MAX_ENTRIES = 64
_DEVICE_CACHE_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


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


@dataclass(frozen=True)
class FrameMeldRifeDevicePlan:
    index: int | None
    selection: str
    reason: str
    confidence: str
    preferred_adapter: dict[str, object]
    inventory_device: dict[str, object] | None
    cache_key: str

    @property
    def explicit(self) -> bool:
        return self.index is not None

    def log_fields(self) -> dict[str, object]:
        return {
            "requested_index": self.index,
            "selection": self.selection,
            "reason": self.reason,
            "confidence": self.confidence,
            "preferred_adapter": self.preferred_adapter or None,
            "inventory_device": self.inventory_device,
            "cache_key": self.cache_key or None,
        }


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
        "rife_binding",
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


@lru_cache(maxsize=16)
def _probe_framemeld_device_inventory_cached(
    path: str,
    modified_ns: int,
) -> dict[str, object] | None:
    capability = _probe_framemeld_cached(path, modified_ns)
    if (
        capability is None
        or FRAMEMELD_DEVICE_INVENTORY_FEATURE not in capability.features
    ):
        return None
    result = _run_probe(path, capability.route, "--device-inventory-json")
    if result is None or result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("protocol") != FRAMEMELD_DEVICE_PROTOCOL:
        return None
    inventory = payload.get("inventory")
    return dict(inventory) if isinstance(inventory, dict) else None


def probe_framemeld_device_inventory(
    ffmpeg_bin: Path,
    capability: FrameMeldCapability | None = None,
) -> dict[str, object] | None:
    resolved = Path(ffmpeg_bin).resolve()
    resolved_capability = capability or probe_framemeld(resolved)
    if (
        resolved_capability is None
        or FRAMEMELD_DEVICE_INVENTORY_FEATURE not in resolved_capability.features
    ):
        return None
    try:
        modified_ns = resolved.stat().st_mtime_ns
    except OSError:
        modified_ns = 0
    return _probe_framemeld_device_inventory_cached(str(resolved), modified_ns)


def _adapter_payload(adapter: object | None) -> dict[str, object]:
    payload: dict[str, object] = {}
    if adapter is None:
        return payload
    for key in (
        "name",
        "vendor",
        "stable_id",
        "luid",
        "pnp_device_id",
        "device_id",
        "driver_version",
        "kind",
        "dedicated_memory_bytes",
        "performance_rank",
        "enumeration_index",
        "encoder_device_index",
    ):
        value = getattr(adapter, key, None)
        if value not in (None, ""):
            payload[key] = value
    return payload


def _adapter_preference_key(adapter: object) -> tuple[object, ...]:
    kind = str(getattr(adapter, "kind", "unknown") or "unknown").casefold()
    kind_rank = {"discrete": 0, "unknown": 1, "integrated": 2}.get(kind, 1)
    performance_rank = getattr(adapter, "performance_rank", None)
    if isinstance(performance_rank, int):
        performance_key: tuple[object, ...] = (0, performance_rank)
    else:
        memory = getattr(adapter, "dedicated_memory_bytes", None)
        performance_key = (1, -int(memory or 0))
    return (
        kind_rank,
        *performance_key,
        int(getattr(adapter, "enumeration_index", 0) or 0),
        str(getattr(adapter, "stable_id", "")),
    )


def select_framemeld_rife_adapter(adapters: Sequence[object]) -> object | None:
    usable = [
        adapter
        for adapter in adapters
        if str(getattr(adapter, "vendor", "unknown")).casefold() in {"amd", "intel", "nvidia"}
    ]
    return min(usable, key=_adapter_preference_key) if usable else None


def _normalized_device_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _normalized_device_id(value: object) -> str:
    text = re.sub(r"^0x", "", str(value or "").strip(), flags=re.IGNORECASE)
    return text.upper().zfill(4) if text else ""


def _inventory_device_matches_adapter(
    device: dict[str, object],
    adapter: dict[str, object],
) -> bool:
    vendor = str(adapter.get("vendor") or "unknown").casefold()
    if vendor == "unknown" or str(device.get("vendor") or "unknown").casefold() != vendor:
        return False
    adapter_device_id = _normalized_device_id(adapter.get("device_id"))
    device_id = _normalized_device_id(device.get("device_id"))
    if adapter_device_id and device_id and adapter_device_id == device_id:
        return True
    adapter_name = _normalized_device_name(adapter.get("name"))
    return bool(adapter_name) and adapter_name == _normalized_device_name(device.get("name"))


def _runtime_identity(path: Path) -> dict[str, object]:
    resolved = path.resolve()
    try:
        stat = resolved.stat()
        return {
            "path": str(resolved),
            "size": int(stat.st_size),
            "modified_ns": int(stat.st_mtime_ns),
        }
    except OSError:
        return {"path": str(resolved), "size": None, "modified_ns": None}


def _device_cache_key(
    ffmpeg_bin: Path,
    adapters: Sequence[object],
    preferred_adapter: dict[str, object],
    inventory_devices: Sequence[dict[str, object]],
) -> str:
    topology = [
        _adapter_payload(adapter)
        for adapter in sorted(adapters, key=lambda item: str(getattr(item, "stable_id", "")))
    ]
    inventory = sorted(
        (
            {
                "index": item.get("index"),
                "name": item.get("name"),
                "vendor": item.get("vendor"),
                "device_id": item.get("device_id"),
            }
            for item in inventory_devices
        ),
        key=lambda item: int(item.get("index") or 0),
    )
    payload = {
        "runtime": _runtime_identity(ffmpeg_bin),
        "topology": topology,
        "preferred_adapter": preferred_adapter,
        "inventory": inventory,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def framemeld_device_cache_path() -> Path:
    return get_data_dir() / "device-cache" / "framemeld-device-mapping.json"


def _read_device_cache() -> dict[str, object]:
    path = framemeld_device_cache_path()
    try:
        if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
            return {"schema_version": _DEVICE_CACHE_VERSION, "entries": {}}
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, TypeError, json.JSONDecodeError):
        return {"schema_version": _DEVICE_CACHE_VERSION, "entries": {}}
    if not isinstance(payload, dict) or payload.get("schema_version") != _DEVICE_CACHE_VERSION:
        return {"schema_version": _DEVICE_CACHE_VERSION, "entries": {}}
    entries = payload.get("entries")
    payload["entries"] = dict(entries) if isinstance(entries, dict) else {}
    return payload


def _write_device_cache(payload: dict[str, object]) -> None:
    path = framemeld_device_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def plan_framemeld_rife_device(
    ffmpeg_bin: Path,
    adapters: Sequence[object],
    capability: FrameMeldCapability | None = None,
) -> FrameMeldRifeDevicePlan:
    resolved_capability = capability or probe_framemeld(ffmpeg_bin)
    preferred = _adapter_payload(select_framemeld_rife_adapter(adapters))
    if (
        resolved_capability is None
        or FRAMEMELD_RIFE_GPU_SELECTION_FEATURE not in resolved_capability.features
        or FRAMEMELD_RIFE_BINDING_FEATURE not in resolved_capability.features
        or FRAMEMELD_DEVICE_INVENTORY_FEATURE not in resolved_capability.features
    ):
        return FrameMeldRifeDevicePlan(
            None,
            "default",
            "framemeld_device_contract_unavailable",
            "none",
            preferred,
            None,
            "",
        )
    inventory = probe_framemeld_device_inventory(ffmpeg_bin, resolved_capability) or {}
    raw_devices = inventory.get("devices")
    inventory_devices = [
        dict(item)
        for item in raw_devices
        if isinstance(item, dict) and isinstance(item.get("index"), int)
    ] if isinstance(raw_devices, list) else []
    if not preferred or not inventory_devices:
        return FrameMeldRifeDevicePlan(
            None,
            "default",
            "preferred_adapter_or_inventory_unavailable",
            "none",
            preferred,
            None,
            "",
        )

    cache_key = _device_cache_key(ffmpeg_bin, adapters, preferred, inventory_devices)
    by_index = {int(item["index"]): item for item in inventory_devices}
    with _DEVICE_CACHE_LOCK:
        cache = _read_device_cache()
        raw_entries = cache.get("entries")
        entries = raw_entries if isinstance(raw_entries, dict) else {}
        cached = entries.get(cache_key)
    if isinstance(cached, dict):
        try:
            cached_index = int(cached.get("rife_index"))
        except (TypeError, ValueError):
            cached_index = -1
        actual = cached.get("actual")
        if (
            cached_index in by_index
            and isinstance(actual, dict)
            and _inventory_device_matches_adapter(dict(actual), preferred)
        ):
            return FrameMeldRifeDevicePlan(
                cached_index,
                "success-cache",
                "previous_ncnn_runtime_binding_succeeded",
                "high",
                preferred,
                by_index[cached_index],
                cache_key,
            )

    matches = [
        device
        for device in inventory_devices
        if _inventory_device_matches_adapter(device, preferred)
    ]
    if len(matches) != 1:
        return FrameMeldRifeDevicePlan(
            None,
            "default",
            "inventory_mapping_ambiguous" if matches else "inventory_mapping_unmatched",
            "none",
            preferred,
            None,
            cache_key,
        )

    selected = matches[0]
    return FrameMeldRifeDevicePlan(
        int(selected["index"]),
        "inventory-candidate",
        "unique_vendor_device_or_name_candidate",
        "medium",
        preferred,
        selected,
        cache_key,
    )


def record_framemeld_rife_result(
    plan: FrameMeldRifeDevicePlan | None,
    events: Sequence[dict[str, object]],
    *,
    succeeded: bool,
) -> bool:
    if plan is None or not plan.explicit or not plan.cache_key or not succeeded:
        return False
    binding = next(
        (payload for payload in reversed(events) if payload.get("event") == "rife_binding"),
        None,
    )
    if not isinstance(binding, dict) or not binding.get("index_binding_verified"):
        return False
    actual = binding.get("actual")
    if not isinstance(actual, dict) or actual.get("index") != plan.index:
        return False
    actual_payload = dict(actual)
    if plan.preferred_adapter and not _inventory_device_matches_adapter(
        actual_payload,
        plan.preferred_adapter,
    ):
        export_event(
            "rife_device_cache_rejected",
            level=logging.WARNING,
            reason="runtime_device_does_not_match_preferred_adapter",
            **plan.log_fields(),
            actual=actual_payload,
        )
        return False

    with _DEVICE_CACHE_LOCK:
        cache = _read_device_cache()
        raw_entries = cache.get("entries")
        entries: dict[str, object] = dict(raw_entries) if isinstance(raw_entries, dict) else {}
        entries[plan.cache_key] = {
            "rife_index": plan.index,
            "actual": actual_payload,
            "preferred_adapter": plan.preferred_adapter,
            "inventory_device": plan.inventory_device,
            "last_success_epoch": time.time(),
        }
        if len(entries) > _DEVICE_CACHE_MAX_ENTRIES:
            ordered = sorted(
                entries.items(),
                key=lambda item: float(
                    item[1].get("last_success_epoch", 0)
                    if isinstance(item[1], dict)
                    else 0
                ),
                reverse=True,
            )
            entries = dict(ordered[:_DEVICE_CACHE_MAX_ENTRIES])
        cache = {"schema_version": _DEVICE_CACHE_VERSION, "entries": entries}
        try:
            _write_device_cache(cache)
        except OSError:
            logger.warning("Unable to persist FrameMeld device mapping cache", exc_info=True)
            return False
    export_event(
        "rife_device_cache_updated",
        **plan.log_fields(),
        actual=actual_payload,
        cache_path=str(framemeld_device_cache_path()),
    )
    return True


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
    rife_device_plan: FrameMeldRifeDevicePlan | None = None,
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

    adapter_payload = _adapter_payload(encoder_adapter)

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
    needs_rife_diagnostics = bool(rife_device_plan is not None and rife_device_plan.explicit)
    if (
        (precise_policy is not None or needs_rife_diagnostics)
        and FRAMEMELD_STATUS_FEATURE in resolved_capability.features
    ):
        command.append("--status-json-lines")
        if adapter_payload:
            command.extend(
                [
                    "--host-encoder-adapter-json",
                    json.dumps(adapter_payload, ensure_ascii=False, separators=(",", ":")),
                ]
            )
        if rife_device_plan is not None and rife_device_plan.preferred_adapter:
            command.extend(
                [
                    "--host-rife-adapter-json",
                    json.dumps(
                        rife_device_plan.preferred_adapter,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                ]
            )
    if (
        rife_device_plan is not None
        and rife_device_plan.explicit
        and FRAMEMELD_RIFE_GPU_SELECTION_FEATURE in resolved_capability.features
    ):
        command.extend(["--gpu", str(rife_device_plan.index)])
    if encoder_device is not None and codec.casefold().endswith("_nvenc"):
        command.extend(["-gpu", encoder_device])
    command.extend(["-c:a", "copy", str(output_path)])
    return command
