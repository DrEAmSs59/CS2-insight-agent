"""Sparse dynamic utility effect tracks for 2D replay (inferno cells + smoke voxels)."""

from __future__ import annotations

import logging
import math
import os
import time
from typing import Any, Sequence

from .smoke_voxel_decode import (
    SMOKE_FORMATION_SECONDS,
    VOXEL_CELL_SIZE_WORLD,
    decode_smoke_cells,
    decode_smoke_occupancy_sequence,
    iter_smoke_occupancy_frames,
    synthesize_formation_from_seeds,
)

logger = logging.getLogger(__name__)

EFFECT_TRACKS_VERSION = 1

INFERNO_EXTRA = [
    "m_firePositions",
    "m_fireParentPositions",
    "m_bFireIsBurning",
    "m_fireCount",
    "m_nFireEffectTickBegin",
    "m_nFireLifetime",
]

SMOKE_EXTRA = [
    "m_VoxelFrameData",
    "m_nVoxelFrameDataSize",
    "m_nVoxelUpdate",
    "m_vSmokeDetonationPos",
    "m_bDidSmokeEffect",
    "m_nSmokeEffectTickBegin",
]

# CS2 smoke lasts ~18s after effect begin; molotov/inferno typically ~7s.
SMOKE_EFFECT_DURATION_SEC = 18.0
INFERNO_EFFECT_DURATION_SEC = 7.0


def dynamic_utility_effects_enabled() -> bool:
    raw = os.environ.get("CS2_INSIGHT_DYNAMIC_UTILITY_EFFECTS", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _json_number(value: Any) -> int | float | None:
    if value is None:
        return None
    try:
        if hasattr(value, "item"):
            value = value.item()
    except Exception:
        pass
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    if number.is_integer():
        return int(number)
    return number


def _entity_id(value: Any) -> int | str:
    number = _json_number(value)
    if number is not None:
        return int(number)
    return str(value)


def _safe_float(value: Any) -> float | None:
    number = _json_number(value)
    if number is None:
        return None
    return float(number)


def _quantize_cell(x: float, y: float, z: float, intensity: float) -> tuple[float, float, float, float]:
    return (round(x * 2) / 2.0, round(y * 2) / 2.0, round(z * 2) / 2.0, round(float(intensity), 3))


def _cells_signature(cells: list[list[float]] | list[tuple[float, float, float, float]]) -> tuple:
    # Sort so projection order does not defeat dedupe / formation merge.
    return tuple(sorted(tuple(cell) for cell in cells))


def _map_smoke_seq_to_tick(
    seq: int,
    anchors: dict[int, int],
    begin_tick: int,
) -> tuple[int, str]:
    """Map journal seq → demo tick using row anchors; interpolate between known updates."""
    if seq in anchors:
        return int(anchors[seq]), "anchor"
    lower = max((s for s in anchors if s < seq), default=None)
    upper = min((s for s in anchors if s > seq), default=None)
    if lower is not None and upper is not None:
        t0 = float(anchors[lower])
        t1 = float(anchors[upper])
        ratio = (seq - lower) / (upper - lower)
        return int(round(t0 + (t1 - t0) * ratio)), "interpolated"
    if upper is not None:
        t1 = float(anchors[upper])
        if upper <= 0:
            return int(begin_tick), "begin"
        ratio = max(0.0, min(1.0, float(seq) / float(upper)))
        return int(round(float(begin_tick) + (t1 - float(begin_tick)) * ratio)), "pre_anchor"
    if lower is not None:
        return int(anchors[lower]), "post_anchor"
    return int(begin_tick), "begin"


def _split_entity_lifecycles(rows: list[dict[str, Any]], tick_gap: int) -> list[list[dict[str, Any]]]:
    """Split one entity_id's rows into tracks when tick gaps suggest entity reuse."""
    if not rows:
        return []
    rows = sorted(rows, key=lambda r: int(r["tick"]))
    groups: list[list[dict[str, Any]]] = [[rows[0]]]
    for row in rows[1:]:
        prev = groups[-1][-1]
        if int(row["tick"]) - int(prev["tick"]) > tick_gap:
            groups.append([row])
        else:
            groups[-1].append(row)
    return groups


def extract_inferno_cells_from_row(row: dict[str, Any]) -> list[list[float]]:
    """Build burning fire cells ``[x,y,z,intensity]`` from one CInferno row."""
    positions = row.get("m_firePositions") or []
    burning = row.get("m_bFireIsBurning")
    fire_count = row.get("m_fireCount")
    if not isinstance(positions, (list, tuple)):
        return []
    try:
        count = int(fire_count) if fire_count is not None else len(positions)
    except (TypeError, ValueError):
        count = len(positions)
    count = max(0, min(count, len(positions)))
    cells: list[list[float]] = []
    for index in range(count):
        if isinstance(burning, (list, tuple)) and index < len(burning):
            flag = burning[index]
            if flag is False or flag == 0:
                continue
        pos = positions[index]
        if not isinstance(pos, (list, tuple)) or len(pos) < 3:
            continue
        x = _safe_float(pos[0])
        y = _safe_float(pos[1])
        z = _safe_float(pos[2])
        if x is None or y is None or z is None:
            continue
        if abs(x) < 1e-6 and abs(y) < 1e-6 and abs(z) < 1e-6:
            continue
        qx, qy, qz, qi = _quantize_cell(x, y, z, 1.0)
        cells.append([qx, qy, qz, qi])
    cells.sort(key=lambda c: (c[0], c[1], c[2]))
    return cells


def build_inferno_tracks_from_rows(
    rows: list[dict[str, Any]],
    *,
    start_tick: int,
    end_tick: int,
    tick_rate: float,
) -> list[dict[str, Any]]:
    tick_gap = max(64, int(tick_rate * 3))
    by_entity: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        tick = row.get("tick")
        try:
            tick_i = int(tick)
        except (TypeError, ValueError):
            continue
        if tick_i < start_tick or tick_i > end_tick:
            continue
        entity_id = row.get("grenade_entity_id", row.get("entity_id"))
        by_entity.setdefault(entity_id, []).append({**row, "tick": tick_i})

    tracks: list[dict[str, Any]] = []
    for entity_id, entity_rows in by_entity.items():
        for group in _split_entity_lifecycles(entity_rows, tick_gap):
            samples: list[dict[str, Any]] = []
            prev_sig: tuple | None = None
            for row in group:
                cells = extract_inferno_cells_from_row(row)
                if not cells:
                    continue
                sig = _cells_signature(cells)
                if sig == prev_sig:
                    continue
                prev_sig = sig
                samples.append({"tick": int(row["tick"]), "cells": cells})
            if not samples:
                continue
            start = int(samples[0]["tick"])
            begin = _json_number(group[0].get("m_nFireEffectTickBegin"))
            if begin is not None:
                start = min(start, int(begin))
            lifetime = _json_number(group[0].get("m_nFireLifetime"))
            if lifetime is not None and float(lifetime) > 0:
                # demoparser may expose seconds (small) or ticks (large).
                life = float(lifetime)
                life_ticks = int(life * tick_rate) if life <= 120 else int(life)
            else:
                life_ticks = int(INFERNO_EFFECT_DURATION_SEC * tick_rate)
            end = min(int(end_tick), max(int(samples[-1]["tick"]), start + life_ticks))
            tracks.append({
                "id": f"inferno:0:{start}:{_entity_id(entity_id)}",
                "type": "inferno",
                "entity_id": _entity_id(entity_id),
                "start_tick": start,
                "end_tick": end,
                "source": "cinferno_cells",
                "samples": samples,
            })
    tracks.sort(key=lambda t: (t["start_tick"], str(t["entity_id"])))
    return tracks


def build_smoke_tracks_from_rows(
    rows: list[dict[str, Any]],
    *,
    start_tick: int,
    end_tick: int,
    tick_rate: float,
) -> tuple[list[dict[str, Any]], list[str]]:
    tick_gap = max(64, int(tick_rate * 5))
    warnings: list[str] = []
    by_entity: dict[Any, list[dict[str, Any]]] = {}
    for row in rows:
        tick = row.get("tick")
        try:
            tick_i = int(tick)
        except (TypeError, ValueError):
            continue
        if tick_i < start_tick or tick_i > end_tick:
            continue
        grenade_type = str(row.get("grenade_type") or "")
        # Fail closed: never treat molotov/HE/flash rows as smoke tracks.
        if grenade_type and grenade_type != "CSmokeGrenadeProjectile":
            if "smoke" not in grenade_type.lower():
                continue
        elif not grenade_type:
            continue
        entity_id = row.get("grenade_entity_id", row.get("entity_id"))
        by_entity.setdefault(entity_id, []).append({**row, "tick": tick_i})

    tracks: list[dict[str, Any]] = []
    for entity_id, entity_rows in by_entity.items():
        for group in _split_entity_lifecycles(entity_rows, tick_gap):
            begin_raw = _json_number(group[0].get("m_nSmokeEffectTickBegin"))
            first_row_tick = int(group[0]["tick"])
            last_row_tick = int(group[-1]["tick"])
            if begin_raw is not None:
                begin_tick = int(begin_raw)
                # demoparser occasionally yields a stale begin far outside this
                # lifecycle window; fall back to the first observed row tick.
                if begin_tick > last_row_tick or begin_tick < first_row_tick - int(max(64, tick_rate) * 2):
                    begin_tick = first_row_tick
            else:
                begin_tick = first_row_tick

            anchors: dict[int, int] = {}
            for row in group:
                update = row.get("m_nVoxelUpdate")
                try:
                    update_i = int(update) if update is not None else None
                except (TypeError, ValueError):
                    update_i = None
                if update_i is not None:
                    anchors[update_i] = int(row["tick"])

            samples: list[dict[str, Any]] = []
            seen_seqs: set[int] = set()
            prev_update: Any = object()
            prev_sig: tuple | None = None
            cell_size = VOXEL_CELL_SIZE_WORLD

            for row in group:
                update = row.get("m_nVoxelUpdate")
                try:
                    update_i = int(update) if update is not None else None
                except (TypeError, ValueError):
                    update_i = None
                # Same voxel update ⇒ identical journal occupancy; skip expensive decode.
                if update_i is not None and update_i == prev_update:
                    continue

                data = row.get("m_VoxelFrameData")
                declared = row.get("m_nVoxelFrameDataSize")
                origin = row.get("m_vSmokeDetonationPos")
                if not isinstance(data, (bytes, bytearray)) or not isinstance(origin, (list, tuple)):
                    continue

                actual_size = len(data)
                try:
                    declared_i = int(declared) if declared is not None else actual_size
                except (TypeError, ValueError):
                    declared_i = actual_size

                sequence = decode_smoke_occupancy_sequence(
                    data,
                    declared_size=declared_i,
                    detonation_pos=origin,
                    max_seq=float(update_i) if update_i is not None else None,
                )
                if not sequence:
                    # Fallback: single snapshot decode with target_seq when journal expand yields nothing.
                    decoded = decode_smoke_cells(
                        data,
                        declared_size=declared_i,
                        detonation_pos=origin,
                        target_seq=float(update_i) if update_i is not None else None,
                    )
                    if not decoded.get("ok") or not decoded.get("cells"):
                        prev_update = update_i
                        continue
                    sequence = [
                        {
                            "seq": int(decoded.get("seq") or update_i or 0),
                            "cells": decoded["cells"],
                            "cell_size": float(decoded.get("cell_size") or VOXEL_CELL_SIZE_WORLD),
                            "voxel_count": int(decoded.get("voxel_count") or 0),
                        }
                    ]

                for idx, item in enumerate(sequence):
                    seq = int(item["seq"])
                    if update_i is not None and seq > update_i:
                        warnings.append(
                            f"smoke entity {entity_id} tick {row['tick']}: decoded_seq {seq} > m_nVoxelUpdate {update_i}"
                        )
                        continue
                    cells = item["cells"]
                    if not cells:
                        continue
                    cell_size = float(item.get("cell_size") or VOXEL_CELL_SIZE_WORLD)
                    sig = _cells_signature(cells)

                    # Cumulative journals: each seq once. Real demos often keep a single
                    # occupancy frame at seq=0 while m_nVoxelUpdate advances — re-emit only
                    # the tip occupancy when its signature actually changes.
                    is_new_seq = seq not in seen_seqs
                    if not is_new_seq:
                        is_tip = idx == len(sequence) - 1
                        if not is_tip or sig == prev_sig:
                            continue
                        mapped_tick, anchor_mode = int(row["tick"]), "row"
                    else:
                        if sig == prev_sig:
                            seen_seqs.add(seq)
                            continue
                        mapped_tick, anchor_mode = _map_smoke_seq_to_tick(seq, anchors, begin_tick)

                    logger.debug(
                        "smoke decode entity=%s row_tick=%s voxel_update=%s decoded_seq=%s "
                        "cell_count=%s declared_size=%s actual_data_size=%s mapped_tick=%s anchor_mode=%s",
                        entity_id,
                        row["tick"],
                        update_i,
                        seq,
                        len(cells),
                        declared_i,
                        actual_size,
                        mapped_tick,
                        anchor_mode,
                    )
                    seen_seqs.add(seq)
                    prev_sig = sig
                    sample: dict[str, Any] = {
                        "tick": int(mapped_tick),
                        "seq": seq,
                        "cells": cells,
                        "cell_size": cell_size,
                        "anchor_mode": anchor_mode,
                    }
                    if update_i is not None:
                        sample["voxel_update"] = update_i
                    samples.append(sample)

                prev_update = update_i

            if not samples:
                continue

            # CS2 typically networks one full seed occupancy (~44 voxels). The client
            # expands locally; approximate that with adjacency BFS formation samples
            # so 2D replay does not pop open at the first snapshot.
            first_voxels = None
            first_origin: Sequence[float] | None = None
            for row in group:
                data = row.get("m_VoxelFrameData")
                declared = row.get("m_nVoxelFrameDataSize")
                origin = row.get("m_vSmokeDetonationPos")
                if not isinstance(data, (bytes, bytearray)) or not isinstance(origin, (list, tuple)):
                    continue
                try:
                    declared_i = int(declared) if declared is not None else len(data)
                except (TypeError, ValueError):
                    declared_i = len(data)
                occ_frames = iter_smoke_occupancy_frames(data, declared_size=declared_i)
                if occ_frames:
                    first_voxels = occ_frames[0][1]
                    first_origin = origin
                    break

            if first_voxels and first_origin is not None:
                cell_counts = {len(sample["cells"]) for sample in samples}
                # Skip when the journal already supplied a growing occupancy sequence.
                if len(samples) >= 2 and len(cell_counts) >= 2:
                    first_voxels = None
            if first_voxels and first_origin is not None:
                formation_end = begin_tick + int(SMOKE_FORMATION_SECONDS * float(tick_rate))
                first_sample_tick = int(samples[0]["tick"])
                if begin_tick < first_sample_tick <= formation_end:
                    formation_end = first_sample_tick
                if formation_end > begin_tick:
                    formation = synthesize_formation_from_seeds(
                        first_voxels,
                        first_origin,
                        begin_tick=begin_tick,
                        end_tick=formation_end,
                    )
                    if formation:
                        final_sig = _cells_signature(formation[-1]["cells"])
                        kept: list[dict[str, Any]] = []
                        for sample in samples:
                            if (
                                _cells_signature(sample["cells"]) == final_sig
                                and int(sample["tick"]) <= formation_end
                            ):
                                continue
                            kept.append(sample)
                        samples = formation + kept

            samples.sort(key=lambda s: (int(s["tick"]), int(s["seq"])))
            # Collapse identical consecutive signatures after merge.
            deduped: list[dict[str, Any]] = []
            last_sig: tuple | None = None
            for sample in samples:
                sig = _cells_signature(sample["cells"])
                if sig == last_sig:
                    continue
                last_sig = sig
                deduped.append(sample)
            samples = deduped
            if not samples:
                continue

            start = int(samples[0]["tick"])
            start = min(start, begin_tick)
            end = min(
                int(end_tick),
                max(int(samples[-1]["tick"]), start + int(SMOKE_EFFECT_DURATION_SEC * tick_rate)),
            )
            tracks.append({
                "id": f"smoke:0:{start}:{_entity_id(entity_id)}",
                "type": "smoke",
                "entity_id": _entity_id(entity_id),
                "start_tick": start,
                "end_tick": end,
                "source": "smoke_voxels",
                "cell_size": cell_size,
                "samples": samples,
            })
    tracks.sort(key=lambda t: (t["start_tick"], str(t["entity_id"])))
    return tracks, warnings


def _dataframe_to_rows(frame: Any) -> list[dict[str, Any]]:
    if frame is None:
        return []
    try:
        return frame.to_dict(orient="records")
    except Exception:
        return []


def _filter_smoke_frame(frame: Any) -> Any:
    """Keep only smoke projectile rows before materializing Python dicts."""
    if frame is None or not hasattr(frame, "columns"):
        return frame
    try:
        work = frame
        if "grenade_type" in work.columns:
            work = work[work["grenade_type"] == "CSmokeGrenadeProjectile"]
        if "m_bDidSmokeEffect" in work.columns:
            work = work[work["m_bDidSmokeEffect"].fillna(False) == True]
        return work
    except Exception:
        return frame


def _max_tick_in_rows(rows: list[dict[str, Any]], fallback: int) -> int:
    max_tick = int(fallback)
    for row in rows:
        try:
            max_tick = max(max_tick, int(row.get("tick")))
        except (TypeError, ValueError):
            continue
    return max_tick


def _parse_effect_rows(parser: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    inferno_rows: list[dict[str, Any]] = []
    smoke_rows: list[dict[str, Any]] = []

    try:
        if hasattr(parser, "parse_infernos"):
            inferno_frame = parser.parse_infernos(extra=INFERNO_EXTRA)
            inferno_rows = _dataframe_to_rows(inferno_frame)
        else:
            warnings.append("parse_infernos API missing")
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"inferno extract failed: {type(exc).__name__}: {exc}")
        logger.warning("replay_effects inferno failed: %s", exc)

    try:
        smoke_frame = parser.parse_grenades(extra=SMOKE_EXTRA)
        smoke_frame = _filter_smoke_frame(smoke_frame)
        smoke_rows = _dataframe_to_rows(smoke_frame)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"smoke extract failed: {type(exc).__name__}: {exc}")
        logger.warning("replay_effects smoke failed: %s", exc)

    return inferno_rows, smoke_rows, warnings


def _build_full_demo_tracks(
    inferno_rows: list[dict[str, Any]],
    smoke_rows: list[dict[str, Any]],
    *,
    tick_rate: float,
    end_hint: int,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    warnings: list[str] = []
    end_tick = max(
        1,
        _max_tick_in_rows(inferno_rows, end_hint),
        _max_tick_in_rows(smoke_rows, end_hint),
        int(end_hint),
    )
    effects: list[dict[str, Any]] = []
    capabilities = {
        "inferno_cells": False,
        "smoke_voxels": False,
        "smoke_mode": "legacy_circle",
    }
    try:
        inferno_tracks = build_inferno_tracks_from_rows(
            inferno_rows, start_tick=0, end_tick=end_tick, tick_rate=tick_rate
        )
        effects.extend(inferno_tracks)
        capabilities["inferno_cells"] = bool(inferno_tracks)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"inferno track build failed: {type(exc).__name__}: {exc}")
        logger.warning("replay_effects inferno track build failed: %s", exc)

    try:
        smoke_tracks, smoke_warnings = build_smoke_tracks_from_rows(
            smoke_rows, start_tick=0, end_tick=end_tick, tick_rate=tick_rate
        )
        warnings.extend(smoke_warnings)
        effects.extend(smoke_tracks)
        if smoke_tracks:
            capabilities["smoke_voxels"] = True
            capabilities["smoke_mode"] = "voxel_cells"
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"smoke track build failed: {type(exc).__name__}: {exc}")
        logger.warning("replay_effects smoke track build failed: %s", exc)

    effects.sort(key=lambda t: (int(t.get("start_tick") or 0), str(t.get("type")), str(t.get("entity_id"))))
    return effects, capabilities, warnings


def extract_dynamic_effect_tracks(
    parser: Any,
    *,
    start_tick: int,
    end_tick: int,
    tick_rate: float,
    map_name: str | None = None,
    demo_path: str | None = None,
) -> dict[str, Any]:
    """Extract sparse inferno/smoke effect tracks for a replay tick window."""
    del map_name  # reserved for future map-specific calibration
    started = time.perf_counter()
    capabilities = {
        "inferno_cells": False,
        "smoke_voxels": False,
        "smoke_mode": "legacy_circle",
    }
    if not dynamic_utility_effects_enabled():
        return {
            "version": EFFECT_TRACKS_VERSION,
            "capabilities": capabilities,
            "effects": [],
            "warnings": ["dynamic utility effects disabled by CS2_INSIGHT_DYNAMIC_UTILITY_EFFECTS"],
            "parse_ms": 0.0,
            "cache_hit": False,
        }

    path = demo_path or getattr(parser, "path", None) or getattr(parser, "demo_path", None)
    if path is not None:
        path = str(path)

    warnings: list[str] = []
    cache_hit = False
    full_tracks: list[dict[str, Any]] = []

    if path:
        try:
            from .replay_effects_cache import filter_tracks_for_window, load_tracks

            cached = load_tracks(path)
            if cached is not None:
                full_tracks = list(cached.get("tracks") or [])
                capabilities = cached.get("capabilities") or capabilities
                warnings.extend(list(cached.get("warnings") or []))
                cache_hit = True
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"effects cache load failed: {type(exc).__name__}: {exc}")

    if not cache_hit:
        inferno_rows, smoke_rows, parse_warnings = _parse_effect_rows(parser)
        warnings.extend(parse_warnings)
        full_tracks, capabilities, build_warnings = _build_full_demo_tracks(
            inferno_rows,
            smoke_rows,
            tick_rate=tick_rate,
            end_hint=max(int(end_tick), 1),
        )
        warnings.extend(build_warnings)
        if path and full_tracks:
            try:
                from .replay_effects_cache import save_tracks

                save_tracks(
                    path,
                    tracks=full_tracks,
                    capabilities=capabilities,
                    warnings=warnings,
                )
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"effects cache save failed: {type(exc).__name__}: {exc}")

    if path:
        from .replay_effects_cache import filter_tracks_for_window

        effects = filter_tracks_for_window(
            full_tracks, start_tick=int(start_tick), end_tick=int(end_tick)
        )
    else:
        effects = [
            track
            for track in full_tracks
            if int(track.get("end_tick") or 0) >= int(start_tick)
            and int(track.get("start_tick") or 0) <= int(end_tick)
        ]

    # Window-local capability flags for the frontend.
    capabilities = {
        **capabilities,
        "inferno_cells": any(t.get("type") == "inferno" for t in effects),
        "smoke_voxels": any(t.get("type") == "smoke" for t in effects),
        "smoke_mode": (
            "voxel_cells"
            if any(t.get("type") == "smoke" for t in effects)
            else capabilities.get("smoke_mode") or "legacy_circle"
        ),
    }

    parse_ms = round((time.perf_counter() - started) * 1000.0, 2)
    inferno_n = sum(1 for e in effects if e.get("type") == "inferno")
    smoke_n = sum(1 for e in effects if e.get("type") == "smoke")
    logger.info(
        "replay_effects parse_ms=%.2f cache_hit=%s inferno_tracks=%s smoke_tracks=%s warnings=%s",
        parse_ms,
        cache_hit,
        inferno_n,
        smoke_n,
        len(warnings),
    )
    return {
        "version": EFFECT_TRACKS_VERSION,
        "capabilities": capabilities,
        "effects": effects,
        "warnings": warnings,
        "parse_ms": parse_ms,
        "cache_hit": cache_hit,
    }
