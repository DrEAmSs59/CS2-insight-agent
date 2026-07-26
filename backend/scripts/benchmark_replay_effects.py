#!/usr/bin/env python3
"""Benchmark Rust utility scanning and production smoke/inferno track building."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
from importlib import metadata
import json
from pathlib import Path
import sys
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from demoparser2 import DemoParser

from app.parser.replay_effects import (
    INFERNO_EXTRA,
    SMOKE_EXTRA,
    _build_full_demo_tracks,
    _parse_effect_rows,
    extract_dynamic_effect_tracks,
)


class _ProcessMemoryCountersEx(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


def _memory() -> dict[str, float]:
    counters = _ProcessMemoryCountersEx()
    counters.cb = ctypes.sizeof(counters)
    get_process = ctypes.windll.kernel32.GetCurrentProcess
    get_process.restype = wintypes.HANDLE
    get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
    get_memory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    get_memory.restype = wintypes.BOOL
    ok = get_memory(
        get_process(),
        ctypes.byref(counters),
        counters.cb,
    )
    if not ok:
        return {}
    scale = 1024 * 1024
    return {
        "working_set_mib": round(counters.WorkingSetSize / scale, 2),
        "peak_working_set_mib": round(counters.PeakWorkingSetSize / scale, 2),
        "private_mib": round(counters.PrivateUsage / scale, 2),
        "peak_pagefile_mib": round(counters.PeakPagefileUsage / scale, 2),
    }


def _row_count(value: Any) -> int:
    if isinstance(value, dict):
        first = next(iter(value.values()), [])
        return len(first)
    return len(value)


def _raw_scan(parser: DemoParser) -> dict[str, Any]:
    started = time.perf_counter()
    result = parser.parse_utility_effects(extra=INFERNO_EXTRA + SMOKE_EXTRA)
    elapsed = time.perf_counter() - started
    columns = list(result) if isinstance(result, dict) else [str(name) for name in result.columns]
    return {
        "elapsed_seconds": round(elapsed, 6),
        "rows": _row_count(result),
        "columns": len(columns),
        "result_type": type(result).__name__,
    }


def _full_tracks(parser: DemoParser, tick_rate: float) -> dict[str, Any]:
    started = time.perf_counter()
    result = extract_dynamic_effect_tracks(
        parser,
        start_tick=0,
        end_tick=2_147_483_647,
        tick_rate=tick_rate,
    )
    elapsed = time.perf_counter() - started
    effects = result.get("effects") or []
    encoded = json.dumps(effects, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {
        "elapsed_seconds": round(elapsed, 6),
        "reported_parse_ms": round(float(result.get("parse_ms") or 0), 3),
        "effects": len(effects),
        "smoke_tracks": sum(effect.get("type") == "smoke" for effect in effects),
        "inferno_tracks": sum(effect.get("type") == "inferno" for effect in effects),
        "samples": sum(len(effect.get("samples") or []) for effect in effects),
        "warnings": list(result.get("warnings") or []),
        "effects_sha256": hashlib.sha256(encoded).hexdigest(),
    }


def _profile_tracks(parser: DemoParser, tick_rate: float) -> dict[str, Any]:
    parse_started = time.perf_counter()
    inferno_rows, smoke_rows, parse_warnings = _parse_effect_rows(parser)
    parse_elapsed = time.perf_counter() - parse_started
    build_started = time.perf_counter()
    effects, capabilities, build_warnings = _build_full_demo_tracks(
        inferno_rows,
        smoke_rows,
        tick_rate=tick_rate,
        end_hint=2_147_483_647,
    )
    build_elapsed = time.perf_counter() - build_started
    encoded = json.dumps(effects, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {
        "elapsed_seconds": round(parse_elapsed + build_elapsed, 6),
        "raw_and_rows_seconds": round(parse_elapsed, 6),
        "track_build_seconds": round(build_elapsed, 6),
        "inferno_rows": len(inferno_rows),
        "smoke_rows": len(smoke_rows),
        "effects": len(effects),
        "smoke_tracks": sum(effect.get("type") == "smoke" for effect in effects),
        "inferno_tracks": sum(effect.get("type") == "inferno" for effect in effects),
        "samples": sum(len(effect.get("samples") or []) for effect in effects),
        "warnings": [*parse_warnings, *build_warnings],
        "capabilities": capabilities,
        "effects_sha256": hashlib.sha256(encoded).hexdigest(),
    }


def main() -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--demo", required=True)
    cli.add_argument("--mode", choices=("raw", "full", "profile"), required=True)
    cli.add_argument("--tick-rate", type=float, default=64.0)
    args = cli.parse_args()
    demo = Path(args.demo).resolve()
    if not demo.is_file():
        raise FileNotFoundError(demo)
    parser = DemoParser(str(demo))
    if args.mode == "raw":
        payload = _raw_scan(parser)
    elif args.mode == "profile":
        payload = _profile_tracks(parser, args.tick_rate)
    else:
        payload = _full_tracks(parser, args.tick_rate)
    payload.update({
        "mode": args.mode,
        "demoparser2": metadata.version("demoparser2"),
        "demo_bytes": demo.stat().st_size,
        "memory": _memory(),
    })
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
