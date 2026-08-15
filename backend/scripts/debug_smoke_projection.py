#!/usr/bin/env python3
"""Smoke voxel projection diagnostics for a single demo.

Parses grenade rows with production ``SMOKE_EXTRA`` fields, decodes occupancy via
``decode_smoke_voxel_journal`` + ``get_smoke_occupancy_at``, and writes projection
snapshots (raw grid, center anchors, state histograms) as JSON.

Usage::

    python backend/scripts/debug_smoke_projection.py \\
        --demo "C:\\soft\\cs2_demo_lib\\liquid-vs-vitality-m1-anubis.dem" \\
        --out ..\\data\\smoke-diag-anubis.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import native_table as pd
from app.features.demo_analysis.replay_effects import SMOKE_EXTRA
from app.features.demo_analysis.smoke_voxel_decode import (
    SmokeVoxel,
    SmokeVoxelDecodeError,
    decode_smoke_voxel_journal,
    get_smoke_occupancy_at,
)
from app.features.demo_analysis.smoke_voxel_diagnostics import (
    build_projection_snapshot,
    demo_fingerprint,
    state_byte_histograms,
)

DEFAULT_DEMO = r"C:\soft\cs2_demo_lib\liquid-vs-vitality-m1-anubis.dem"
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "data" / "smoke-diag-anubis.json"


def _coerce_origin(value: Any) -> list[float] | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        if len(value) < 3:
            return None
        try:
            return [float(value[0]), float(value[1]), float(value[2])]
        except (TypeError, ValueError):
            return None
    try:
        if hasattr(value, "__len__") and len(value) >= 3:
            return [float(value[0]), float(value[1]), float(value[2])]
    except (TypeError, ValueError):
        return None
    return None


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        if isinstance(value, float) and math.isnan(value):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _decode_row_snapshot(
    row: pd.Series,
    *,
    entity_id: str,
) -> dict[str, Any] | None:
    data = row.get("m_VoxelFrameData")
    if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        return None
    origin = _coerce_origin(row.get("m_vSmokeDetonationPos"))
    if origin is None:
        return None
    declared = row.get("m_nVoxelFrameDataSize")
    try:
        size = int(declared) if declared is not None and not (
            isinstance(declared, float) and math.isnan(declared)
        ) else len(data)
    except (TypeError, ValueError):
        size = len(data)
    if size <= 0:
        return None
    try:
        frames = decode_smoke_voxel_journal(bytes(data), size)
    except SmokeVoxelDecodeError:
        return None
    occupancy = get_smoke_occupancy_at(frames)
    if occupancy is None:
        return None
    _seq, voxels = occupancy
    if not voxels:
        return None
    tick = _coerce_int(row.get("tick"))
    voxel_update = _coerce_int(row.get("m_nVoxelUpdate"))
    snapshot = build_projection_snapshot(
        voxels,
        origin,
        tick=tick,
        voxel_update=voxel_update,
    )
    snapshot["entity_id"] = entity_id
    return snapshot


def collect_projection_snapshots(
    demo_path: Path,
    *,
    limit_entities: int = 12,
    max_snapshots: int = 40,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    from demoparser2 import DemoParser

    parser = DemoParser(str(demo_path))
    frame = parser.parse_grenades(extra=SMOKE_EXTRA)
    if not isinstance(frame, pd.DataFrame):
        frame = pd.DataFrame(frame)
    if "grenade_type" in frame.columns:
        frame = frame.loc[frame["grenade_type"] == "CSmokeGrenadeProjectile"]

    snapshots: list[dict[str, Any]] = []
    stats = {"entities_seen": 0, "rows_scanned": 0, "rows_with_occupancy": 0}

    entity_ids = list(frame.groupby("grenade_entity_id", sort=False).groups.keys())
    stats["entities_total"] = len(entity_ids)

    for entity_id in entity_ids[:limit_entities]:
        stats["entities_seen"] += 1
        group = frame.loc[frame["grenade_entity_id"] == entity_id].sort_values("tick")
        work = group
        if "m_nVoxelUpdate" in work.columns:
            updates = pd.to_numeric(work["m_nVoxelUpdate"], errors="coerce")
            changed = updates.ne(updates.shift(1)).fillna(True)
            work = work.loc[changed]

        for _, row in work.iterrows():
            if len(snapshots) >= max_snapshots:
                return snapshots, stats
            stats["rows_scanned"] += 1
            snapshot = _decode_row_snapshot(row, entity_id=str(entity_id))
            if snapshot is None:
                continue
            stats["rows_with_occupancy"] += 1
            snapshots.append(snapshot)

    return snapshots, stats


def build_report(
    demo_path: Path,
    snapshots: list[dict[str, Any]],
    stats: dict[str, int],
    *,
    duration_sec: float,
) -> dict[str, Any]:
    all_voxels: list[SmokeVoxel] = []
    for snap in snapshots:
        for entry in snap.get("raw_grid", []):
            all_voxels.append(
                SmokeVoxel(
                    x=int(entry["grid_x"]),
                    y=int(entry["grid_y"]),
                    z=int(entry["grid_z"]),
                    state=bytes(entry.get("state") or []),
                )
            )
    return {
        "demo_fingerprint": demo_fingerprint(demo_path),
        "duration_sec": round(duration_sec, 2),
        "summary": {
            "snapshot_count": len(snapshots),
            "entities_total": stats.get("entities_total", 0),
            "entities_seen": stats.get("entities_seen", 0),
            "rows_scanned": stats.get("rows_scanned", 0),
            "rows_with_occupancy": stats.get("rows_with_occupancy", 0),
            "total_voxels_in_snapshots": sum(s.get("voxel_count", 0) for s in snapshots),
        },
        "snapshots": snapshots,
        "state_histograms": state_byte_histograms(all_voxels),
    }


def run_diagnostics(
    demo_path: Path,
    *,
    limit_entities: int = 12,
    max_snapshots: int = 40,
) -> dict[str, Any]:
    started = time.perf_counter()
    snapshots, stats = collect_projection_snapshots(
        demo_path,
        limit_entities=limit_entities,
        max_snapshots=max_snapshots,
    )
    return build_report(
        demo_path,
        snapshots,
        stats,
        duration_sec=time.perf_counter() - started,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--demo", default=DEFAULT_DEMO, help="Path to .dem file")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output JSON path")
    parser.add_argument("--limit-entities", type=int, default=12, help="Max smoke entities to scan")
    parser.add_argument("--max-snapshots", type=int, default=40, help="Max occupancy snapshots to collect")
    args = parser.parse_args(argv)

    demo = Path(args.demo)
    if not demo.is_file():
        print(f"找不到 demo: {demo}", file=sys.stderr)
        return 1

    report = run_diagnostics(
        demo,
        limit_entities=args.limit_entities,
        max_snapshots=args.max_snapshots,
    )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = report["summary"]
    print(
        f"snapshots={summary['snapshot_count']} "
        f"entities={summary['entities_seen']}/{summary['entities_total']} "
        f"occupancy_rows={summary['rows_with_occupancy']}/{summary['rows_scanned']} "
        f"duration_sec={report['duration_sec']} "
        f"out={out_path.resolve()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
