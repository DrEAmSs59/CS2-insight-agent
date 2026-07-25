#!/usr/bin/env python3
"""Aggregate smoke voxel state0..4 histograms for a demo (no semantic hardcoding).

Usage::

    python backend/scripts/analyze_smoke_voxel_states.py \\
        --demo "C:\\soft\\cs2_demo_lib\\liquid-vs-vitality-m1-anubis.dem" \\
        --out ..\\data\\smoke-state-anubis.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.parser.replay_effects import SMOKE_EXTRA
from app.parser.smoke_voxel_decode import decode_smoke_voxel_journal, decode_voxel_frame_occupancy
from app.parser.smoke_voxel_diagnostics import demo_fingerprint, state_byte_histograms

DEFAULT_DEMO = r"C:\soft\cs2_demo_lib\liquid-vs-vitality-m1-anubis.dem"
DEFAULT_OUT = Path(__file__).resolve().parents[2] / "data" / "smoke-state-anubis.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", default=DEFAULT_DEMO)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--limit", type=int, default=80)
    args = parser.parse_args()

    from demoparser2 import DemoParser

    frame = DemoParser(args.demo).parse_grenades(extra=SMOKE_EXTRA)
    if "grenade_type" in frame.columns:
        frame = frame[frame["grenade_type"] == "CSmokeGrenadeProjectile"]
    if "m_bDidSmokeEffect" in frame.columns:
        frame = frame[frame["m_bDidSmokeEffect"].fillna(False) == True]

    samples: list[dict[str, Any]] = []
    global_freq = [Counter() for _ in range(5)]
    for entity_id, sub in frame.groupby("grenade_entity_id"):
        for _, row in sub.sort_values("tick").iterrows():
            data = row.get("m_VoxelFrameData")
            declared = row.get("m_nVoxelFrameDataSize")
            if not isinstance(data, (bytes, bytearray)):
                continue
            try:
                size = int(declared) if declared is not None and not (
                    isinstance(declared, float) and pd.isna(declared)
                ) else len(data)
            except (TypeError, ValueError):
                size = len(data)
            for record in decode_smoke_voxel_journal(bytes(data), size):
                voxels = decode_voxel_frame_occupancy(record.payload)
                if not voxels:
                    continue
                hist = state_byte_histograms(voxels)
                for i, entry in enumerate(hist):
                    for key, count in entry["freq"].items():
                        global_freq[i][int(key)] += int(count)
                samples.append({
                    "entity_id": int(entity_id) if str(entity_id).isdigit() else entity_id,
                    "tick": int(row["tick"]),
                    "seq": record.seq,
                    "voxel_count": len(voxels),
                    "state_histograms": hist,
                })
                break
            if len(samples) >= args.limit:
                break
        if len(samples) >= args.limit:
            break

    report = {
        "demo": demo_fingerprint(args.demo),
        "samples": samples,
        "global_state_freq": [
            {"byte_index": i, "freq": {str(k): int(v) for k, v in sorted(freq.items())}}
            for i, freq in enumerate(global_freq)
        ],
        "notes": [
            "state0..4 meanings are not asserted here; histograms only.",
            "Do not hardcode density/direction from these bytes without new evidence.",
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"wrote {args.out} samples={len(samples)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
