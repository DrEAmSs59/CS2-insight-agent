"""CS2 smoke ``m_VoxelFrameData`` journal decoder.

The journal contains an initial keyframe followed by mask deltas:

- record: ``u16le seq``, ``u16le payload_len``, payload;
- keyframe (type 3): ``phase``, ``type``, seed count, 8-byte ``[x,y,z,density,pad...]``
  seeds, then 2-byte mask count and 10-byte ``[cell_morton, voxel_mask]`` entries;
- delta (type 2): ``phase``, ``type``, 2-byte mask count, then replacement masks;
- heartbeat (type 0): no geometry change.

Both Morton levels interleave X, Y, then Z. A 32³ cell centre maps to world space as
``detonation + (grid - 15.5) * 12`` on every axis. The masks carry the actual cloud
boundary; the small seed list alone is not a renderable approximation.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

import numpy as np

VOXEL_GRID_DIM = 32
VOXEL_WORLD_SIZE = 12.0
# Grid coordinates identify cells, so 15.5 is the centre of cells 15 and 16.
VOXEL_GRID_CENTER = (VOXEL_GRID_DIM - 1) / 2.0
VOXEL_AXIS_SIGN: tuple[float, float, float] = (1.0, 1.0, 1.0)
VOXEL_CELL_SIZE_WORLD = VOXEL_WORLD_SIZE
VOXEL_BYTE_PACKING = "xyz"

# Legacy seed-only fixtures/exports have no Morton masks. Preserve their prior
# formation approximation without applying it to real mask-backed journals.
SMOKE_FORMATION_SECONDS = 1.2
SMOKE_FORMATION_STEPS = 8

_FRAME_HEARTBEAT = 0
_FRAME_DELTA = 2
_FRAME_KEYFRAME = 3
_SEED_ENTRY_SIZE = 8
_MASK_ENTRY_SIZE = 10
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


@dataclass
class SmokeVoxelGridState:
    """Mutable reconstructed smoke grid for one projectile journal."""

    seeds: dict[tuple[int, int, int], int] = field(default_factory=dict)
    masks: dict[int, int] = field(default_factory=dict)
    ready: bool = False
    phase: int = 0


class SmokeVoxelDecodeError(ValueError):
    """Raised when the journal is truncated or structurally invalid."""


def _is_heartbeat(payload: bytes) -> bool:
    return len(payload) == _HEARTBEAT_LEN and payload == b"\x00\x00\x00"


def decode_smoke_voxel_journal(
    data: bytes | bytearray,
    size: int | None = None,
    *,
    start_offset: int = 0,
) -> list[SmokeVoxelFrame]:
    """Split ``m_VoxelFrameData`` into ordered frame records."""
    raw = bytes(data)
    end = len(raw) if size is None else max(0, min(int(size), len(raw)))
    frames: list[SmokeVoxelFrame] = []
    off = max(0, min(int(start_offset), end))
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
    """Decode the keyframe seed list, or ``None`` for delta/heartbeat frames."""
    blob = bytes(payload)
    if len(blob) < 3 or blob[1] != _FRAME_KEYFRAME:
        return None
    count = blob[2]
    voxels: list[SmokeVoxel] = []
    off = 3
    for _ in range(count):
        if off + _SEED_ENTRY_SIZE > len(blob):
            break
        x, y, z = blob[off], blob[off + 1], blob[off + 2]
        state = blob[off + 3 : off + _SEED_ENTRY_SIZE]
        voxels.append(SmokeVoxel(x=x, y=y, z=z, state=state))
        off += _SEED_ENTRY_SIZE
    return voxels


def _read_u16le(blob: bytes, off: int) -> int:
    return blob[off] | (blob[off + 1] << 8)


def _read_u64le(blob: bytes, off: int) -> int:
    return int.from_bytes(blob[off : off + 8], "little")


def _decode_mask_entries(blob: bytes, off: int, count: int) -> dict[int, int] | None:
    end = off + count * _MASK_ENTRY_SIZE
    if end > len(blob):
        return None
    entries: dict[int, int] = {}
    for _ in range(count):
        cell_index = _read_u16le(blob, off)
        entries[cell_index] = _read_u64le(blob, off + 2)
        off += _MASK_ENTRY_SIZE
    return entries


def apply_smoke_voxel_frame(state: SmokeVoxelGridState, frame: SmokeVoxelFrame) -> bool:
    """Apply one keyframe/delta to ``state`` and report a geometry change."""
    blob = frame.payload
    if len(blob) < 2:
        return False
    state.phase = int(blob[0])
    frame_type = int(blob[1])

    if frame_type == _FRAME_KEYFRAME:
        if len(blob) < 3:
            return False
        count = int(blob[2])
        off = 3
        seed_end = off + count * _SEED_ENTRY_SIZE
        if seed_end + 2 > len(blob):
            return False
        seeds: dict[tuple[int, int, int], int] = {}
        for _ in range(count):
            x, y, z, density = blob[off], blob[off + 1], blob[off + 2], blob[off + 3]
            if density > 0:
                seeds[(int(x), int(y), int(z))] = int(density)
            off += _SEED_ENTRY_SIZE
        mask_count = _read_u16le(blob, off)
        masks = _decode_mask_entries(blob, off + 2, mask_count)
        if masks is None:
            return False
        state.seeds = seeds
        state.masks = masks
        state.ready = True
        return True

    if frame_type == _FRAME_DELTA:
        if not state.ready or len(blob) < 4:
            return False
        mask_count = _read_u16le(blob, 2)
        masks = _decode_mask_entries(blob, 4, mask_count)
        if masks is None:
            return False
        state.masks.update(masks)
        return bool(masks)

    return False


def _demorton3(index: int, bits: int) -> tuple[int, int, int]:
    x = y = z = 0
    for bit in range(bits):
        x |= ((index >> (3 * bit)) & 1) << bit
        y |= ((index >> (3 * bit + 1)) & 1) << bit
        z |= ((index >> (3 * bit + 2)) & 1) << bit
    return x, y, z


def _rebuild_occupied_grid(state: SmokeVoxelGridState) -> np.ndarray:
    """Build the 32³ occupancy grid, including mask-enclosed interior cells."""
    occupied = np.zeros((VOXEL_GRID_DIM, VOXEL_GRID_DIM, VOXEL_GRID_DIM), dtype=np.bool_)

    def mark(x: int, y: int, z: int) -> None:
        if 0 <= x < VOXEL_GRID_DIM and 0 <= y < VOXEL_GRID_DIM and 0 <= z < VOXEL_GRID_DIM:
            occupied[x, y, z] = True

    for x, y, z in state.seeds:
        mark(x, y, z)
    for cell_index, mask in state.masks.items():
        cell_x, cell_y, cell_z = _demorton3(cell_index, 3)
        for bit in range(64):
            if (mask >> bit) & 1:
                sub_x, sub_y, sub_z = _demorton3(bit, 2)
                mark(cell_x * 4 + sub_x, cell_y * 4 + sub_y, cell_z * 4 + sub_z)

    # Flood empty space from all six boundary faces. NumPy shifts keep each
    # expansion in native array operations, avoiding hundreds of millions of
    # Python neighbour calls when reconstructing every delta in a full match.
    empty = ~occupied
    outside = np.zeros_like(occupied)
    outside[0, :, :] = empty[0, :, :]
    outside[-1, :, :] = empty[-1, :, :]
    outside[:, 0, :] = empty[:, 0, :]
    outside[:, -1, :] = empty[:, -1, :]
    outside[:, :, 0] = empty[:, :, 0]
    outside[:, :, -1] = empty[:, :, -1]

    while True:
        expanded = outside.copy()
        expanded[1:, :, :] |= outside[:-1, :, :]
        expanded[:-1, :, :] |= outside[1:, :, :]
        expanded[:, 1:, :] |= outside[:, :-1, :]
        expanded[:, :-1, :] |= outside[:, 1:, :]
        expanded[:, :, 1:] |= outside[:, :, :-1]
        expanded[:, :, :-1] |= outside[:, :, 1:]
        expanded &= empty
        if np.array_equal(expanded, outside):
            break
        outside = expanded
    return occupied | ~outside


def project_smoke_grid_to_cells(
    state: SmokeVoxelGridState,
    origin: Sequence[float],
) -> tuple[list[list[float]], int]:
    """Project reconstructed occupancy to sparse 2D cells.

    Keep the lowest and highest occupied Z for each XY column so multi-level
    radar filtering can select the appropriate layer before contouring.
    """
    occupied = _rebuild_occupied_grid(state)
    columns: dict[tuple[int, int], tuple[int, int]] = {}
    voxel_count = 0
    for x_raw, y_raw, z_raw in np.argwhere(occupied):
        voxel_count += 1
        x, y, z = int(x_raw), int(y_raw), int(z_raw)
        previous = columns.get((x, y))
        if previous is None:
            columns[(x, y)] = (z, z)
        else:
            columns[(x, y)] = (min(previous[0], z), max(previous[1], z))

    cells: list[list[float]] = []
    for (x, y), (min_z, max_z) in sorted(columns.items()):
        wx, wy, _ = voxel_to_world(x, y, min_z, origin)
        for z in (min_z,) if min_z == max_z else (min_z, max_z):
            _, _, wz = voxel_to_world(x, y, z, origin)
            cells.append([
                round(wx * 2) / 2.0,
                round(wy * 2) / 2.0,
                round(wz * 2) / 2.0,
                1.0,
            ])
    return cells, voxel_count


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
    start_offset: int = 0,
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
        frames = decode_smoke_voxel_journal(bytes(data), size, start_offset=start_offset)
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
    start_offset: int = 0,
    state: SmokeVoxelGridState | None = None,
) -> list[dict[str, Any]]:
    """Apply every geometry frame and project its reconstructed 2D occupancy."""
    if detonation_pos is None or len(detonation_pos) < 3:
        return []
    if data is None or not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        return []
    try:
        size = int(declared_size) if declared_size is not None else len(data)
    except (TypeError, ValueError):
        size = len(data)
    if size <= 0:
        return []
    try:
        frames = decode_smoke_voxel_journal(bytes(data), size, start_offset=start_offset)
    except SmokeVoxelDecodeError:
        return []

    grid_state = state if state is not None else SmokeVoxelGridState()
    limit = float("inf") if max_seq is None else float(max_seq)
    sequence: list[dict[str, Any]] = []
    for frame in frames:
        if frame.seq > limit:
            break
        if not apply_smoke_voxel_frame(grid_state, frame):
            continue
        cells, voxel_count = project_smoke_grid_to_cells(grid_state, detonation_pos)
        sequence.append(
            {
                "seq": frame.seq,
                "cells": cells,
                "cell_size": VOXEL_CELL_SIZE_WORLD,
                "voxel_count": voxel_count,
                "phase": grid_state.phase,
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
    """Project keyframe seeds to sparse 2D cells (diagnostics/legacy fallback)."""
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
    limit = float("inf") if target_seq is None else float(target_seq)
    state = SmokeVoxelGridState()
    latest_seq: int | None = None
    for frame in frames:
        if frame.seq > limit:
            break
        if apply_smoke_voxel_frame(state, frame):
            latest_seq = frame.seq
    if latest_seq is None or not state.ready:
        return {"ok": False, "cells": [], "cell_size": VOXEL_CELL_SIZE_WORLD, "voxel_count": 0, "error": "no_occupancy"}
    cells, voxel_count = project_smoke_grid_to_cells(state, detonation_pos)
    return {
        "ok": True,
        "cells": cells,
        "cell_size": VOXEL_CELL_SIZE_WORLD,
        "voxel_count": voxel_count,
        "seq": latest_seq,
        "error": None,
    }
