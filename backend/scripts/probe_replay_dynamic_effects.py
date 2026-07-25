#!/usr/bin/env python3
"""独立数据探针：验证 demoparser2 能否导出 2D 回放动态效果所需的实体数据。

探测目标（见 docs/replay-effects-validation/README.md）：

- ``CSmokeGrenadeProjectile``: ``m_nVoxelUpdate`` / ``m_nVoxelFrameDataSize`` /
  ``m_VoxelFrameData`` / ``m_vSmokeDetonationPos`` 等烟雾体素字段。
- ``CInferno``: ``m_firePositions`` / ``m_bFireIsBurning`` / ``m_fireCount`` 等火焰单元字段。

本脚本：

- 不修改任何生产 API、不写工作区缓存；
- 输出 demoparser2 版本、``DemoParser`` 方法列表、每次解析的列名 / dtype / 行数；
- 捕获全部异常（含 demoparser2 Rust panic 转换出的 ``PanicException``）并保留 traceback；
- 二进制数据只记录 SHA-256、长度和前 256 字节十六进制，不写入完整字节；
- 输出机器可读的 ``probe-summary.json`` 与人类可读的 ``probe-log.txt``。

用法示例::

    python backend/scripts/probe_replay_dynamic_effects.py \
        --demo "C:/soft/cs2_demo_lib/og-vs-spirit-m1-cache.dem" \
        --out "docs/replay-effects-validation/probe-output/run-001"

``--start-tick`` / ``--end-tick`` 可选；缺省时按烟雾 / 燃烧事件自动推导探测窗口。

注意：demoparser2 底层为 Rust，坏 demo 仍可能直接终止进程，请勿在生产
FastAPI 进程内 import 本脚本执行。
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import math
import numbers
import platform
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

import pandas as pd

# ─── 探测的字段清单（来自 CS2 实体 Schema；实际可用性以探针输出为准） ───────────

SMOKE_EXTRA_PROPS = [
    "m_nSmokeEffectTickBegin",
    "m_bDidSmokeEffect",
    "m_nRandomSeed",
    "m_vSmokeDetonationPos",
    "m_nVoxelFrameDataSize",
    "m_nVoxelUpdate",
    "m_VoxelFrameData",
    "m_bExplodeFromInferno",
]

INFERNO_PROPS = [
    "m_firePositions",
    "m_fireParentPositions",
    "m_bFireIsBurning",
    "m_fireCount",
    "m_nFireEffectTickBegin",
    "m_nFireLifetime",
    "m_bWasCreatedInSmoke",
    "m_extent",
    "m_vecOrigin",
]

UTILITY_EVENTS = [
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "inferno_extinguish",
    "molotov_detonate",
    "hegrenade_detonate",
]

FIELD_SCAN_PATTERNS = {
    "voxel": re.compile(r"voxel", re.IGNORECASE),
    "smoke": re.compile(r"smoke", re.IGNORECASE),
    "inferno_or_fire": re.compile(r"inferno|fire", re.IGNORECASE),
    "extent": re.compile(r"extent", re.IGNORECASE),
}

DEFAULT_PREFIX_BYTES = 256

# ─── 纯工具函数（backend/tests/test_probe_replay_dynamic_effects.py 覆盖） ─────


def to_bytes_or_none(value: Any) -> bytes | None:
    """尽力把 demoparser2 返回的数组值转成 bytes；不可转换时返回 None。

    保留「空数组」（返回 b""）与「缺失/不可读」（返回 None）的区别。
    """
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, float) and math.isnan(value):
        return None
    if hasattr(value, "tolist") and not isinstance(value, (str, pd.DataFrame)):
        try:
            value = value.tolist()
        except (TypeError, ValueError):
            return None
    if isinstance(value, (list, tuple)):
        out = bytearray()
        for item in value:
            if isinstance(item, bool) or not isinstance(item, numbers.Integral):
                return None
            item_int = int(item)
            if not 0 <= item_int <= 255:
                return None
            out.append(item_int)
        return bytes(out)
    return None


def summarize_binary_value(value: Any, prefix_bytes: int = DEFAULT_PREFIX_BYTES) -> dict[str, Any]:
    """把二进制值压缩成 {kind, length, sha256, prefix_hex} 摘要，避免日志爆炸。"""
    if value is None:
        return {"kind": "missing", "length": None, "sha256": None, "prefix_hex": None}
    if isinstance(value, float) and math.isnan(value):
        return {"kind": "nan", "length": None, "sha256": None, "prefix_hex": None}
    raw = to_bytes_or_none(value)
    if raw is None:
        return {
            "kind": f"unconvertible:{type(value).__name__}",
            "length": None,
            "sha256": None,
            "prefix_hex": None,
            "repr_head": repr(value)[:200],
        }
    return {
        "kind": "bytes",
        "length": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "prefix_hex": raw[: max(0, int(prefix_bytes))].hex(),
    }


def json_safe(obj: Any, prefix_bytes: int = DEFAULT_PREFIX_BYTES) -> Any:
    """递归转换为可 JSON 序列化的结构；bytes/数组统一走二进制摘要。"""
    if obj is None or isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, (bytes, bytearray, memoryview)):
        return summarize_binary_value(obj, prefix_bytes)
    if isinstance(obj, numbers.Integral):
        return int(obj)
    if isinstance(obj, numbers.Real):
        value = float(obj)
        return None if (math.isnan(value) or math.isinf(value)) else value
    if isinstance(obj, dict):
        return {str(key): json_safe(value, prefix_bytes) for key, value in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [json_safe(item, prefix_bytes) for item in obj]
    if hasattr(obj, "tolist") and not isinstance(obj, pd.DataFrame):
        try:
            return json_safe(obj.tolist(), prefix_bytes)
        except (TypeError, ValueError):
            return repr(obj)[:200]
    return repr(obj)[:200]


def describe_dataframe(frame: Any, sample_rows: int = 3) -> dict[str, Any]:
    """输出 DataFrame 的列名 / dtype / 行数与少量样本行（值经 json_safe 摘要）。"""
    if frame is None:
        return {"present": False, "reason": "result is None"}
    if not isinstance(frame, pd.DataFrame):
        if hasattr(frame, "to_pandas"):
            try:
                frame = frame.to_pandas()
            except (TypeError, ValueError) as exc:
                return {"present": False, "reason": f"to_pandas failed: {exc}"}
        else:
            return {"present": False, "reason": f"unexpected type {type(frame).__name__}"}
    info: dict[str, Any] = {
        "present": True,
        "rows": int(len(frame)),
        "columns": [str(column) for column in frame.columns],
        "dtypes": {str(column): str(dtype) for column, dtype in frame.dtypes.items()},
    }
    if len(frame) > 0 and sample_rows > 0:
        head = frame.head(sample_rows)
        info["sample_rows"] = [
            {str(column): json_safe(row[column]) for column in head.columns}
            for _, row in head.iterrows()
        ]
    return info


# ─── 探针运行支撑 ──────────────────────────────────────────────────────────────


class ProbeLog:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, text: str) -> None:
        print(text)
        self.lines.append(text)

    def dump(self, path: Path) -> None:
        path.write_text("\n".join(self.lines) + "\n", encoding="utf-8")


def capture(fn: Callable[[], Any]) -> tuple[bool, Any, dict[str, Any] | None]:
    """执行 fn，捕获包括 pyo3 PanicException 在内的 BaseException。"""
    try:
        return True, fn(), None
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as exc:  # noqa: BLE001 — Rust panic 不是 Exception 子类
        return False, None, {
            "error_type": type(exc).__name__,
            "error": str(exc)[:2000],
            "traceback": traceback.format_exc()[:8000],
        }


def _to_df(result: Any) -> pd.DataFrame:
    if isinstance(result, pd.DataFrame):
        return result
    if hasattr(result, "to_pandas"):
        return result.to_pandas()
    if isinstance(result, list):
        return pd.DataFrame(result) if result else pd.DataFrame()
    return pd.DataFrame()


def _event_tick_samples(frame: pd.DataFrame, limit: int = 60) -> list[dict[str, Any]]:
    if frame.empty or "tick" not in frame.columns:
        return []
    keep = [c for c in ("tick", "entityid", "x", "y", "z", "user_name") if c in frame.columns]
    rows = frame.sort_values("tick", kind="mergesort").head(limit)
    return [json_safe({key: row[key] for key in keep}) for _, row in rows.iterrows()]


def probe_environment(parser_cls: Any) -> dict[str, Any]:
    from importlib import metadata

    try:
        version = metadata.version("demoparser2")
    except metadata.PackageNotFoundError:
        version = "unknown"
    methods: dict[str, str] = {}
    for name in dir(parser_cls):
        if name.startswith("_"):
            continue
        try:
            methods[name] = str(inspect.signature(getattr(parser_cls, name)))
        except (TypeError, ValueError):
            methods[name] = "<signature unavailable>"
    return {
        "python": sys.version,
        "platform": platform.platform(),
        "demoparser2_version": version,
        "pandas_version": pd.__version__,
        "demo_parser_methods": methods,
    }


def probe_updated_fields(parser: Any, log: ProbeLog) -> dict[str, Any]:
    """list_updated_fields：确认 demo 数据流里到底出现过哪些实体字段。"""
    result: dict[str, Any] = {}
    list_fn = getattr(parser, "list_updated_fields", None)
    if not callable(list_fn):
        result["status"] = "api_missing"
        return result
    ok, fields, error = capture(list_fn)
    if not ok:
        result["status"] = "error"
        result["error"] = error
        return result
    names = [str(item) for item in (fields or [])]
    result["status"] = "ok"
    result["total_fields"] = len(names)
    matches: dict[str, list[str]] = {}
    for label, pattern in FIELD_SCAN_PATTERNS.items():
        matches[label] = sorted({name for name in names if pattern.search(name)})
    result["matches"] = matches
    for label, found in matches.items():
        log.write(f"  updated-fields[{label}]: {len(found)} → {found[:20]}")
    return result


def probe_events(parser: Any, log: ProbeLog) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for event in UTILITY_EVENTS:
        ok, raw, error = capture(lambda e=event: parser.parse_event(e))
        if not ok:
            out[event] = {"error": error}
            log.write(f"  event {event}: ERROR {error['error_type']}: {error['error']}")
            continue
        frame = _to_df(raw)
        info = describe_dataframe(frame, sample_rows=0)
        info["tick_samples"] = _event_tick_samples(frame)
        out[event] = info
        log.write(f"  event {event}: rows={info.get('rows')} cols={len(info.get('columns') or [])}")
    return out


def derive_probe_window(
    events: dict[str, Any],
    start_tick: int | None,
    end_tick: int | None,
    tick_rate: float,
) -> tuple[int, int, str]:
    if start_tick is not None and end_tick is not None:
        return int(start_tick), int(end_tick), "cli"
    ticks: list[int] = []
    for name in ("smokegrenade_detonate", "inferno_startburn"):
        for sample in (events.get(name) or {}).get("tick_samples") or []:
            tick = sample.get("tick")
            if isinstance(tick, (int, float)) and tick > 0:
                ticks.append(int(tick))
    if not ticks:
        return int(start_tick or 0), int(end_tick or 0), "no_utility_events"
    pad = int(tick_rate * 30)
    lo = max(0, min(ticks) - int(tick_rate * 5))
    hi = max(ticks) + pad
    if start_tick is not None:
        lo = int(start_tick)
    if end_tick is not None:
        hi = int(end_tick)
    return lo, hi, "derived_from_events"


def _sample_ticks_after(detonate_ticks: list[int], tick_rate: float, per_event: int = 6) -> list[int]:
    offsets = [int(tick_rate * s) for s in (0.25, 1, 3, 6, 10, 15)][:per_event]
    ticks: list[int] = []
    for base in detonate_ticks:
        ticks.extend(base + offset for offset in offsets)
    return sorted(set(ticks))


def probe_parse_grenades(parser: Any, log: ProbeLog) -> dict[str, Any]:
    out: dict[str, Any] = {}
    fn = getattr(parser, "parse_grenades", None)
    if not callable(fn):
        out["status"] = "api_missing"
        return out
    try:
        out["signature"] = str(inspect.signature(fn))
    except (TypeError, ValueError):
        out["signature"] = "<signature unavailable>"
    ok, raw, error = capture(fn)
    if not ok:
        out["status"] = "error"
        out["error"] = error
        return out
    frame = _to_df(raw)
    info = describe_dataframe(frame)
    out["status"] = "ok"
    out["dataframe"] = info
    if not frame.empty and "grenade_type" in frame.columns:
        out["grenade_type_counts"] = json_safe(frame["grenade_type"].value_counts().to_dict())
    log.write(f"  parse_grenades: rows={info.get('rows')} columns={info.get('columns')}")
    return out


_GRENADE_BASE_COLUMNS = {"grenade_type", "grenade_entity_id", "x", "y", "z", "tick", "steamid", "name"}


def _describe_frame_props(
    frame: pd.DataFrame,
    props: list[str],
    log: ProbeLog,
    label: str,
) -> dict[str, Any]:
    """逐属性检查是否出现在 DataFrame 列中及其值形态。"""
    out: dict[str, Any] = {
        "status": "ok",
        "rows": int(len(frame)),
        "columns": [str(column) for column in frame.columns],
        "props": {},
    }
    for prop in props:
        if prop not in frame.columns:
            out["props"][prop] = {"exported": False}
            log.write(f"  {label} prop {prop}: NOT exported (column missing)")
            continue
        column = frame[prop]
        non_null = column.dropna()
        entry: dict[str, Any] = {
            "exported": True,
            "dtype": str(column.dtype),
            "non_null_rows": int(len(non_null)),
        }
        if len(non_null) > 0:
            first = non_null.iloc[0]
            entry["python_value_type"] = type(first).__name__
            entry["array_like"] = isinstance(first, (bytes, bytearray, list, tuple)) or (
                hasattr(first, "__len__") and not isinstance(first, str)
            )
            entry["value_samples"] = [json_safe(v) for v in non_null.head(5).tolist()]
        else:
            entry["array_like"] = False
        out["props"][prop] = entry
        log.write(
            f"  {label} prop {prop}: exported dtype={entry['dtype']} "
            f"non_null={entry['non_null_rows']} type={entry.get('python_value_type')} "
            f"array_like={entry.get('array_like')}"
        )
    return out


def probe_grenade_extra_props(
    parser: Any,
    props: list[str],
    log: ProbeLog,
    label: str,
) -> tuple[dict[str, Any], pd.DataFrame | None]:
    """parse_grenades(extra=[...])：逐属性检查是否真的出现在返回列中及其值形态。"""
    fn = getattr(parser, "parse_grenades", None)
    if not callable(fn):
        return {"status": "api_missing"}, None
    ok, raw, error = capture(lambda: fn(extra=props))
    if not ok:
        log.write(f"  {label} parse_grenades(extra=...): ERROR {error['error_type']}: {error['error'][:200]}")
        return {"status": "error", "error": error}, None
    frame = _to_df(raw)
    return _describe_frame_props(frame, props, log, f"{label} extra"), frame


def probe_parse_infernos(
    parser: Any,
    props: list[str],
    log: ProbeLog,
) -> tuple[dict[str, Any], pd.DataFrame | None]:
    """parse_infernos(extra=[...])：CInferno 专用入口（lean fork cs2insight2+）。"""
    fn = getattr(parser, "parse_infernos", None)
    if not callable(fn):
        log.write("  parse_infernos: API missing")
        return {"status": "api_missing"}, None
    ok, raw, error = capture(lambda: fn(extra=props))
    if not ok:
        log.write(f"  parse_infernos(extra=...): ERROR {error['error_type']}: {error['error'][:200]}")
        return {"status": "error", "error": error}, None
    frame = _to_df(raw)
    out = _describe_frame_props(frame, props, log, "inferno parse_infernos")
    if not frame.empty and "grenade_type" in frame.columns:
        out["grenade_type_counts"] = json_safe(frame["grenade_type"].value_counts().to_dict())
    if not frame.empty and "m_fireCount" in frame.columns:
        counts = pd.to_numeric(frame["m_fireCount"], errors="coerce").dropna()
        if len(counts) > 0:
            out["fire_count_stats"] = {
                "min": float(counts.min()),
                "max": float(counts.max()),
                "mean": float(counts.mean()),
            }
            log.write(
                f"  parse_infernos fire_count: min={counts.min()} max={counts.max()} "
                f"mean={counts.mean():.2f} rows={len(frame)}"
            )
    return out, frame


def probe_props_via_parse_ticks(
    parser: Any,
    props: list[str],
    sample_ticks: list[int],
    log: ProbeLog,
    label: str,
) -> dict[str, Any]:
    """逐个属性尝试 parse_ticks，记录接受/拒绝与返回数据形状。"""
    out: dict[str, Any] = {"sample_ticks": sample_ticks[:50]}
    results: dict[str, Any] = {}
    ticks_arg = sample_ticks[:50] or None
    for prop in props:
        def _run(p: str = prop) -> Any:
            if ticks_arg:
                return parser.parse_ticks([p], ticks=ticks_arg)
            return parser.parse_ticks([p])

        ok, raw, error = capture(_run)
        if not ok:
            results[prop] = {"accepted": False, "error": error}
            log.write(f"  {label} prop {prop}: REJECTED {error['error_type']}: {error['error'][:160]}")
            continue
        frame = _to_df(raw)
        entry: dict[str, Any] = {"accepted": True, "dataframe": describe_dataframe(frame)}
        if prop in getattr(frame, "columns", []):
            column = frame[prop]
            non_null = column.dropna()
            entry["non_null_rows"] = int(len(non_null))
            if len(non_null) > 0:
                entry["value_samples"] = [json_safe(v) for v in non_null.head(5).tolist()]
        results[prop] = entry
        log.write(
            f"  {label} prop {prop}: accepted rows={entry['dataframe'].get('rows')} "
            f"non_null={entry.get('non_null_rows', 'n/a')}"
        )
    out["props"] = results
    out["accepted_props"] = [p for p, r in results.items() if r.get("accepted")]
    out["rejected_props"] = [p for p, r in results.items() if not r.get("accepted")]
    return out


def analyze_voxel_metadata(records: list[dict[str, Any]]) -> dict[str, Any]:
    """S3（元数据版）：当字节内容不可读时，用 (voxel_update, declared_size) 验证数据真实性。

    records: [{entity_id, tick, voxel_update, declared_size}, ...]。纯函数，便于测试。
    """
    by_entity: dict[Any, list[dict[str, Any]]] = {}
    for row in records:
        by_entity.setdefault(row.get("entity_id"), []).append(row)
    out: dict[str, Any] = {
        "entities": {},
        "update_transitions_with_size_change": 0,
        "update_transitions_without_size_change": 0,
    }
    for entity_id, rows in by_entity.items():
        rows.sort(key=lambda r: (r.get("tick") or 0))
        updates = [r.get("voxel_update") for r in rows if r.get("voxel_update") is not None]
        sizes = [r.get("declared_size") for r in rows if r.get("declared_size") is not None]
        for prev, cur in zip(rows, rows[1:]):
            if prev.get("voxel_update") == cur.get("voxel_update"):
                continue
            if prev.get("declared_size") != cur.get("declared_size"):
                out["update_transitions_with_size_change"] += 1
            else:
                out["update_transitions_without_size_change"] += 1
        out["entities"][str(entity_id)] = {
            "samples": len(rows),
            "update_range": [min(updates), max(updates)] if updates else None,
            "size_range": [min(sizes), max(sizes)] if sizes else None,
            "distinct_updates": len(set(updates)),
            "distinct_sizes": len(set(sizes)),
        }
    return out


def analyze_voxel_records(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """S2/S3：对 (tick, entity_id, voxel_update, declared_size, data) 记录做一致性分析。

    输入 rows 的 data 字段应已是 summarize_binary_value 输出。纯函数，便于测试。
    """
    by_entity: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        by_entity.setdefault(row.get("entity_id"), []).append(row)
    findings: dict[str, Any] = {"entities": {}, "update_change_with_hash_change": 0,
                                "update_change_without_hash_change": 0,
                                "hash_change_without_update_change": 0}
    for entity_id, entity_rows in by_entity.items():
        entity_rows.sort(key=lambda r: (r.get("tick") or 0))
        hashes = [r.get("data", {}).get("sha256") for r in entity_rows]
        updates = [r.get("voxel_update") for r in entity_rows]
        sizes_ok = []
        for row in entity_rows:
            declared = row.get("declared_size")
            actual = row.get("data", {}).get("length")
            if declared is not None and actual is not None:
                sizes_ok.append(bool(int(declared) == int(actual)))
        for prev, cur in zip(entity_rows, entity_rows[1:]):
            update_changed = prev.get("voxel_update") != cur.get("voxel_update")
            hash_changed = prev.get("data", {}).get("sha256") != cur.get("data", {}).get("sha256")
            if update_changed and hash_changed:
                findings["update_change_with_hash_change"] += 1
            elif update_changed:
                findings["update_change_without_hash_change"] += 1
            elif hash_changed:
                findings["hash_change_without_update_change"] += 1
        findings["entities"][str(entity_id)] = {
            "samples": len(entity_rows),
            "distinct_hashes": len({h for h in hashes if h}),
            "distinct_updates": len({u for u in updates if u is not None}),
            "declared_size_matches_actual": (all(sizes_ok) if sizes_ok else None),
        }
    return findings


def decide_smoke_status(field_scan: dict[str, Any], grenade_props: dict[str, Any]) -> dict[str, Any]:
    matches = (field_scan.get("matches") or {}).get("voxel") or []
    props = grenade_props.get("props") or {}

    def _readable(name: str) -> bool:
        entry = props.get(name) or {}
        return bool(entry.get("exported") and (entry.get("non_null_rows") or 0) > 0)

    voxel_entry = props.get("m_VoxelFrameData") or {}
    bytes_readable = bool(_readable("m_VoxelFrameData") and voxel_entry.get("array_like"))
    meta_readable = _readable("m_nVoxelUpdate") or _readable("m_nVoxelFrameDataSize")
    if bytes_readable:
        status = "FORMAT_RESEARCH_REQUIRED"  # 字节可读；布局仍需专门研究后才能升级为 REAL_VOXEL_READY
    elif matches:
        status = "PARSER_EXPORT_REQUIRED"
    else:
        status = "DEMO_DATA_INSUFFICIENT"
    return {
        "status": status,
        "voxel_fields_present_in_demo_stream": matches,
        "voxel_bytes_readable_via_python_api": bytes_readable,
        "voxel_metadata_readable_via_python_api": meta_readable,
    }


def decide_inferno_status(field_scan: dict[str, Any], grenade_props: dict[str, Any]) -> dict[str, Any]:
    matches = (field_scan.get("matches") or {}).get("inferno_or_fire") or []
    fire_matches = [name for name in matches if "m_fire" in name or "m_bFire" in name]
    props = grenade_props.get("props") or {}
    positions_entry = props.get("m_firePositions") or {}
    cells_readable = bool(
        positions_entry.get("exported")
        and (positions_entry.get("non_null_rows") or 0) > 0
        and positions_entry.get("array_like")
    )
    if cells_readable:
        status = "INFERNO_CELLS_READY"
    elif fire_matches:
        status = "PARSER_ENTITY_EXPORT_REQUIRED"
    else:
        status = "DEMO_DATA_INSUFFICIENT"
    return {
        "status": status,
        "inferno_fields_present_in_demo_stream": fire_matches,
        "fire_cells_readable_via_python_api": cells_readable,
    }


# ─── 主流程 ───────────────────────────────────────────────────────────────────


def run_probe(
    demo_path: Path,
    out_dir: Path,
    start_tick: int | None,
    end_tick: int | None,
    tick_rate: float,
) -> int:
    from demoparser2 import DemoParser

    log = ProbeLog()
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    summary: dict[str, Any] = {
        "demo": str(demo_path),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "cli": {"start_tick": start_tick, "end_tick": end_tick, "tick_rate": tick_rate},
    }

    log.write("=== environment ===")
    summary["environment"] = probe_environment(DemoParser)
    log.write(f"  demoparser2 {summary['environment']['demoparser2_version']}")
    log.write(f"  methods: {sorted(summary['environment']['demo_parser_methods'])}")

    parser = DemoParser(str(demo_path))

    log.write("=== parse_header ===")
    ok, header, error = capture(parser.parse_header)
    summary["header"] = json_safe(header) if ok else {"error": error}
    if ok:
        log.write(f"  {json.dumps(json_safe(header), ensure_ascii=False)[:400]}")

    log.write("=== utility events ===")
    summary["events"] = probe_events(parser, log)

    window_lo, window_hi, window_source = derive_probe_window(
        summary["events"], start_tick, end_tick, tick_rate
    )
    summary["probe_window"] = {"start_tick": window_lo, "end_tick": window_hi, "source": window_source}
    log.write(f"=== probe window: [{window_lo}, {window_hi}] ({window_source}) ===")

    log.write("=== list_updated_fields ===")
    summary["updated_fields"] = probe_updated_fields(parser, log)

    log.write("=== parse_grenades ===")
    summary["parse_grenades"] = probe_parse_grenades(parser, log)

    smoke_ticks = [
        int(sample["tick"])
        for sample in (summary["events"].get("smokegrenade_detonate") or {}).get("tick_samples") or []
        if isinstance(sample.get("tick"), (int, float))
    ][:8]
    inferno_ticks = [
        int(sample["tick"])
        for sample in (summary["events"].get("inferno_startburn") or {}).get("tick_samples") or []
        if isinstance(sample.get("tick"), (int, float))
    ][:8]

    log.write("=== smoke props via parse_grenades(extra=...) ===")
    summary["smoke_grenade_extra"], smoke_frame = probe_grenade_extra_props(
        parser, SMOKE_EXTRA_PROPS, log, "smoke"
    )

    log.write("=== inferno props via parse_grenades(extra=...) (legacy path; CInferno 通常不在此) ===")
    summary["inferno_grenade_extra"], _ = probe_grenade_extra_props(
        parser, INFERNO_PROPS, log, "inferno"
    )

    log.write("=== inferno props via parse_infernos(extra=...) ===")
    summary["inferno_parse_infernos"], _inferno_frame = probe_parse_infernos(
        parser, INFERNO_PROPS, log
    )

    # 次要路径：parse_ticks 面向玩家实体，验证其对这些属性名的实际行为（预期静默丢弃）
    log.write("=== smoke props via parse_ticks (secondary path) ===")
    summary["smoke_props_parse_ticks"] = probe_props_via_parse_ticks(
        parser, SMOKE_EXTRA_PROPS, _sample_ticks_after(smoke_ticks, tick_rate), log, "smoke"
    )
    log.write("=== inferno props via parse_ticks (secondary path) ===")
    summary["inferno_props_parse_ticks"] = probe_props_via_parse_ticks(
        parser, INFERNO_PROPS, _sample_ticks_after(inferno_ticks, tick_rate), log, "inferno"
    )

    # S3（元数据版）：用 voxel_update / declared_size 序列验证烟雾数据真实性
    if smoke_frame is not None and {"m_nVoxelUpdate", "m_nVoxelFrameDataSize"}.issubset(smoke_frame.columns):
        log.write("=== voxel metadata analysis (S3, size-based) ===")

        def _metadata_records() -> list[dict[str, Any]]:
            work = smoke_frame
            if "grenade_type" in work.columns:
                work = work.loc[work["grenade_type"] == "CSmokeGrenadeProjectile"]
            if window_hi > window_lo:
                ticks = pd.to_numeric(work["tick"], errors="coerce")
                work = work.loc[(ticks >= window_lo) & (ticks <= window_hi)]
            rows: list[dict[str, Any]] = []
            for _, row in work.iterrows():
                rows.append({
                    "entity_id": json_safe(row.get("grenade_entity_id")),
                    "tick": json_safe(row.get("tick")),
                    "voxel_update": json_safe(row.get("m_nVoxelUpdate")),
                    "declared_size": json_safe(row.get("m_nVoxelFrameDataSize")),
                })
            return rows

        ok, records, error = capture(_metadata_records)
        if ok:
            analysis = analyze_voxel_metadata(records)
            summary["voxel_metadata_analysis"] = analysis
            log.write(
                f"  entities={len(analysis['entities'])} "
                f"update_transitions_with_size_change={analysis['update_transitions_with_size_change']} "
                f"without={analysis['update_transitions_without_size_change']}"
            )
        else:
            summary["voxel_metadata_analysis_error"] = error

    # S2：仅当字节数组真实可读（array-like）时才做哈希级分析
    voxel_entry = (summary["smoke_grenade_extra"].get("props") or {}).get("m_VoxelFrameData") or {}
    if voxel_entry.get("array_like") and smoke_frame is not None and "m_VoxelFrameData" in smoke_frame.columns:
        log.write("=== voxel deep-dive (S2, hash-based) ===")

        def _collect() -> list[dict[str, Any]]:
            work = smoke_frame
            if "grenade_type" in work.columns:
                work = work.loc[work["grenade_type"] == "CSmokeGrenadeProjectile"]
            rows: list[dict[str, Any]] = []
            for _, row in work.head(5000).iterrows():
                data = row.get("m_VoxelFrameData")
                if data is None or (isinstance(data, float) and math.isnan(data)):
                    continue
                rows.append({
                    "tick": json_safe(row.get("tick")),
                    "entity_id": json_safe(row.get("grenade_entity_id")),
                    "voxel_update": json_safe(row.get("m_nVoxelUpdate")),
                    "declared_size": json_safe(row.get("m_nVoxelFrameDataSize")),
                    "data": summarize_binary_value(data),
                })
            return rows

        ok, records, error = capture(_collect)
        if ok:
            summary["voxel_records"] = records[:200]
            summary["voxel_analysis"] = analyze_voxel_records(records)
        else:
            summary["voxel_records_error"] = error

    summary["smoke_decision"] = decide_smoke_status(summary["updated_fields"], summary["smoke_grenade_extra"])
    # 优先用 parse_infernos；旧 fork 无该 API 时回退到 parse_grenades(extra=...)
    inferno_props_for_decision = summary["inferno_parse_infernos"]
    if inferno_props_for_decision.get("status") != "ok":
        inferno_props_for_decision = summary["inferno_grenade_extra"]
    summary["inferno_decision"] = decide_inferno_status(summary["updated_fields"], inferno_props_for_decision)
    log.write("=== decisions ===")
    log.write(f"  smoke:   {json.dumps(summary['smoke_decision'], ensure_ascii=False)}")
    log.write(f"  inferno: {json.dumps(summary['inferno_decision'], ensure_ascii=False)}")

    summary["duration_sec"] = round(time.perf_counter() - started, 2)
    log.write(f"=== done in {summary['duration_sec']}s ===")

    (out_dir / "probe-summary.json").write_text(
        json.dumps(json_safe(summary), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    log.dump(out_dir / "probe-log.txt")
    log.write(f"输出目录: {out_dir.resolve()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", required=True, help=".dem 文件路径")
    parser.add_argument("--start-tick", type=int, default=None, help="探测窗口起始 tick（缺省按事件推导）")
    parser.add_argument("--end-tick", type=int, default=None, help="探测窗口结束 tick（缺省按事件推导）")
    parser.add_argument("--tick-rate", type=float, default=64.0, help="demo tick rate，默认 64")
    parser.add_argument("--out", required=True, help="输出目录")
    args = parser.parse_args(argv)

    demo_path = Path(args.demo)
    if not demo_path.is_file():
        print(f"找不到 demo 文件: {demo_path}", file=sys.stderr)
        return 1
    return run_probe(demo_path, Path(args.out), args.start_tick, args.end_tick, args.tick_rate)


if __name__ == "__main__":
    raise SystemExit(main())
