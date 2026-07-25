from __future__ import annotations

import hashlib
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

from .smoke_voxel_decode import SmokeVoxel, VOXEL_CELL_SIZE_WORLD, voxel_to_world


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


def _mean_world(voxels: Sequence[SmokeVoxel], origin: Sequence[float], center: float) -> list[float]:
    if not voxels:
        return [float(origin[0]), float(origin[1]), float(origin[2])]
    xs, ys, zs = [], [], []
    for v in voxels:
        wx, wy, wz = voxel_to_world(v.x, v.y, v.z, origin, center=center)
        xs.append(wx)
        ys.append(wy)
        zs.append(wz)
    n = float(len(voxels))
    return [sum(xs) / n, sum(ys) / n, sum(zs) / n]


def compare_centers(voxels: Sequence[SmokeVoxel], origin: Sequence[float]) -> dict[str, Any]:
    out = {}
    for key, center in (("center_16", 16.0), ("center_15_5", 15.5)):
        mean = _mean_world(voxels, origin, center)
        cells = [
            list(voxel_to_world(v.x, v.y, v.z, origin, center=center))
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
