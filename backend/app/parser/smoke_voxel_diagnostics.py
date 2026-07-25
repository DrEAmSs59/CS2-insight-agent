from __future__ import annotations

import hashlib
import math
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

from .smoke_voxel_decode import (
    VOXEL_AXIS_SIGN,
    VOXEL_BYTE_PACKING,
    VOXEL_CELL_SIZE_WORLD,
    VOXEL_GRID_CENTER,
    VOXEL_WORLD_SIZE,
    SmokeVoxel,
    voxel_to_world,
)


def demo_fingerprint(path: Path | str) -> dict[str, Any]:
    demo_path = Path(path)
    data = demo_path.read_bytes()
    stat = demo_path.stat()
    return {
        "path": str(demo_path),
        "size": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mtime_ns": stat.st_mtime_ns,
    }


def raw_grid_entries(voxels: Iterable[SmokeVoxel]) -> list[dict[str, Any]]:
    return [
        {"grid_x": int(v.x), "grid_y": int(v.y), "grid_z": int(v.z), "state": list(v.state[:5])}
        for v in voxels
    ]


def _mean_world(
    voxels: Sequence[SmokeVoxel],
    origin: Sequence[float],
    center: float,
    sign: Sequence[float],
) -> list[float]:
    if not voxels:
        return [float(origin[0]), float(origin[1]), float(origin[2])]
    xs, ys, zs = [], [], []
    for v in voxels:
        wx, wy, wz = voxel_to_world(v.x, v.y, v.z, origin, center=center, sign=sign)
        xs.append(wx)
        ys.append(wy)
        zs.append(wz)
    n = float(len(voxels))
    return [sum(xs) / n, sum(ys) / n, sum(zs) / n]


def compare_centers(voxels: Sequence[SmokeVoxel], origin: Sequence[float]) -> dict[str, Any]:
    out = {}
    for key, center in (("center_16", 16.0), ("center_15_5", 15.5)):
        mean = _mean_world(voxels, origin, center, VOXEL_AXIS_SIGN)
        cells = [
            list(voxel_to_world(v.x, v.y, v.z, origin, center=center, sign=VOXEL_AXIS_SIGN))
            for v in voxels
        ]
        out[key] = {
            "mean_world": mean,
            "offset_from_detonation": [mean[i] - float(origin[i]) for i in range(3)],
            "cells": cells,
            "cell_size": VOXEL_CELL_SIZE_WORLD,
        }
    return out


def state_byte_histograms(voxels: Sequence[SmokeVoxel]) -> list[dict[str, Any]]:
    result = []
    for i in range(5):
        values = [int(v.state[i]) if i < len(v.state) else 0 for v in voxels]
        freq = Counter(values)
        result.append({
            "byte_index": i,
            "min": min(values) if values else None,
            "max": max(values) if values else None,
            "freq": {str(k): int(c) for k, c in sorted(freq.items())},
        })
    return result


def build_projection_snapshot(
    voxels: Sequence[SmokeVoxel],
    origin: Sequence[float],
    *,
    tick: int | None = None,
    voxel_update: int | None = None,
) -> dict[str, Any]:
    voxels_list = list(voxels)
    return {
        "tick": tick,
        "voxel_update": voxel_update,
        "detonation_pos": [float(origin[0]), float(origin[1]), float(origin[2])],
        "raw_grid": raw_grid_entries(voxels_list),
        "centers": compare_centers(voxels_list, origin),
        "state_histograms": state_byte_histograms(voxels_list),
        "voxel_count": len(voxels_list),
    }


def parse_occupancy_grid_bytes(payload: bytes | bytearray, packing: str) -> list[tuple[int, int, int]]:
    """Return ``(x, y, z)`` grid tuples for one occupancy payload under a packing."""
    blob = bytes(payload)
    if len(blob) < 3 or (blob[1] & 1) == 0:
        return []
    count = blob[2]
    off = 3
    out: list[tuple[int, int, int]] = []
    for _ in range(count):
        if off + 8 > len(blob):
            break
        z, a, b = blob[off], blob[off + 1], blob[off + 2]
        if packing == "zxy":
            x, y = a, b
        elif packing == "zyx":
            x, y = b, a
        else:
            raise ValueError(f"unknown packing {packing}")
        out.append((int(x), int(y), int(z)))
        off += 8
    return out


def project_grid_to_world(
    grids: Sequence[tuple[int, int, int]],
    origin: Sequence[float],
    *,
    sign_x: float,
    sign_y: float,
    center: float,
) -> list[tuple[float, float, float]]:
    sign = (float(sign_x), float(sign_y), 1.0)
    return [
        voxel_to_world(x, y, z, origin, center=center, sign=sign, voxel_size=VOXEL_WORLD_SIZE)
        for x, y, z in grids
    ]


def score_axis_candidate(
    snapshots: Sequence[tuple[Sequence[float], bytes]],
    *,
    packing: str,
    sign_x: float,
    sign_y: float,
    center: float,
) -> dict[str, Any]:
    """Score one candidate by mean |centroid − detonation| in XY."""
    offsets: list[float] = []
    for origin, payload in snapshots:
        grids = parse_occupancy_grid_bytes(payload, packing)
        if len(grids) < 3:
            continue
        pts = project_grid_to_world(grids, origin, sign_x=sign_x, sign_y=sign_y, center=center)
        mx = sum(p[0] for p in pts) / len(pts)
        my = sum(p[1] for p in pts) / len(pts)
        offsets.append(math.hypot(mx - float(origin[0]), my - float(origin[1])))
    if not offsets:
        return {
            "packing": packing,
            "sign_x": sign_x,
            "sign_y": sign_y,
            "center": center,
            "n": 0,
            "mean_center_offset_world": None,
            "score": 0.0,
            "is_production": False,
        }
    mean_off = sum(offsets) / len(offsets)
    return {
        "packing": packing,
        "sign_x": sign_x,
        "sign_y": sign_y,
        "center": center,
        "n": len(offsets),
        "mean_center_offset_world": mean_off,
        "score": 1.0 / (1.0 + mean_off / 20.0),
        "is_production": (
            packing == VOXEL_BYTE_PACKING
            and float(sign_x) == float(VOXEL_AXIS_SIGN[0])
            and float(sign_y) == float(VOXEL_AXIS_SIGN[1])
            and float(center) == float(VOXEL_GRID_CENTER)
        ),
    }


def iter_axis_candidates() -> list[dict[str, Any]]:
    """All 16 planar candidates: 2 packings × 4 sign pairs × 2 centers."""
    out: list[dict[str, Any]] = []
    for packing in ("zxy", "zyx"):
        for sign_x in (1.0, -1.0):
            for sign_y in (1.0, -1.0):
                for center in (16.0, 15.5):
                    out.append({
                        "packing": packing,
                        "sign_x": sign_x,
                        "sign_y": sign_y,
                        "center": center,
                    })
    return out


def rank_axis_candidates(
    snapshots: Sequence[tuple[Sequence[float], bytes]],
) -> list[dict[str, Any]]:
    ranked = [
        score_axis_candidate(
            snapshots,
            packing=c["packing"],
            sign_x=c["sign_x"],
            sign_y=c["sign_y"],
            center=c["center"],
        )
        for c in iter_axis_candidates()
    ]
    # Prefer tighter centroid, then production packing/signs as tie-break.
    ranked.sort(key=lambda row: (
        -float(row["score"]),
        float(row["mean_center_offset_world"] or 1e9),
        0 if row.get("is_production") else 1,
    ))
    return ranked
