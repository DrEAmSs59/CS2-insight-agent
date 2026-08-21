"""Shared GPU-aware H.264 encoder planning.

This module deliberately stops at planning and capability probing.  Export
pipelines remain responsible for constructing FFmpeg commands and retrying a
failed export from the beginning.

The built-in Windows enumerator uses Win32_VideoController because it is
available without additional dependencies.  Callers that have a DXGI
enumerator can inject richer :class:`GpuAdapter` records (including DXGI high
performance ranks and encoder-specific device indexes) into
``build_auto_encoder_candidates``.
"""

from __future__ import annotations

import csv
import ctypes
import hashlib
import io
import json
import logging
import math
import platform
import re
import subprocess
import tempfile
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, Protocol, TypeAlias

from .ffmpeg_process import command_for_log, process_error_tail, run_process_capture
from .montage_exceptions import HardwareEncoderFailure, MontageComposerError
from .montage_encoder import apply_encoder_device_args, h264_encode_cli_args

logger = logging.getLogger(__name__)

GpuVendor: TypeAlias = Literal["nvidia", "amd", "intel", "unknown"]
GpuKind: TypeAlias = Literal["discrete", "integrated", "unknown"]

_VENDOR_CODEC: Mapping[GpuVendor, str] = {
    "nvidia": "h264_nvenc",
    "amd": "h264_amf",
    "intel": "h264_qsv",
}

_VIRTUAL_ADAPTER_MARKERS = (
    "microsoft basic display",
    "microsoft basic render",
    "microsoft remote display",
    "remote display adapter",
    "indirect display",
    "virtual display",
    "virtualbox",
    "vmware svga",
    "vmware virtual",
    "hyper-v video",
    "parsec virtual",
    "spacedesk",
    "iddsample",
    "rustdesk",
    "citrix display",
)

_POWERSHELL_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $items = @(Get-CimInstance Win32_VideoController -ErrorAction Stop)
} catch {
  $items = @(Get-WmiObject Win32_VideoController -ErrorAction Stop)
}
$items |
  Select-Object Name,PNPDeviceID,AdapterCompatibility,AdapterRAM,DriverVersion,VideoProcessor,Status,Availability |
  ConvertTo-Json -Depth 3 -Compress
""".strip()


class CommandRunner(Protocol):
    def __call__(self, command: Sequence[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]: ...


@dataclass(frozen=True, slots=True)
class GpuAdapter:
    """A physical GPU candidate.

    ``performance_rank`` follows DXGI semantics when supplied: zero is the
    highest-performance adapter.  The dependency-free CIM enumerator can only
    preserve Windows' enumeration order, so it uses that order as a best-effort
    rank.

    ``encoder_device_index`` must only be supplied by an enumerator that has
    positively mapped the physical adapter to the encoder API's device index.
    CIM/PNP ordering alone is not sufficient for that mapping.
    """

    name: str
    vendor: GpuVendor
    kind: GpuKind = "unknown"
    pnp_device_id: str = ""
    device_id: str = ""
    driver_version: str = ""
    dedicated_memory_bytes: int | None = None
    performance_rank: int | None = None
    enumeration_index: int = 0
    encoder_device_index: int | None = None
    luid: str = ""

    @property
    def stable_id(self) -> str:
        if self.luid:
            return self.luid.upper()
        if self.pnp_device_id:
            return self.pnp_device_id.upper()
        seed = f"{self.vendor}|{self.device_id}|{self.name}".casefold()
        return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:20]


@dataclass(frozen=True, slots=True)
class EncoderTargetSpec:
    """The output characteristics that can affect encoder capability."""

    width: int
    height: int
    frame_rate: float
    pixel_format: str = "yuv420p"
    profile: str = ""
    level: str = ""
    tier: str = "quality"
    encoder_options: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("width and height must be positive")
        if not math.isfinite(float(self.frame_rate)) or self.frame_rate <= 0:
            raise ValueError("frame_rate must be positive and finite")

    def cache_payload(self) -> dict[str, object]:
        return {
            "width": self.width,
            "height": self.height,
            # Avoid cache misses caused solely by insignificant float noise.
            "frame_rate": round(float(self.frame_rate), 6),
            "pixel_format": self.pixel_format.casefold(),
            "profile": self.profile.casefold(),
            "level": self.level.casefold(),
            "tier": self.tier.casefold(),
            "encoder_options": list(self.encoder_options),
        }


@dataclass(frozen=True, slots=True)
class EncoderCandidate:
    codec: str
    priority: int
    adapter: GpuAdapter | None = None
    ffmpeg_device_args: tuple[str, ...] = ()

    @property
    def is_software(self) -> bool:
        # ``adapter`` describes device attribution, not encoder type.  Manual
        # hardware modes intentionally retain an adapter-less candidate when
        # Windows enumeration fails, so they can still be runtime-probed.
        return self.codec.casefold() == "libx264"

    @property
    def is_hardware(self) -> bool:
        return self.codec.casefold() in _VENDOR_CODEC.values()

    @property
    def has_explicit_device_binding(self) -> bool:
        return bool(self.ffmpeg_device_args)

    @property
    def display_name(self) -> str:
        if self.adapter is None:
            return self.codec
        if self.has_explicit_device_binding:
            return f"{self.codec} ({self.adapter.name})"
        # AMF/QSV do not have a safely mapped encoder-private device index in
        # this pipeline. The preferred adapter selects the vendor/codec, while
        # FFmpeg still opens that vendor's system-default device.
        return (
            f"{self.codec} (system-default {self.adapter.vendor}; "
            f"preferred {self.adapter.name})"
        )


def _candidate_invocation_key(
    candidate: EncoderCandidate,
) -> tuple[str, tuple[str, ...]]:
    """Identity of the FFmpeg encoder invocation, independent of its label."""

    return (
        candidate.codec.casefold(),
        tuple(str(item) for item in candidate.ffmpeg_device_args),
    )


def _deduplicate_candidates(
    candidates: Iterable[EncoderCandidate],
) -> tuple[EncoderCandidate, ...]:
    result: list[EncoderCandidate] = []
    seen: set[tuple[str, tuple[str, ...]]] = set()
    for candidate in candidates:
        key = _candidate_invocation_key(candidate)
        if key in seen:
            continue
        seen.add(key)
        result.append(candidate)
    return tuple(result)


@dataclass(frozen=True, slots=True)
class EncoderProbeResult:
    ok: bool
    detail: str = ""


ProbeCallback: TypeAlias = Callable[
    [EncoderCandidate, EncoderTargetSpec],
    bool | EncoderProbeResult,
]


@dataclass(frozen=True, slots=True)
class EncoderProbeAttempt:
    candidate: EncoderCandidate
    result: EncoderProbeResult
    cache_key: str
    from_cache: bool


@dataclass(frozen=True, slots=True)
class EncoderPlan:
    candidates: tuple[EncoderCandidate, ...]
    selected: EncoderCandidate | None
    attempts: tuple[EncoderProbeAttempt, ...]


@dataclass(frozen=True, slots=True)
class EncoderExportAttempt:
    candidate: EncoderCandidate
    status: Literal["probe_failed", "export_failed", "succeeded"]
    detail: str = ""
    stage: str = ""


def parse_nvenc_driver_warning(
    codec: str,
    detail: str,
    *,
    current_driver_version: str = "",
) -> dict[str, str] | None:
    """Return a UI-safe warning when FFmpeg reports an outdated NVIDIA driver."""

    if str(codec or "").strip().casefold() != "h264_nvenc":
        return None
    raw_detail = str(detail or "").strip()
    lowered = raw_detail.casefold()
    if not raw_detail or not (
        "required nvenc api version" in lowered
        or "minimum required nvidia driver" in lowered
    ):
        return None

    def _capture(pattern: str) -> str:
        match = re.search(pattern, raw_detail, flags=re.IGNORECASE)
        return match.group(1) if match else ""

    warning = {
        "code": "NVIDIA_DRIVER_TOO_OLD",
        "codec": "h264_nvenc",
    }
    found_api = _capture(r"\bfound\s*:\s*([0-9]+(?:\.[0-9]+)*)")
    required_api = _capture(r"\brequired\s*:\s*([0-9]+(?:\.[0-9]+)*)")
    minimum_driver = _capture(
        r"minimum\s+required\s+nvidia\s+driver(?:\s+for\s+nvenc)?\s+is\s+"
        r"([0-9]+(?:\.[0-9]+)*)"
    )
    if found_api:
        warning["found_nvenc_api"] = found_api
    if required_api:
        warning["required_nvenc_api"] = required_api
    if minimum_driver:
        warning["minimum_driver_version"] = minimum_driver
    if str(current_driver_version or "").strip():
        warning["current_driver_version"] = str(current_driver_version).strip()
    return warning


@dataclass(frozen=True, slots=True)
class EncoderRunResult:
    value: object
    selected: EncoderCandidate
    attempts: tuple[EncoderExportAttempt, ...]


class EncoderProbeCache:
    """Small thread-safe in-memory cache for specification probes."""

    def __init__(self) -> None:
        self._values: dict[str, EncoderProbeResult] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> EncoderProbeResult | None:
        with self._lock:
            return self._values.get(key)

    def put(self, key: str, result: EncoderProbeResult) -> None:
        with self._lock:
            self._values[key] = result

    def invalidate(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._values.clear()
            else:
                self._values.pop(key, None)


_target_probe_cache = EncoderProbeCache()


def _decode_command_output(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if not isinstance(value, bytes):
        return str(value)
    for encoding in ("utf-8-sig", "utf-16", "gb18030"):
        try:
            return value.decode(encoding)
        except UnicodeDecodeError:
            continue
    return value.decode("utf-8", errors="replace")


def _as_optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if number >= 0 else None


def _normalise_cim_rows(payload: object) -> list[dict[str, object]]:
    if isinstance(payload, dict):
        return [payload]
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    return []


def _query_with_powershell(runner: CommandRunner) -> list[dict[str, object]]:
    for executable in ("powershell.exe", "powershell", "pwsh.exe", "pwsh"):
        command = [
            executable,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            _POWERSHELL_SCRIPT,
        ]
        try:
            proc = runner(
                command,
                capture_output=True,
                text=False,
                timeout=15,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode != 0:
            continue
        output = _decode_command_output(proc.stdout).strip()
        if not output:
            return []
        try:
            return _normalise_cim_rows(json.loads(output))
        except (TypeError, ValueError, json.JSONDecodeError):
            logger.debug("Unable to parse PowerShell GPU inventory", exc_info=True)
    return []


def _query_with_wmic(runner: CommandRunner) -> list[dict[str, object]]:
    command = [
        "wmic.exe",
        "path",
        "Win32_VideoController",
        "get",
        "Name,PNPDeviceID,AdapterCompatibility,AdapterRAM,DriverVersion,VideoProcessor,Status,Availability",
        "/format:csv",
    ]
    try:
        proc = runner(
            command,
            capture_output=True,
            text=False,
            timeout=15,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    text = _decode_command_output(proc.stdout).lstrip("\ufeff\r\n ")
    if not text:
        return []
    try:
        rows = []
        for row in csv.DictReader(io.StringIO(text)):
            rows.append({key: value for key, value in row.items() if key and key != "Node"})
        return rows
    except (csv.Error, UnicodeError):
        logger.debug("Unable to parse WMIC GPU inventory", exc_info=True)
        return []


def _row_value(row: Mapping[str, object], key: str) -> object:
    wanted = key.casefold()
    for row_key, value in row.items():
        if str(row_key).casefold() == wanted:
            return value
    return None


def _detect_vendor(name: str, compatibility: str, pnp_device_id: str) -> GpuVendor:
    text = f"{name} {compatibility} {pnp_device_id}".casefold()
    if "ven_10de" in text or "nvidia" in text:
        return "nvidia"
    if "ven_1002" in text or "advanced micro devices" in text or re.search(r"\bamd\b", text):
        return "amd"
    if "ven_8086" in text or "intel" in text:
        return "intel"
    return "unknown"


def _detect_kind(name: str, vendor: GpuVendor, memory_bytes: int | None) -> GpuKind:
    normalised = name.casefold()
    model_name = re.sub(r"\((?:r|tm)\)", "", normalised)
    if vendor == "nvidia":
        return "discrete"
    if vendor == "intel":
        # "Intel Arc Graphics" is also used by some integrated Core Ultra
        # GPUs; require a discrete Arc model suffix rather than the brand alone.
        if re.search(r"\barc\s+(?:pro\s+)?[ab]\d{3}\b", model_name) or re.search(
            r"\biris\s*xe\s*max\b", model_name
        ):
            return "discrete"
        return "integrated"
    if vendor == "amd":
        if re.search(r"\b(?:rx|firepro)\s*[\w-]+", model_name) or re.search(
            r"\bradeon\s+pro\s+(?:w|v)\d+", model_name
        ):
            return "discrete"
        if (
            "radeon graphics" in model_name
            or re.search(r"\b(?:vega\s*\d+|[678]\d{2}m)\b", model_name)
        ):
            return "integrated"
    # AdapterRAM is imperfect (especially on old WMI providers), so only use a
    # conservative threshold as a final hint.
    if memory_bytes is not None and memory_bytes >= 3 * 1024**3:
        return "discrete"
    return "unknown"


def _is_virtual_or_software(row: Mapping[str, object]) -> bool:
    text = " ".join(
        str(_row_value(row, key) or "")
        for key in ("Name", "AdapterCompatibility", "PNPDeviceID", "VideoProcessor")
    ).casefold()
    return any(marker in text for marker in _VIRTUAL_ADAPTER_MARKERS)


def _device_id_from_pnp(pnp_device_id: str) -> str:
    match = re.search(r"(?:DEV_|DEVICE_)([0-9A-F]{4})", pnp_device_id, re.IGNORECASE)
    return match.group(1).upper() if match else ""


def adapters_from_windows_rows(rows: Iterable[Mapping[str, object]]) -> list[GpuAdapter]:
    """Convert raw Win32_VideoController records into filtered adapters."""

    adapters: list[GpuAdapter] = []
    seen: set[str] = set()
    for row in rows:
        if _is_virtual_or_software(row):
            continue
        name = str(_row_value(row, "Name") or "").strip()
        if not name:
            continue
        status = str(_row_value(row, "Status") or "").strip().casefold()
        if status and status not in {"ok", "unknown"}:
            continue
        pnp_id = str(_row_value(row, "PNPDeviceID") or "").strip()
        compatibility = str(_row_value(row, "AdapterCompatibility") or "").strip()
        vendor = _detect_vendor(name, compatibility, pnp_id)
        # Unknown display controllers cannot produce a known FFmpeg hardware
        # candidate and are excluded from the planner.
        if vendor == "unknown":
            continue
        stable_id = pnp_id.upper() or f"{vendor}|{name.casefold()}"
        if stable_id in seen:
            continue
        seen.add(stable_id)
        memory = _as_optional_int(_row_value(row, "AdapterRAM"))
        index = len(adapters)
        adapters.append(
            GpuAdapter(
                name=name,
                vendor=vendor,
                kind=_detect_kind(name, vendor, memory),
                pnp_device_id=pnp_id,
                device_id=_device_id_from_pnp(pnp_id),
                driver_version=str(_row_value(row, "DriverVersion") or "").strip(),
                dedicated_memory_bytes=memory,
                performance_rank=index,
                enumeration_index=index,
            )
        )
    return adapters


def _guid(value: str) -> ctypes.Structure:
    import uuid

    raw = uuid.UUID(value).bytes_le

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    return GUID.from_buffer_copy(raw)


def _enumerate_dxgi_gpus() -> list[GpuAdapter]:
    """Enumerate physical adapters in DXGI high-performance order."""

    if platform.system().casefold() != "windows":
        return []
    try:
        win_dll = getattr(ctypes, "WinDLL")
        winfunctype = getattr(ctypes, "WINFUNCTYPE")
        dxgi = win_dll("dxgi.dll")
    except (AttributeError, OSError):
        return []

    class LUID(ctypes.Structure):
        _fields_ = [("LowPart", ctypes.c_uint32), ("HighPart", ctypes.c_int32)]

    class DXGI_ADAPTER_DESC1(ctypes.Structure):
        _fields_ = [
            ("Description", ctypes.c_wchar * 128),
            ("VendorId", ctypes.c_uint32),
            ("DeviceId", ctypes.c_uint32),
            ("SubSysId", ctypes.c_uint32),
            ("Revision", ctypes.c_uint32),
            ("DedicatedVideoMemory", ctypes.c_size_t),
            ("DedicatedSystemMemory", ctypes.c_size_t),
            ("SharedSystemMemory", ctypes.c_size_t),
            ("AdapterLuid", LUID),
            ("Flags", ctypes.c_uint32),
        ]

    iid_factory6 = _guid("c1b6694f-ff09-44a9-b03c-77900a0a1d17")
    iid_adapter1 = _guid("29038f61-3839-4626-91fd-086879011a05")
    create_factory = dxgi.CreateDXGIFactory1
    create_factory.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    create_factory.restype = ctypes.c_long
    factory = ctypes.c_void_p()
    try:
        hr = int(create_factory(ctypes.byref(iid_factory6), ctypes.byref(factory)))
    except (OSError, ValueError):
        return []
    if hr < 0 or not factory.value:
        return []

    def _method(
        pointer: ctypes.c_void_p,
        index: int,
        restype: object,
        *argtypes: object,
    ) -> object:
        table = ctypes.cast(
            pointer,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
        ).contents
        return winfunctype(restype, ctypes.c_void_p, *argtypes)(table[index])

    release_factory = _method(factory, 2, ctypes.c_ulong)
    enum_by_preference = _method(
        factory,
        29,
        ctypes.c_long,
        ctypes.c_uint,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    )
    adapters: list[GpuAdapter] = []
    try:
        for index in range(64):
            adapter_ptr = ctypes.c_void_p()
            try:
                hr = int(
                    enum_by_preference(
                        factory,
                        index,
                        2,  # DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE
                        ctypes.byref(iid_adapter1),
                        ctypes.byref(adapter_ptr),
                    ),
                )
            except (OSError, ValueError):
                break
            if (hr & 0xFFFFFFFF) == 0x887A0002:  # DXGI_ERROR_NOT_FOUND
                break
            if hr < 0 or not adapter_ptr.value:
                continue
            release_adapter = _method(adapter_ptr, 2, ctypes.c_ulong)
            get_desc1 = _method(
                adapter_ptr,
                10,
                ctypes.c_long,
                ctypes.POINTER(DXGI_ADAPTER_DESC1),
            )
            try:
                desc = DXGI_ADAPTER_DESC1()
                if int(get_desc1(adapter_ptr, ctypes.byref(desc))) < 0:
                    continue
                # DXGI_ADAPTER_FLAG_REMOTE | DXGI_ADAPTER_FLAG_SOFTWARE
                if int(desc.Flags) & 0x3:
                    continue
                vendor: GpuVendor = {
                    0x10DE: "nvidia",
                    0x1002: "amd",
                    0x8086: "intel",
                }.get(int(desc.VendorId), "unknown")
                if vendor == "unknown":
                    continue
                name = str(desc.Description).rstrip("\x00").strip()
                memory = int(desc.DedicatedVideoMemory)
                luid_value = (
                    (int(desc.AdapterLuid.HighPart) & 0xFFFFFFFF) << 32
                ) | int(desc.AdapterLuid.LowPart)
                adapters.append(
                    GpuAdapter(
                        name=name,
                        vendor=vendor,
                        kind=_detect_kind(name, vendor, memory),
                        device_id=f"{int(desc.DeviceId):04X}",
                        dedicated_memory_bytes=memory,
                        performance_rank=index,
                        enumeration_index=index,
                        luid=f"{luid_value:016X}",
                    ),
                )
            finally:
                release_adapter(adapter_ptr)
    finally:
        release_factory(factory)
    return adapters


def _normalise_gpu_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


def _merge_dxgi_and_cim(
    dxgi_adapters: Sequence[GpuAdapter],
    cim_adapters: Sequence[GpuAdapter],
) -> list[GpuAdapter]:
    """Enrich authoritative DXGI rows with driver and PNP data from CIM."""

    unused = list(cim_adapters)
    merged: list[GpuAdapter] = []
    seen_dxgi_ids: set[str] = set()
    for adapter in dxgi_adapters:
        # A buggy driver can expose the same logical adapter more than once.
        # LUID is authoritative when DXGI supplied it.
        if adapter.stable_id in seen_dxgi_ids:
            continue
        seen_dxgi_ids.add(adapter.stable_id)
        match: GpuAdapter | None = None
        for candidate in unused:
            same_device = bool(adapter.device_id) and (
                adapter.vendor == candidate.vendor
                and adapter.device_id.casefold() == candidate.device_id.casefold()
            )
            same_name = _normalise_gpu_name(adapter.name) == _normalise_gpu_name(candidate.name)
            if same_device or same_name:
                match = candidate
                break
        if match is not None:
            unused.remove(match)
        elif any(
            existing.vendor == adapter.vendor
            and existing.device_id.casefold() == adapter.device_id.casefold()
            and _normalise_gpu_name(existing.name) == _normalise_gpu_name(adapter.name)
            for existing in merged
        ):
            # Some drivers expose an additional logical DXGI adapter for the
            # same physical controller.  Keep it only when CIM confirms a
            # second matching physical device.
            continue
        merged.append(
            GpuAdapter(
                name=adapter.name,
                vendor=adapter.vendor,
                kind=adapter.kind if adapter.kind != "unknown" else (match.kind if match else "unknown"),
                pnp_device_id=match.pnp_device_id if match else "",
                device_id=adapter.device_id or (match.device_id if match else ""),
                driver_version=match.driver_version if match else "",
                dedicated_memory_bytes=adapter.dedicated_memory_bytes,
                performance_rank=adapter.performance_rank,
                enumeration_index=adapter.enumeration_index,
                encoder_device_index=adapter.encoder_device_index,
                luid=adapter.luid,
            ),
        )
    return merged


def enumerate_windows_gpus(
    *,
    runner: CommandRunner = subprocess.run,
    platform_name: str | None = None,
    dxgi_enumerator: Callable[[], list[GpuAdapter]] | None = None,
) -> list[GpuAdapter]:
    """Enumerate usable Windows GPUs without third-party dependencies.

    Failure is intentionally non-fatal; callers will still receive the x264
    fallback from ``build_auto_encoder_candidates``.
    """

    current_platform = (platform_name or platform.system()).casefold()
    if current_platform != "windows":
        return []
    rows = _query_with_powershell(runner)
    if not rows:
        rows = _query_with_wmic(runner)
    cim_adapters = adapters_from_windows_rows(rows)
    # Custom subprocess runners are normally tests; avoid touching host DXGI
    # unless an enumerator was explicitly supplied.
    if dxgi_enumerator is None and runner is subprocess.run:
        dxgi_enumerator = _enumerate_dxgi_gpus
    dxgi_adapters = dxgi_enumerator() if dxgi_enumerator is not None else []
    if dxgi_adapters:
        return _merge_dxgi_and_cim(dxgi_adapters, cim_adapters)
    return cim_adapters


def _adapter_sort_key(adapter: GpuAdapter) -> tuple[object, ...]:
    kind_rank = {"discrete": 0, "unknown": 1, "integrated": 2}[adapter.kind]
    if adapter.performance_rank is not None:
        performance_key: tuple[object, ...] = (0, adapter.performance_rank)
    else:
        memory = adapter.dedicated_memory_bytes or 0
        performance_key = (1, -memory)
    return (
        kind_rank,
        *performance_key,
        adapter.enumeration_index,
        adapter.stable_id,
    )


def build_auto_encoder_candidates(
    adapters: Iterable[GpuAdapter],
    *,
    available_encoders: Iterable[str] | None = None,
) -> tuple[EncoderCandidate, ...]:
    """Build one primary-GPU candidate followed by the x264 safeguard.

    Auto mode intentionally does not cascade through secondary discrete GPUs or
    integrated GPUs.  The highest-priority adapter wins; if its matching FFmpeg
    encoder is unavailable, software encoding is used immediately.
    """

    available = None if available_encoders is None else frozenset(available_encoders)
    ordered_adapters = sorted(adapters, key=_adapter_sort_key)
    result: list[EncoderCandidate] = []
    if ordered_adapters:
        adapter = ordered_adapters[0]
        codec = _VENDOR_CODEC.get(adapter.vendor)
        if codec and (available is None or codec in available):
            device_args: tuple[str, ...] = ()
            # FFmpeg NVENC exposes -gpu, but its index must be explicitly
            # mapped; never assume a DXGI list index is a CUDA/NVENC index.
            if codec == "h264_nvenc" and adapter.encoder_device_index is not None:
                device_args = ("-gpu", str(adapter.encoder_device_index))
            result.append(
                EncoderCandidate(
                    codec=codec,
                    priority=0,
                    adapter=adapter,
                    ffmpeg_device_args=device_args,
                )
            )

    if available is None or "libx264" in available:
        result.append(EncoderCandidate(codec="libx264", priority=len(result)))
    return tuple(result)


def _build_manual_hardware_candidates(
    codec: str,
    adapters: Iterable[GpuAdapter],
) -> tuple[EncoderCandidate, ...]:
    """Find devices for an explicitly requested hardware encoder."""

    matching_vendor = next(
        (vendor for vendor, vendor_codec in _VENDOR_CODEC.items() if vendor_codec == codec),
        None,
    )
    if matching_vendor is None:
        return ()

    candidates: list[EncoderCandidate] = []
    for adapter in sorted(adapters, key=_adapter_sort_key):
        if adapter.vendor != matching_vendor:
            continue
        device_args: tuple[str, ...] = ()
        if codec == "h264_nvenc" and adapter.encoder_device_index is not None:
            device_args = ("-gpu", str(adapter.encoder_device_index))
        candidates.append(
            EncoderCandidate(
                codec=codec,
                priority=len(candidates),
                adapter=adapter,
                ffmpeg_device_args=device_args,
            )
        )
    return _deduplicate_candidates(candidates)


_NVENC_GPU_LINE = re.compile(r"\[\s*GPU\s+#(\d+)\s+-\s+<\s*(.*?)\s*>\s+has\b", re.IGNORECASE)


def map_nvenc_device_indices(
    ffmpeg_bin: Path,
    adapters: Iterable[GpuAdapter],
) -> list[GpuAdapter]:
    """Map DXGI NVIDIA adapters to FFmpeg's NVENC ``-gpu`` indexes by name."""

    source = list(adapters)
    if not any(adapter.vendor == "nvidia" for adapter in source):
        return source
    command = [
        str(ffmpeg_bin),
        "-hide_banner",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=64x64",
        "-frames:v",
        "1",
        "-an",
        "-c:v",
        "h264_nvenc",
        "-gpu",
        "list",
        "-f",
        "null",
        "-",
    ]
    try:
        result = run_process_capture(command, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return source
    listed: dict[str, list[int]] = {}
    for match in _NVENC_GPU_LINE.finditer(f"{result.stdout}\n{result.stderr}"):
        listed.setdefault(_normalise_gpu_name(match.group(2)), []).append(int(match.group(1)))
    adapter_name_counts: dict[str, int] = {}
    for adapter in source:
        if adapter.vendor == "nvidia":
            key = _normalise_gpu_name(adapter.name)
            adapter_name_counts[key] = adapter_name_counts.get(key, 0) + 1
    mapped: list[GpuAdapter] = []
    for adapter in source:
        if adapter.vendor != "nvidia":
            mapped.append(adapter)
            continue
        key = _normalise_gpu_name(adapter.name)
        indexes = listed.get(key, [])
        # Name matching is safe only when it is one-to-one.  Positional pairing
        # of two identical boards would incorrectly assume DXGI and CUDA/NVENC
        # enumerate those boards in the same order.  Preserve a device index
        # already supplied by a stronger external mapper.
        device_index = adapter.encoder_device_index
        if (
            device_index is None
            and adapter_name_counts.get(key) == 1
            and len(indexes) == 1
        ):
            device_index = indexes[0]
        mapped.append(replace(adapter, encoder_device_index=device_index))
    return mapped


def probe_ffmpeg_encoder(
    ffmpeg_bin: Path,
    ffprobe_bin: Path,
    candidate: EncoderCandidate,
    spec: EncoderTargetSpec,
    *,
    timeout: float = 90,
) -> EncoderProbeResult:
    """Encode, probe and decode a representative target-specification MP4."""

    fps = max(1.0, min(1000.0, float(spec.frame_rate)))
    frame_count = max(12, min(120, int(round(fps))))
    source = (
        f"testsrc2=s={int(spec.width)}x{int(spec.height)}:"
        f"r={fps:.6f},format={spec.pixel_format or 'yuv420p'}"
    )
    encode_args = apply_encoder_device_args(
        h264_encode_cli_args(candidate.codec, "fast" if spec.tier.casefold() == "fast" else "quality"),
        candidate.ffmpeg_device_args,
    )
    # Optional target-specific flags are part of both the real probe command
    # and its cache key.  Callers should provide the same common overrides used
    # by their production command.
    encode_args.extend(str(item) for item in spec.encoder_options)
    with tempfile.TemporaryDirectory(prefix="cs2_encoder_probe_") as temp_dir:
        output = Path(temp_dir) / "probe.mp4"
        encode_command = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            source,
            "-frames:v",
            str(frame_count),
            "-an",
            *encode_args,
            "-movflags",
            "+faststart",
            str(output),
        ]
        try:
            encoded = run_process_capture(encode_command, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            return EncoderProbeResult(False, f"encode launch failed: {exc}")
        if encoded.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
            logger.warning(
                "Target encoder probe failed candidate=%s command=%s stderr=%s",
                candidate.display_name,
                command_for_log(encode_command),
                process_error_tail(encoded),
            )
            return EncoderProbeResult(False, process_error_tail(encoded))

        probe_command = [
            str(ffprobe_bin),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
            "-of",
            "json",
            str(output),
        ]
        try:
            probed = run_process_capture(probe_command, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            return EncoderProbeResult(False, f"ffprobe launch failed: {exc}")
        if probed.returncode != 0:
            return EncoderProbeResult(False, process_error_tail(probed))
        try:
            payload = json.loads(probed.stdout)
            streams = payload.get("streams") if isinstance(payload, dict) else []
            video = next(
                stream
                for stream in streams or []
                if isinstance(stream, dict) and stream.get("codec_type") == "video"
            )
            duration = float((payload.get("format") or {}).get("duration") or 0)
            valid = (
                str(video.get("codec_name") or "").casefold() == "h264"
                and int(video.get("width") or 0) == int(spec.width)
                and int(video.get("height") or 0) == int(spec.height)
                and duration > 0
            )
        except (json.JSONDecodeError, StopIteration, TypeError, ValueError):
            valid = False
        if not valid:
            return EncoderProbeResult(False, "encoded probe artifact has invalid metadata")

        decode_command = [
            str(ffmpeg_bin),
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(output),
            "-map",
            "0:v:0",
            "-f",
            "null",
            "-",
        ]
        try:
            decoded = run_process_capture(decode_command, timeout=timeout)
        except (OSError, subprocess.SubprocessError) as exc:
            return EncoderProbeResult(False, f"decode launch failed: {exc}")
        if decoded.returncode != 0:
            return EncoderProbeResult(False, process_error_tail(decoded))
    return EncoderProbeResult(True)


def build_encoder_candidates(
    requested: str,
    adapters: Iterable[GpuAdapter],
    *,
    available_encoders: Iterable[str],
    manual_software_fallback: bool = True,
) -> tuple[EncoderCandidate, ...]:
    """Build candidates for an auto or explicitly requested encoder mode."""

    mode = str(requested or "auto").strip().casefold()
    available = frozenset(available_encoders)
    adapter_list = list(adapters)
    automatic = build_auto_encoder_candidates(adapter_list, available_encoders=available)
    if mode == "auto":
        return automatic
    if mode == "libx264":
        return (
            (EncoderCandidate(codec="libx264", priority=0),)
            if "libx264" in available
            else ()
        )
    if mode not in _VENDOR_CODEC.values() or mode not in available:
        return (
            (EncoderCandidate(codec="libx264", priority=0),)
            if manual_software_fallback and "libx264" in available
            else ()
        )
    selected = list(_build_manual_hardware_candidates(mode, adapter_list))
    if not selected:
        selected.append(EncoderCandidate(codec=mode, priority=0))
    if manual_software_fallback and "libx264" in available:
        selected.append(EncoderCandidate(codec="libx264", priority=len(selected)))
    return tuple(selected)


def run_encoder_attempts(
    candidates: Iterable[EncoderCandidate],
    spec: EncoderTargetSpec,
    probe: ProbeCallback,
    runner: Callable[[EncoderCandidate], object],
    *,
    ffmpeg_identity: str,
    cache: EncoderProbeCache | None = None,
    cleanup: Callable[[], None] | None = None,
    cancellation_check: Callable[[], None] | None = None,
    on_attempt: Callable[[EncoderExportAttempt], None] | None = None,
) -> EncoderRunResult:
    """Probe and execute candidates, retrying only structured HW failures."""

    active_cache = cache if cache is not None else _target_probe_cache
    records: list[EncoderExportAttempt] = []
    last_hardware_failure: HardwareEncoderFailure | None = None

    def _notify(record: EncoderExportAttempt) -> None:
        if on_attempt is None:
            return
        try:
            on_attempt(record)
        except Exception:
            # This hook is diagnostic/progress reporting; it must not turn a
            # successful export into a failure or prevent the safety fallback.
            logger.exception("Encoder attempt observer failed")

    for candidate in _deduplicate_candidates(candidates):
        if cancellation_check is not None:
            cancellation_check()
        plan = select_first_usable_encoder(
            (candidate,),
            spec,
            probe,
            ffmpeg_identity=ffmpeg_identity,
            cache=active_cache,
        )
        # A target probe may take long enough for cancellation to arrive while
        # it is running.  Never start the full export without checking again.
        if cancellation_check is not None:
            cancellation_check()
        attempt = plan.attempts[0]
        if not attempt.result.ok:
            record = EncoderExportAttempt(
                candidate=candidate,
                status="probe_failed",
                detail=attempt.result.detail,
                stage="target_probe",
            )
            records.append(record)
            _notify(record)
            continue
        try:
            value = runner(candidate)
        except HardwareEncoderFailure as exc:
            if candidate.is_software:
                raise
            last_hardware_failure = exc
            # Do not reuse a preflight pass after the same device failed under
            # the real workload.
            active_cache.put(attempt.cache_key, EncoderProbeResult(False, str(exc)))
            record = EncoderExportAttempt(
                candidate=candidate,
                status="export_failed",
                detail=exc.stderr[-1200:],
                stage=exc.stage,
            )
            records.append(record)
            if cleanup is not None:
                cleanup()
            _notify(record)
            continue
        record = EncoderExportAttempt(candidate=candidate, status="succeeded")
        records.append(record)
        _notify(record)
        return EncoderRunResult(value=value, selected=candidate, attempts=tuple(records))

    if last_hardware_failure is not None:
        raise MontageComposerError(
            "MONTAGE_ENCODER_ALL_FAILED",
            last_encoder=last_hardware_failure.codec,
        ) from last_hardware_failure
    raise MontageComposerError("MONTAGE_ENCODER_ALL_FAILED", last_encoder="none")


def make_probe_cache_key(
    candidate: EncoderCandidate,
    spec: EncoderTargetSpec,
    *,
    ffmpeg_identity: str,
) -> str:
    """Create a cache key that changes with hardware, driver, FFmpeg or spec."""

    adapter_payload: dict[str, object] | None = None
    if candidate.adapter is not None:
        adapter_payload = {
            "stable_id": candidate.adapter.stable_id,
            "luid": candidate.adapter.luid,
            "vendor": candidate.adapter.vendor,
            "device_id": candidate.adapter.device_id,
            "driver_version": candidate.adapter.driver_version,
            "encoder_device_index": candidate.adapter.encoder_device_index,
        }
    payload = {
        "schema": 1,
        "ffmpeg_identity": ffmpeg_identity,
        "codec": candidate.codec,
        "adapter": adapter_payload,
        "ffmpeg_device_args": list(candidate.ffmpeg_device_args),
        "target": spec.cache_payload(),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _normalise_probe_result(value: bool | EncoderProbeResult) -> EncoderProbeResult:
    if isinstance(value, EncoderProbeResult):
        return value
    return EncoderProbeResult(ok=bool(value))


def select_first_usable_encoder(
    candidates: Iterable[EncoderCandidate],
    spec: EncoderTargetSpec,
    probe: ProbeCallback,
    *,
    ffmpeg_identity: str,
    cache: EncoderProbeCache | None = None,
    force_probe: bool = False,
) -> EncoderPlan:
    """Probe candidates in order and select the first one that passes.

    The callback receives the real target specification.  A probe should
    encode a short representative clip and validate/decode the resulting
    output.  Probe exceptions are treated as failed candidates so automatic
    planning can continue to x264.
    """

    ordered = _deduplicate_candidates(candidates)
    attempts: list[EncoderProbeAttempt] = []
    selected: EncoderCandidate | None = None
    for candidate in ordered:
        cache_key = make_probe_cache_key(
            candidate,
            spec,
            ffmpeg_identity=ffmpeg_identity,
        )
        cached = None if cache is None or force_probe else cache.get(cache_key)
        from_cache = cached is not None
        if cached is None:
            try:
                result = _normalise_probe_result(probe(candidate, spec))
            except Exception as exc:  # Probe implementations may wrap subprocesses.
                logger.warning("Encoder probe raised for %s: %s", candidate.display_name, exc)
                result = EncoderProbeResult(ok=False, detail=str(exc))
            if cache is not None:
                cache.put(cache_key, result)
        else:
            result = cached
        attempts.append(
            EncoderProbeAttempt(
                candidate=candidate,
                result=result,
                cache_key=cache_key,
                from_cache=from_cache,
            )
        )
        if result.ok:
            selected = candidate
            break
    return EncoderPlan(candidates=ordered, selected=selected, attempts=tuple(attempts))


def plan_auto_encoder(
    spec: EncoderTargetSpec,
    probe: ProbeCallback,
    *,
    ffmpeg_identity: str,
    adapters: Iterable[GpuAdapter] | None = None,
    available_encoders: Iterable[str] | None = None,
    cache: EncoderProbeCache | None = None,
    force_probe: bool = False,
) -> EncoderPlan:
    """Convenience entry point shared by montage and LiteCut."""

    gpu_adapters = enumerate_windows_gpus() if adapters is None else list(adapters)
    candidates = build_auto_encoder_candidates(
        gpu_adapters,
        available_encoders=available_encoders,
    )
    return select_first_usable_encoder(
        candidates,
        spec,
        probe,
        ffmpeg_identity=ffmpeg_identity,
        cache=cache,
        force_probe=force_probe,
    )


__all__ = [
    "EncoderCandidate",
    "EncoderExportAttempt",
    "EncoderPlan",
    "EncoderProbeAttempt",
    "EncoderProbeCache",
    "EncoderProbeResult",
    "EncoderRunResult",
    "EncoderTargetSpec",
    "GpuAdapter",
    "adapters_from_windows_rows",
    "build_auto_encoder_candidates",
    "build_encoder_candidates",
    "enumerate_windows_gpus",
    "map_nvenc_device_indices",
    "make_probe_cache_key",
    "parse_nvenc_driver_warning",
    "plan_auto_encoder",
    "probe_ffmpeg_encoder",
    "run_encoder_attempts",
    "select_first_usable_encoder",
]
