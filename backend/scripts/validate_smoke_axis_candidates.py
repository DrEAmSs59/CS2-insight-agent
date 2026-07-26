#!/usr/bin/env python3
"""Run the legacy seed-centroid smoke diagnostic for a demo.

This catches grossly corrupt seed coordinates, but a centroid cannot prove
orientation. The production mapping comes from the keyframe/mask protocol.

Usage::

    python backend/scripts/validate_smoke_axis_candidates.py \\
        --demo "C:\\soft\\cs2_demo_lib\\liquid-vs-vitality-m1-anubis.dem"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import native_table as pd
from app.parser.replay_effects import SMOKE_EXTRA
from app.parser.smoke_voxel_decode import (
    VOXEL_AXIS_SIGN,
    VOXEL_BYTE_PACKING,
    VOXEL_GRID_CENTER,
    decode_smoke_voxel_journal,
)
from app.parser.smoke_voxel_diagnostics import rank_axis_candidates

DEFAULT_DEMO = r"C:\soft\cs2_demo_lib\liquid-vs-vitality-m1-anubis.dem"


def _origin(value: Any) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return None
    try:
        return [float(value[0]), float(value[1]), float(value[2])]
    except (TypeError, ValueError):
        return None


def collect_snapshots(demo: str, limit: int = 40) -> list[tuple[list[float], bytes]]:
    from demoparser2 import DemoParser

    parser = DemoParser(demo)
    frame = parser.parse_grenades(extra=SMOKE_EXTRA)
    if "grenade_type" in frame.columns:
        frame = frame[frame["grenade_type"] == "CSmokeGrenadeProjectile"]
    if "m_bDidSmokeEffect" in frame.columns:
        frame = frame[frame["m_bDidSmokeEffect"].fillna(False) == True]
    snaps: list[tuple[list[float], bytes]] = []
    for _entity, sub in frame.groupby("grenade_entity_id"):
        for _, row in sub.sort_values("tick").iterrows():
            data = row.get("m_VoxelFrameData")
            origin = _origin(row.get("m_vSmokeDetonationPos"))
            declared = row.get("m_nVoxelFrameDataSize")
            if not isinstance(data, (bytes, bytearray)) or origin is None:
                continue
            try:
                size = int(declared) if declared is not None and not (
                    isinstance(declared, float) and pd.isna(declared)
                ) else len(data)
            except (TypeError, ValueError):
                size = len(data)
            for record in decode_smoke_voxel_journal(bytes(data), size):
                if len(record.payload) >= 3 and record.payload[1] == 3:
                    snaps.append((origin, bytes(record.payload)))
                    break
            if snaps and snaps[-1][0] == origin:
                break
        if len(snaps) >= limit:
            break
    return snaps


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", default=DEFAULT_DEMO)
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()
    snaps = collect_snapshots(args.demo, limit=args.limit)
    ranked = rank_axis_candidates(snaps)
    production = next((row for row in ranked if row.get("is_production")), None)
    report = {
        "demo": args.demo,
        "snapshots": len(snaps),
        "production": {
            "packing": VOXEL_BYTE_PACKING,
            "sign": list(VOXEL_AXIS_SIGN),
            "center": VOXEL_GRID_CENTER,
        },
        "top": ranked[:8],
        "production_rank": next((i for i, row in enumerate(ranked) if row.get("is_production")), None),
        "production_row": production,
    }
    print(json.dumps(report, indent=2))
    if not snaps:
        print("no snapshots", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
