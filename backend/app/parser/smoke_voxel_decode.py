"""CS2 smoke ``m_VoxelFrameData`` journal decoder.

Format (reverse-engineered from the game client / community verification):

- Buffer capacity is often 3072; valid length is ``m_nVoxelFrameDataSize``.
- Bytes are a journal of records: ``u16le seq``, ``u16le payload_len``, payload.
- Occupancy payload: ``u8 active``, ``u8 section_flags``; if bit0 set then
  ``u8 count`` + ``count`` × 8-byte entries ``[z, x, y, state0..state4]``.
- Occupancy frames fully replace the active set.
- World: ``world = sign * (grid - 16) * 20 + detonationPos`` with signs ``[+1, +1, +1]``.
  (Byte order was previously treated as ``[z, y, x]``, which rotated smoke 90° on radar —
  e.g. Nuke main-door left-side gap. ``[z, x, y]`` matches live demos.)
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

VOXEL_GRID_DIM = 32
VOXEL_WORLD_SIZE = 20.0
VOXEL_GRID_CENTER = VOXEL_GRID_DIM / 2.0
VOXEL_AXIS_SIGN: tuple[float, float, float] = (1.0, 1.0, 1.0)
VOXEL_CELL_SIZE_WORLD = VOXEL_WORLD_SIZE

# Networked occupancy is a ~44-voxel seed set; the game client expands locally.
# We approximate that expansion by revealing seeds in adjacency order (not a circle).
SMOKE_FORMATION_SECONDS = 1.2
SMOKE_FORMATION_STEPS = 8

_SECTION_OCCUPANCY = 1
_ENTRY_SIZE = 8
_HEARTBEAT_LEN = 3
_NEIGHBOR_6 = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


@dataclass(frozen=True)
class SmokeVoxel:
    x: int
    y: int
    z: int
    state: bytes


@dataclass(frozen=True)
class SmokeVoxelFrame:
    seq: int
    payload: bytes
    is_heartbeat: bool


class SmokeVoxelDecodeError(ValueError):
    """Raised when the journal is truncated or structurally invalid."""


def _is_heartbeat(payload: bytes) -> bool:
    return len(payload) == _HEARTBEAT_LEN and payload == b"\x00\x00\x00"


def decode_smoke_voxel_journal(data: bytes | bytearray, size: int | None = None) -> list[SmokeVoxelFrame]:
    """Split ``m_VoxelFrameData`` into ordered frame records."""
    raw = bytes(data)
    end = len(raw) if size is None else max(0, min(int(size), len(raw)))
    frames: list[SmokeVoxelFrame] = []
    off = 0
    while off + 4 <= end:
        seq = raw[off] | (raw[off + 1] << 8)
        length = raw[off + 2] | (raw[off + 3] << 8)
        payload_off = off + 4
        if payload_off + length > end:
            raise SmokeVoxelDecodeError(
                f"smoke voxel record at offset {off} declares payload length {length} "
                f"which overruns valid size {end}"
            )
        payload = raw[payload_off : payload_off + length]
        frames.append(SmokeVoxelFrame(seq=seq, payload=payload, is_heartbeat=_is_heartbeat(payload)))
        off = payload_off + length
    return frames


def decode_voxel_frame_occupancy(payload: bytes | bytearray) -> list[SmokeVoxel] | None:
    """Decode occupancy list from one frame payload, or None if no occupancy section."""
    blob = bytes(payload)
    if len(blob) < 2:
        return None
    section_flags = blob[1]
    if (section_flags & _SECTION_OCCUPANCY) == 0:
        return None
    if len(blob) < 3:
        return None
    count = blob[2]
    voxels: list[SmokeVoxel] = []
    off = 3
    for _ in range(count):
        if off + _ENTRY_SIZE > len(blob):
            break
        # CS2 packs seed entries as [z, x, y, state…] (not [z, y, x]).
        z, x, y = blob[off], blob[off + 1], blob[off + 2]
        state = blob[off + 3 : off + _ENTRY_SIZE]
        voxels.append(SmokeVoxel(x=x, y=y, z=z, state=state))
        off += _ENTRY_SIZE
    return voxels


def get_smoke_occupancy_at(
    frames: Sequence[SmokeVoxelFrame],
    target_seq: float = float("inf"),
) -> tuple[int, list[SmokeVoxel]] | None:
    """Latest occupancy frame with ``seq <= target_seq`` (full replace semantics)."""
    latest: tuple[int, list[SmokeVoxel]] | None = None
    for frame in frames:
        if frame.seq > target_seq:
            break
        voxels = decode_voxel_frame_occupancy(frame.payload)
        if voxels is not None:
            latest = (frame.seq, voxels)
    return latest


def iter_smoke_occupancy_frames(
    data: bytes | bytearray | None,
    *,
    declared_size: int | float | None = None,
    max_seq: float | None = None,
) -> list[tuple[int, list[SmokeVoxel]]]:
    """Return every occupancy ``(seq, voxels)`` in journal order, optionally capped by ``max_seq``."""
    if data is None or not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        return []
    try:
        size = int(declared_size) if declared_size is not None else len(data)
    except (TypeError, ValueError):
        size = len(data)
    if size <= 0:
        return []
    try:
        frames = decode_smoke_voxel_journal(bytes(data), size)
    except SmokeVoxelDecodeError:
        return []
    limit = float("inf") if max_seq is None else float(max_seq)
    out: list[tuple[int, list[SmokeVoxel]]] = []
    for frame in frames:
        if frame.seq > limit:
            break
        voxels = decode_voxel_frame_occupancy(frame.payload)
        if voxels is not None:
            out.append((frame.seq, voxels))
    return out


def decode_smoke_occupancy_sequence(
    data: bytes | bytearray | None,
    *,
    declared_size: int | float | None,
    detonation_pos: Sequence[float] | None,
    max_seq: float | None = None,
) -> list[dict[str, Any]]:
    """Project every journal occupancy frame to 2D cells (one entry per seq)."""
    if detonation_pos is None or len(detonation_pos) < 3:
        return []
    sequence: list[dict[str, Any]] = []
    for seq, voxels in iter_smoke_occupancy_frames(data, declared_size=declared_size, max_seq=max_seq):
        cells = project_voxels_to_cells(voxels, detonation_pos)
        sequence.append(
            {
                "seq": seq,
                "cells": cells,
                "cell_size": VOXEL_CELL_SIZE_WORLD,
                "voxel_count": len(voxels),
            }
        )
    return sequence


def voxel_to_world(
    x: float,
    y: float,
    z: float,
    origin: Sequence[float],
    *,
    voxel_size: float = VOXEL_WORLD_SIZE,
    center: float = VOXEL_GRID_CENTER,
    sign: Sequence[float] = VOXEL_AXIS_SIGN,
) -> tuple[float, float, float]:
    return (
        float(sign[0]) * (x - center) * voxel_size + float(origin[0]),
        float(sign[1]) * (y - center) * voxel_size + float(origin[1]),
        float(sign[2]) * (z - center) * voxel_size + float(origin[2]),
    )


def _density_from_state(state: bytes) -> float:
    if not state:
        return 1.0
    # state0 commonly 1..5 for seed voxels; treat as coarse density.
    return max(0.15, min(1.0, float(state[0]) / 5.0))


def project_voxels_to_cells(
    voxels: Iterable[SmokeVoxel],
    origin: Sequence[float],
) -> list[list[float]]:
    """Project 3D seed voxels to sparse 2D cells ``[x, y, z, density]`` (max density per XY)."""
    buckets: dict[tuple[int, int], list[float]] = {}
    for voxel in voxels:
        wx, wy, wz = voxel_to_world(voxel.x, voxel.y, voxel.z, origin)
        density = _density_from_state(voxel.state)
        key = (int(round(wx / VOXEL_CELL_SIZE_WORLD)), int(round(wy / VOXEL_CELL_SIZE_WORLD)))
        prev = buckets.get(key)
        if prev is None or density > prev[3] or (density == prev[3] and wz > prev[2]):
            buckets[key] = [
                round(wx * 2) / 2.0,
                round(wy * 2) / 2.0,
                round(wz * 2) / 2.0,
                round(density, 3),
            ]
    return list(buckets.values())


def bfs_order_seed_voxels(voxels: Sequence[SmokeVoxel]) -> list[SmokeVoxel]:
    """Order seed voxels by 6-connected BFS from the voxel nearest grid centre.

    Revealing in this order grows along the real seed topology (door gaps, diagonals)
    instead of a circular radius from the detonation point.
    """
    if not voxels:
        return []
    by_pos = {(int(v.x), int(v.y), int(v.z)): v for v in voxels}
    start = min(
        voxels,
        key=lambda v: (v.x - VOXEL_GRID_CENTER) ** 2
        + (v.y - VOXEL_GRID_CENTER) ** 2
        + (v.z - VOXEL_GRID_CENTER) ** 2,
    )
    ordered: list[SmokeVoxel] = []
    seen: set[tuple[int, int, int]] = set()

    def _consume(root: SmokeVoxel) -> None:
        key0 = (int(root.x), int(root.y), int(root.z))
        if key0 in seen:
            return
        queue: deque[SmokeVoxel] = deque([root])
        seen.add(key0)
        while queue:
            cur = queue.popleft()
            ordered.append(cur)
            cx, cy, cz = int(cur.x), int(cur.y), int(cur.z)
            for dx, dy, dz in _NEIGHBOR_6:
                key = (cx + dx, cy + dy, cz + dz)
                nxt = by_pos.get(key)
                if nxt is None or key in seen:
                    continue
                seen.add(key)
                queue.append(nxt)

    _consume(start)
    for voxel in voxels:
        _consume(voxel)
    return ordered


def synthesize_formation_from_seeds(
    voxels: Sequence[SmokeVoxel],
    origin: Sequence[float],
    *,
    begin_tick: int,
    end_tick: int,
    steps: int = SMOKE_FORMATION_STEPS,
) -> list[dict[str, Any]]:
    """Build intermediate occupancy samples that grow along seed adjacency.

    Used when demos only network a single full seed snapshot (typical CS2 behaviour).
    """
    if not voxels or end_tick <= begin_tick or steps <= 0:
        return []
    ordered = bfs_order_seed_voxels(voxels)
    if not ordered:
        return []
    out: list[dict[str, Any]] = []
    total = len(ordered)
    for step in range(1, steps + 1):
        count = max(1, int(round(total * step / steps)))
        count = min(total, count)
        tick = int(round(begin_tick + (end_tick - begin_tick) * step / steps))
        subset = ordered[:count]
        cells = project_voxels_to_cells(subset, origin)
        out.append(
            {
                "seq": step - steps - 1,
                "tick": tick,
                "cells": cells,
                "cell_size": VOXEL_CELL_SIZE_WORLD,
                "voxel_count": len(subset),
                "anchor_mode": "formation_bfs",
            }
        )
    return out


def decode_smoke_cells(
    data: bytes | bytearray | None,
    *,
    declared_size: int | float | None,
    detonation_pos: Sequence[float] | None,
    target_seq: float | None = None,
) -> dict[str, Any]:
    """High-level decode used by replay effect tracks.

    Returns ``{ok, cells, cell_size, voxel_count, seq, error?}``.
    """
    if data is None or not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": "missing_bytes"}
    if detonation_pos is None or len(detonation_pos) < 3:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": "missing_origin"}
    try:
        size = int(declared_size) if declared_size is not None else len(data)
    except (TypeError, ValueError):
        size = len(data)
    if size <= 0:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": "empty_size"}
    try:
        frames = decode_smoke_voxel_journal(bytes(data), size)
    except SmokeVoxelDecodeError as exc:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": str(exc)}
    occupancy = get_smoke_occupancy_at(frames, float("inf") if target_seq is None else float(target_seq))
    if occupancy is None:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": "no_occupancy"}
    seq, voxels = occupancy
    cells = project_voxels_to_cells(voxels, detonation_pos)
    return {
        "ok": True,
        "cells": cells,
        "cell_size": VOXEL_CELL_SIZE_WORLD,
        "voxel_count": len(voxels),
        "seq": seq,
        "error": None,
    }
