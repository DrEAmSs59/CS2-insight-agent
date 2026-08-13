"""Whole-match 2D replay cache backed by Rust-native Parquet I/O."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from ... import native_table as pd
from ...demoparser_runtime import REQUIRED_DEMOPARSER_VERSION
from .replay_cache_storage import (
    replay_cache_namespace_root,
    replay_cache_namespace_roots,
)
from .replay_cache_owners import invalidate_owner_index, register_replay_cache_entry
from .cs2_item_catalog import (
    build_player_skin_loadouts,
    resolve_weapon_model,
    skin_for_player_weapon,
)

logger = logging.getLogger(__name__)

REPLAY_MATCH_CACHE_VERSION = 6
REPLAY_MATCH_FPS = 32.0

_RAW_PLAYER_FIELDS = (
    "X",
    "Y",
    "Z",
    "yaw",
    "name",
    "steamid",
    "team_num",
    "is_alive",
    "health",
    "armor",
    "has_helmet",
    "balance",
    "current_equip_value",
    "inventory",
    "active_weapon",
    "active_weapon_name",
    "has_defuser",
    "has_c4",
    "flash_duration",
    "player_color",
)
_UTILITY_WEAPON_TOKENS = (
    "knife",
    "bayonet",
    "smoke",
    "flash",
    "hegrenade",
    "molotov",
    "incendiary",
    "incgrenade",
    "decoy",
    "taser",
    "c4",
    "defuser",
    "healthshot",
)
_COLOR_SLOTS = {
    "blue": 0,
    "green": 1,
    "yellow": 2,
    "orange": 3,
    "purple": 4,
}


def _cache_root() -> Path:
    return replay_cache_namespace_root("matches")


def _cache_roots() -> tuple[Path, ...]:
    primary = _cache_root()
    roots = [primary]
    for candidate in replay_cache_namespace_roots("matches", create_primary=False):
        if candidate not in roots:
            roots.append(candidate)
    return tuple(roots)


def _demo_fingerprint(demo_path: str) -> dict[str, Any] | None:
    try:
        path = Path(demo_path).resolve()
        stat = path.stat()
    except OSError:
        return None
    return {
        "path": str(path),
        "size": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
    }


def replay_match_cache_key(
    demo_path: str,
    *,
    fps: float = REPLAY_MATCH_FPS,
    tick_rate: float = 64.0,
) -> str | None:
    fingerprint = _demo_fingerprint(demo_path)
    if not fingerprint:
        return None
    raw = (
        f"{REPLAY_MATCH_CACHE_VERSION}|{REQUIRED_DEMOPARSER_VERSION}|"
        f"{fingerprint['path']}|{fingerprint['size']}|"
        f"{fingerprint['mtime_ns']}|{float(fps):.6f}|{float(tick_rate):.6f}"
    )
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:40]


def _cache_paths(cache_key: str) -> tuple[Path, Path]:
    root = _cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{cache_key}.parquet", root / f"{cache_key}.meta.json"


def _cache_path_candidates(cache_key: str) -> tuple[tuple[Path, Path], ...]:
    return tuple(
        (root / f"{cache_key}.parquet", root / f"{cache_key}.meta.json")
        for root in _cache_roots()
    )


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _clean_rounds(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    rounds: list[dict[str, Any]] = []
    for raw in workspace.get("rounds") or []:
        if not isinstance(raw, dict):
            continue
        round_number = _int(raw.get("round_number"))
        start_tick = _int(raw.get("freeze_end_tick") or raw.get("start_tick"))
        end_tick = _int(raw.get("record_end_tick") or raw.get("end_tick") or raw.get("round_end_tick"))
        if round_number <= 0 or start_tick < 0 or end_tick <= start_tick:
            continue
        rounds.append(
            {
                "round_number": round_number,
                "start_tick": start_tick,
                "end_tick": end_tick,
                "team_a_side": str(raw.get("team_a_side") or "").upper(),
                "team_b_side": str(raw.get("team_b_side") or "").upper(),
                "shots": [dict(item) for item in raw.get("shots") or [] if isinstance(item, dict)],
                "events": [dict(item) for item in raw.get("events") or [] if isinstance(item, dict)],
            }
        )
    rounds.sort(key=lambda item: (item["round_number"], item["start_tick"]))
    if rounds:
        # Repair persisted workspaces created before final-round result tails
        # were stored. This keeps cached Demo-library entries compatible.
        final = rounds[-1]
        source = next(
            (
                raw for raw in workspace.get("rounds") or []
                if isinstance(raw, dict) and _int(raw.get("round_number")) == final["round_number"]
            ),
            {},
        )
        raw_end = _int(source.get("round_end_tick") or source.get("end_tick"))
        tick_rate = max(0.001, float(workspace.get("tick_rate") or 64.0))
        desired_end = raw_end + max(1, int(round(tick_rate * 3.0)))
        demo_end_tick = _int(workspace.get("demo_end_tick"))
        if demo_end_tick > raw_end:
            desired_end = min(desired_end, demo_end_tick)
            final["end_tick"] = max(final["end_tick"], desired_end)
    return rounds


def _round_boundaries(rounds: list[dict[str, Any]]) -> list[tuple[int, int, int]]:
    """Return the cache-shaping round identity for stale metadata checks."""
    return [
        (
            _int(round_row.get("round_number")),
            _int(round_row.get("start_tick")),
            _int(round_row.get("end_tick")),
        )
        for round_row in rounds
        if isinstance(round_row, dict)
    ]


def _sample_ticks(start_tick: int, end_tick: int, tick_rate: float, fps: float) -> list[int]:
    duration_sec = max(0.01, (int(end_tick) - int(start_tick)) / max(float(tick_rate), 0.001))
    frame_count = max(1, int(round(duration_sec * max(float(fps), 0.01))))
    span = max(1, int(end_tick) - int(start_tick))
    if frame_count <= 1:
        return [int(start_tick)]
    return [
        max(
            int(start_tick),
            min(
                int(start_tick) + int(round((index / (frame_count - 1)) * (span - 1))),
                int(end_tick) - 1,
            ),
        )
        for index in range(frame_count)
    ]


def _player_team_key_by_name(workspace: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for player in workspace.get("players") or []:
        if not isinstance(player, dict):
            continue
        name = str(player.get("name") or "").strip().lower()
        team_key = str(player.get("team_key") or "").strip().lower()
        if name and team_key in {"a", "b"}:
            out[name] = team_key
    return out


def _effect_centroid(track: dict[str, Any]) -> tuple[float, float] | None:
    for sample in track.get("samples") or []:
        cells = sample.get("cells") if isinstance(sample, dict) else None
        if not cells:
            continue
        points = [
            (float(cell[0]), float(cell[1]))
            for cell in cells
            if isinstance(cell, (list, tuple))
            and len(cell) >= 2
            and math.isfinite(float(cell[0]))
            and math.isfinite(float(cell[1]))
        ]
        if points:
            return (
                sum(point[0] for point in points) / len(points),
                sum(point[1] for point in points) / len(points),
            )
    return None


def _annotate_effect_sides(
    effects: list[dict[str, Any]],
    rounds: list[dict[str, Any]],
    workspace: dict[str, Any],
    *,
    tick_rate: float,
) -> list[dict[str, Any]]:
    team_key_by_name = _player_team_key_by_name(workspace)
    candidates: list[dict[str, Any]] = []
    for round_row in rounds:
        for event in round_row.get("events") or []:
            if str(event.get("type") or "") != "grenade":
                continue
            kind = str(event.get("kind") or "").lower()
            effect_type = "smoke" if ("烟" in kind or "smoke" in kind) else (
                "inferno"
                if any(token in kind for token in ("燃", "火", "inferno", "molotov", "incendiary"))
                else ""
            )
            if not effect_type:
                continue
            actor = str(event.get("actor") or "").strip()
            team_key = team_key_by_name.get(actor.lower(), "")
            side = (
                round_row.get("team_a_side")
                if team_key == "a"
                else round_row.get("team_b_side")
                if team_key == "b"
                else ""
            )
            candidates.append(
                {
                    "effect_type": effect_type,
                    "tick": _int(event.get("tick")),
                    "actor": actor,
                    "team_key": team_key,
                    "side": side if side in {"T", "CT"} else "",
                    "x": event.get("x"),
                    "y": event.get("y"),
                    "used": False,
                }
            )

    max_tick_delta = max(64, int(float(tick_rate) * 3))
    annotated: list[dict[str, Any]] = []
    for original in effects:
        track = dict(original)
        start_tick = _int(track.get("start_tick"))
        owner = str(track.get("thrower_name") or track.get("name") or "").strip()
        owner_team_key = team_key_by_name.get(owner.lower(), "")
        round_row = next(
            (row for row in rounds if row["start_tick"] <= start_tick <= row["end_tick"]),
            None,
        )
        if owner_team_key and round_row:
            owner_side = (
                round_row.get("team_a_side")
                if owner_team_key == "a"
                else round_row.get("team_b_side")
            )
            if owner_side in {"T", "CT"}:
                track["thrower_name"] = owner
                track["team_key"] = owner_team_key
                track["side"] = owner_side
                annotated.append(track)
                continue

        centroid = _effect_centroid(track)
        best: tuple[float, dict[str, Any]] | None = None
        for candidate in candidates:
            if candidate["used"] or candidate["effect_type"] != track.get("type"):
                continue
            tick_delta = abs(candidate["tick"] - start_tick)
            if tick_delta > max_tick_delta:
                continue
            score = float(tick_delta)
            try:
                if centroid is not None and candidate["x"] is not None and candidate["y"] is not None:
                    dx = float(candidate["x"]) - centroid[0]
                    dy = float(candidate["y"]) - centroid[1]
                    score += math.hypot(dx, dy) / 64.0
            except (TypeError, ValueError):
                pass
            if best is None or score < best[0]:
                best = (score, candidate)
        if best is not None:
            candidate = best[1]
            candidate["used"] = True
            if candidate["actor"]:
                track["thrower_name"] = candidate["actor"]
            if candidate["team_key"]:
                track["team_key"] = candidate["team_key"]
            if candidate["side"]:
                track["side"] = candidate["side"]
        annotated.append(track)
    return annotated


def _missing(value: Any) -> bool:
    return value is None or (isinstance(value, float) and math.isnan(value))


def _safe_text(value: Any) -> str:
    if _missing(value):
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"nan", "nat", "none", "null", "undefined"} else text


def _safe_number(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return default if not math.isfinite(parsed) else parsed


def _safe_bool(value: Any) -> bool:
    if _missing(value):
        return False
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def _normalize_sid(value: Any) -> str:
    text = _safe_text(value)
    return text[:-2] if text.endswith(".0") and text[:-2].isdigit() else text


def _safe_weapon(value: Any) -> str:
    text = _safe_text(value).removeprefix("weapon_")
    if not text:
        return ""
    try:
        float(text)
    except ValueError:
        return text
    return ""


def _safe_inventory(value: Any) -> list[str]:
    if _missing(value):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple, set)):
        return []
    return [
        text
        for item in value
        if (text := (_safe_weapon(item) or _safe_text(item)))
    ]


def _resolved_weapon(row: Any, inventory: list[str]) -> str:
    weapon = _safe_weapon(row.get("active_weapon_name")) or _safe_weapon(row.get("active_weapon"))
    if weapon:
        return weapon
    for item in inventory:
        lowered = item.lower().replace("-", "").replace(" ", "")
        if not any(token in lowered for token in _UTILITY_WEAPON_TOKENS):
            return item
    for item in inventory:
        lowered = item.lower()
        if "knife" in lowered or "bayonet" in lowered or "karambit" in lowered:
            return item
    return ""


def _team_side(team_num: Any) -> str:
    value = _int(team_num, -1)
    if value == 3:
        return "CT"
    if value == 2:
        return "T"
    return str(value) if value >= 0 else "?"


def _is_pov(row: Any, pov_sid: str, pov_name: str) -> bool:
    sid = _normalize_sid(row.get("steamid"))
    name = _safe_text(row.get("name")).lower()
    return bool((pov_sid and sid == pov_sid) or (pov_name and name == pov_name))


def _player_from_row(
    row: Any,
    *,
    pov_sid: str,
    pov_name: str,
    pov_team: int | None,
    player_skin_loadouts: dict[str, dict[str, dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    inventory = _safe_inventory(row.get("inventory"))
    team_num = _int(row.get("team_num"), -1)
    steamid = _normalize_sid(row.get("steamid"))
    weapon = _resolved_weapon(row, inventory)
    weapon_model = resolve_weapon_model(weapon)
    weapon_skin = skin_for_player_weapon(player_skin_loadouts, steamid, weapon)
    inventory_keys = {
        item.lower().replace("weapon_", "").replace(" ", "_")
        for item in inventory
    }
    raw_color = _safe_text(row.get("player_color")).lower()
    color_slot = _COLOR_SLOTS.get(raw_color, _int(raw_color, -1))
    player = {
        "steamid64": steamid or None,
        "name": _safe_text(row.get("name")),
        "team": _team_side(team_num),
        "x": _safe_number(row.get("X")),
        "y": _safe_number(row.get("Y")),
        "z": _safe_number(row.get("Z")),
        "yaw": _safe_number(row.get("yaw")),
        "is_alive": _safe_bool(row.get("is_alive")),
        "health": max(0, _int(row.get("health"))),
        "armor": max(0, _int(row.get("armor"))),
        "has_helmet": _safe_bool(row.get("has_helmet")),
        "money": max(0, _int(row.get("balance"))),
        "equipment_value": max(0, _int(row.get("current_equip_value"))),
        "inventory": inventory,
        "weapon": weapon,
        "has_defuser": _safe_bool(row.get("has_defuser")),
        "has_c4": _safe_bool(row.get("has_c4")) or bool({"c4", "c4_explosive"} & inventory_keys),
        "flash_duration": max(0.0, _safe_number(row.get("flash_duration"))),
        "is_pov": _is_pov(row, pov_sid, pov_name),
        "is_teammate": pov_team is not None and team_num == pov_team,
        "slot_color_index": color_slot if 0 <= color_slot <= 4 else -1,
    }
    if weapon_model:
        player["weapon_model"] = weapon_model
    if weapon_skin:
        player["weapon_skin"] = weapon_skin
    return player


def _frames_from_dataframe(frame: Any, spec: dict[str, Any], meta: dict[str, Any]) -> list[dict[str, Any]]:
    sample_ticks = [_int(tick) for tick in spec.get("sample_ticks") or []]
    if not sample_ticks:
        return []
    pov_sid = _normalize_sid(meta.get("pov_steamid64"))
    pov_name = _safe_text(meta.get("pov_player_name")).lower()
    player_skin_loadouts = meta.get("player_skin_loadouts")
    if not isinstance(player_skin_loadouts, dict):
        player_skin_loadouts = {}
    try:
        frame = pd.DataFrame(frame)
    except (TypeError, ValueError):
        frame = pd.DataFrame()
    groups: dict[int, list[dict[str, Any]]] = {}
    if frame is not None and not frame.empty and "tick" in frame.columns:
        columns = list(frame.columns)
        tick_index = columns.index("tick")
        for values in frame.itertuples(index=False, name=None):
            groups.setdefault(_int(values[tick_index]), []).append(dict(zip(columns, values)))
    fps = max(float(meta.get("fps") or REPLAY_MATCH_FPS), 0.001)
    frames: list[dict[str, Any]] = []
    last_players: list[dict[str, Any]] = []
    for index, tick in enumerate(sample_ticks):
        records = groups.get(tick)
        players: list[dict[str, Any]] = []
        if records:
            pov_team = next(
                (_int(row.get("team_num"), -1) for row in records if _is_pov(row, pov_sid, pov_name)),
                None,
            )
            if pov_team == -1:
                pov_team = None
            players = [
                _player_from_row(
                    row,
                    pov_sid=pov_sid,
                    pov_name=pov_name,
                    pov_team=pov_team,
                    player_skin_loadouts=player_skin_loadouts,
                )
                for row in records
                if _int(row.get("team_num"), -1) in {2, 3}
            ]
            if players:
                last_players = players
        elif last_players:
            players = [dict(player) for player in last_players]
        frames.append(
            {
                "tick": tick,
                "time_sec": index / fps,
                "players": players,
            }
        )
    return frames


def materialize_match_replay_parquet_impl(
    *,
    demo_path: str,
    workspace: dict[str, Any],
    fps: float = REPLAY_MATCH_FPS,
) -> dict[str, Any]:
    """Parse all replay ticks once and atomically write Rust-native Parquet."""
    from demoparser2 import DemoParser

    from app.features.demo_analysis.replay_effects import extract_dynamic_effect_tracks
    from app.radar.radar_map_assets import lookup_map_data

    started = time.perf_counter()
    rounds = _clean_rounds(workspace)
    if not rounds:
        return {"status": "skipped", "reason": "workspace has no valid rounds"}
    tick_rate = max(0.001, float(workspace.get("tick_rate") or 64.0))
    cache_key = replay_match_cache_key(demo_path, fps=fps, tick_rate=tick_rate)
    if not cache_key:
        raise FileNotFoundError(demo_path)
    parquet_path, meta_path = _cache_paths(cache_key)

    existing_entry = _load_meta_entry(cache_key)
    existing = existing_entry[0] if existing_entry else None
    existing_parquet_path = existing_entry[1] if existing_entry else None
    expected_boundaries = _round_boundaries(rounds)
    existing_boundaries = _round_boundaries(existing.get("rounds") or []) if existing else []
    if (
        existing is not None
        and existing_parquet_path is not None
        and existing_parquet_path.is_file()
        and existing_boundaries == expected_boundaries
    ):
        return {
            "status": "parquet_hit",
            "cache_key": cache_key,
            "rounds": len(existing.get("rounds") or []),
            "frames": sum(_int(item.get("frame_count")) for item in existing.get("rounds") or []),
            "bytes": existing_parquet_path.stat().st_size,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }
    if existing is not None and existing_parquet_path is not None and existing_parquet_path.is_file():
        logger.info(
            "Rebuilding stale replay Parquet round boundaries: key=%s cached=%s expected=%s",
            cache_key,
            existing_boundaries,
            expected_boundaries,
        )

    round_specs: list[dict[str, Any]] = []
    all_ticks: list[int] = []
    all_round_numbers: list[int] = []
    for round_row in rounds:
        ticks = _sample_ticks(
            round_row["start_tick"],
            round_row["end_tick"],
            tick_rate,
            float(fps),
        )
        round_specs.append(
            {
                **round_row,
                "frame_count": len(ticks),
                "sample_ticks": ticks,
            }
        )
        all_ticks.extend(ticks)
        all_round_numbers.extend([round_row["round_number"]] * len(ticks))

    first_player = next(
        (item for item in workspace.get("players") or [] if isinstance(item, dict)),
        {},
    )
    map_name = str(workspace.get("map_name") or "unknown")
    broad_start = min(item["start_tick"] for item in round_specs)
    broad_end = max(item["end_tick"] for item in round_specs)
    parquet_tmp = parquet_path.with_suffix(f"{parquet_path.suffix}.partial")
    meta_tmp = meta_path.with_suffix(f"{meta_path.suffix}.partial")
    parser = DemoParser(str(demo_path))
    try:
        player_skin_loadouts = build_player_skin_loadouts(parser)
        native_result = parser.write_replay_parquet(
            str(parquet_tmp),
            list(_RAW_PLAYER_FIELDS),
            all_ticks,
            all_round_numbers,
        )
        row_groups = {
            _int(item.get("round_number")): dict(item)
            for item in native_result.get("row_groups") or []
            if isinstance(item, dict)
        }
        for spec in round_specs:
            native_group = row_groups.get(spec["round_number"])
            if native_group is None:
                raise RuntimeError(
                    f"Rust replay Parquet omitted round {spec['round_number']}"
                )
            spec["row_group"] = _int(native_group.get("row_group"), -1)
            spec["player_rows"] = _int(native_group.get("rows"))

        effect_payload = extract_dynamic_effect_tracks(
            parser,
            start_tick=broad_start,
            end_tick=broad_end,
            tick_rate=tick_rate,
            map_name=map_name,
            demo_path=str(demo_path),
        )
        effects = _annotate_effect_sides(
            [dict(item) for item in effect_payload.get("effects") or [] if isinstance(item, dict)],
            rounds,
            workspace,
            tick_rate=tick_rate,
        )
        try:
            map_transform = lookup_map_data(map_name)
        except (KeyError, OSError):
            map_transform = None
        meta = {
            "version": REPLAY_MATCH_CACHE_VERSION,
            "parser_runtime": REQUIRED_DEMOPARSER_VERSION,
            "cache_key": cache_key,
            "created_at": time.time(),
            "demo_fingerprint": _demo_fingerprint(demo_path),
            "map_name": map_name,
            "map_transform": map_transform,
            "tick_rate": tick_rate,
            "fps": float(fps),
            "pov_player_name": first_player.get("name"),
            "pov_steamid64": first_player.get("steam_id64") or first_player.get("steamid64"),
            "player_skin_loadouts": player_skin_loadouts,
            "rounds": [
                {
                    "round_number": spec["round_number"],
                    "start_tick": spec["start_tick"],
                    "end_tick": spec["end_tick"],
                    "row_group": spec["row_group"],
                    "frame_count": spec["frame_count"],
                    "player_rows": spec["player_rows"],
                    "sample_ticks": spec["sample_ticks"],
                    "shots": spec.get("shots") or [],
                }
                for spec in round_specs
            ],
            "effect_tracks_version": int(effect_payload.get("version") or 1),
            "effect_capabilities": effect_payload.get("capabilities") or {},
            "effect_tracks": effects,
            "effect_warnings": list(effect_payload.get("warnings") or []),
            "effect_parse_ms": effect_payload.get("parse_ms"),
        }
        meta_tmp.write_text(
            json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        parquet_tmp.replace(parquet_path)
        meta_tmp.replace(meta_path)
        remove_match_cache_for_demo(demo_path, keep_cache_key=cache_key)
        try:
            register_replay_cache_entry(
                "matches",
                demo_path,
                cache_key,
                (
                    parquet_path,
                    meta_path,
                    parquet_tmp,
                    meta_tmp,
                ),
            )
        except OSError as exc:
            invalidate_owner_index()
            logger.warning("whole-match replay owner index update failed: %s", exc)
    except Exception:
        parquet_tmp.unlink(missing_ok=True)
        meta_tmp.unlink(missing_ok=True)
        raise

    elapsed_ms = (time.perf_counter() - started) * 1000
    total_rows = _int(native_result.get("parquet_rows") or native_result.get("rows"))
    logger.info(
        "Rust whole-match replay parquet saved key=%s rounds=%s frames=%s rows=%s bytes=%s elapsed_ms=%.2f",
        cache_key,
        len(round_specs),
        len(all_ticks),
        total_rows,
        parquet_path.stat().st_size,
        elapsed_ms,
    )
    return {
        "status": "materialized",
        "cache_key": cache_key,
        "rounds": len(round_specs),
        "frames": len(all_ticks),
        "rows": total_rows,
        "bytes": parquet_path.stat().st_size,
        "elapsed_ms": round(elapsed_ms, 2),
    }


@lru_cache(maxsize=32)
def _load_meta_file(
    meta_path_text: str,
    mtime_ns: int,
    size: int,
) -> dict[str, Any] | None:
    del mtime_ns, size  # cache-key-only file identity
    meta_path = Path(meta_path_text)
    try:
        payload = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("whole-match replay metadata load failed: %s", exc)
        return None
    return payload if isinstance(payload, dict) else None


def _load_meta_entry(cache_key: str) -> tuple[dict[str, Any], Path] | None:
    for parquet_path, meta_path in _cache_path_candidates(cache_key):
        if not parquet_path.is_file() or not meta_path.is_file():
            continue
        try:
            stat = meta_path.stat()
        except OSError:
            continue
        payload = _load_meta_file(str(meta_path), int(stat.st_mtime_ns), int(stat.st_size))
        if (
            not isinstance(payload, dict)
            or payload.get("version") != REPLAY_MATCH_CACHE_VERSION
            or payload.get("cache_key") != cache_key
        ):
            continue
        return payload, parquet_path
    return None


def _load_meta(cache_key: str) -> dict[str, Any] | None:
    entry = _load_meta_entry(cache_key)
    return entry[0] if entry else None


def _normalized_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


def _remove_match_caches(
    demo_paths: list[str],
    *,
    keep_cache_key: str | None = None,
    register_survivors: bool = False,
) -> dict[str, int]:
    wanted = {_normalized_path(path) for path in demo_paths}
    keep_path = _normalized_path(demo_paths[0]) if keep_cache_key and len(demo_paths) == 1 else None
    current_fingerprint = _demo_fingerprint(demo_paths[0]) if keep_path else None
    removed_files = 0
    removed_bytes = 0
    seen: set[str] = set()
    for root in _cache_roots():
        if not root.is_dir():
            continue
        for meta_path in root.glob("*.meta.json"):
            meta_key = _normalized_path(str(meta_path))
            if meta_key in seen:
                continue
            seen.add(meta_key)
            try:
                payload = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001 - cleanup skips unknown files
                logger.warning("whole-match replay metadata cleanup read failed for %s: %s", meta_path, exc)
                continue
            fingerprint = payload.get("demo_fingerprint") if isinstance(payload, dict) else None
            cached_path = fingerprint.get("path") if isinstance(fingerprint, dict) else None
            cache_key = str(payload.get("cache_key") or "") if isinstance(payload, dict) else ""
            if not cached_path or not cache_key:
                continue
            normalized_cached_path = _normalized_path(str(cached_path))
            should_remove = normalized_cached_path in wanted
            if should_remove and keep_cache_key and normalized_cached_path == keep_path:
                if cache_key == keep_cache_key:
                    should_remove = False
                else:
                    same_source_revision = bool(
                        current_fingerprint
                        and int(fingerprint.get("size") or -1) == current_fingerprint["size"]
                        and int(fingerprint.get("mtime_ns") or -1) == current_fingerprint["mtime_ns"]
                    )
                    if (
                        same_source_revision
                        and payload.get("version") == REPLAY_MATCH_CACHE_VERSION
                        and payload.get("parser_runtime") == REQUIRED_DEMOPARSER_VERSION
                    ):
                        # A different FPS/tick-rate cache for the same current Demo
                        # is still valid and must not be evicted by this build.
                        should_remove = False
            paths = (
                meta_path,
                root / f"{cache_key}.parquet",
                root / f"{cache_key}.meta.json.partial",
                root / f"{cache_key}.parquet.partial",
            )
            if not should_remove:
                if register_survivors:
                    register_replay_cache_entry(
                        "matches",
                        str(cached_path),
                        cache_key,
                        paths,
                    )
                continue
            for path in paths:
                if not path.is_file():
                    continue
                try:
                    size = int(path.stat().st_size)
                    path.unlink(missing_ok=True)
                    removed_files += 1
                    removed_bytes += size
                except OSError as exc:
                    logger.warning("whole-match replay cache cleanup failed for %s: %s", path, exc)
    if removed_files:
        _load_meta_file.cache_clear()
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


def remove_match_caches_for_demos(
    demo_paths: list[str],
    *,
    register_survivors: bool = False,
) -> dict[str, int]:
    """Remove several Demo owners while traversing large metadata only once."""
    return _remove_match_caches(
        demo_paths,
        register_survivors=register_survivors,
    )


def remove_match_cache_for_demo(
    demo_path: str,
    *,
    keep_cache_key: str | None = None,
) -> dict[str, int]:
    """Remove whole-match Parquet entries associated with one Demo path."""
    return _remove_match_caches([demo_path], keep_cache_key=keep_cache_key)


def _attach_shots(frames: list[dict[str, Any]], shots: list[dict[str, Any]]) -> None:
    if not frames or not shots:
        return
    from bisect import bisect_left

    sample_ticks = [_int(frame.get("tick")) for frame in frames]
    for shot in shots:
        shot_tick = _int(shot.get("tick"))
        insertion = bisect_left(sample_ticks, shot_tick)
        candidates = [index for index in (insertion - 1, insertion) if 0 <= index < len(frames)]
        if not candidates:
            continue
        frame_index = min(candidates, key=lambda index: abs(sample_ticks[index] - shot_tick))
        frames[frame_index].setdefault("shots", []).append(dict(shot))


def load_match_replay_round(
    demo_path: str,
    *,
    start_tick: int,
    end_tick: int,
    fps: float,
    tick_rate: float,
) -> dict[str, Any] | None:
    """Read one exact round row group through the Rust extension."""
    from demoparser2 import DemoParser

    started = time.perf_counter()
    cache_key = replay_match_cache_key(demo_path, fps=fps, tick_rate=tick_rate)
    if not cache_key:
        return None
    entry = _load_meta_entry(cache_key)
    if entry is None:
        return None
    meta, parquet_path = entry
    spec = next(
        (
            item
            for item in meta.get("rounds") or []
            if _int(item.get("start_tick")) == int(start_tick)
            and _int(item.get("end_tick")) == int(end_tick)
        ),
        None,
    )
    if not isinstance(spec, dict):
        return None
    frame = DemoParser.read_replay_parquet_round(
        str(parquet_path),
        _int(spec.get("row_group")),
    )
    frames = _frames_from_dataframe(frame, spec, meta)
    _attach_shots(frames, [dict(item) for item in spec.get("shots") or [] if isinstance(item, dict)])
    effects = [
        dict(track)
        for track in meta.get("effect_tracks") or []
        if isinstance(track, dict)
        and _int(track.get("end_tick")) >= int(start_tick)
        and _int(track.get("start_tick")) <= int(end_tick)
    ]
    return {
        "frames": frames,
        "map_transform": meta.get("map_transform"),
        "fps": float(meta.get("fps") or fps),
        "effect_tracks_version": int(meta.get("effect_tracks_version") or 1),
        "effect_capabilities": meta.get("effect_capabilities") or {},
        "effect_tracks": effects,
        "effect_warnings": list(meta.get("effect_warnings") or []),
        "effect_parse_ms": meta.get("effect_parse_ms"),
        "demo_fingerprint": meta.get("demo_fingerprint"),
        "cache_key": cache_key,
        "read_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def load_match_replay_round_binary(
    demo_path: str,
    *,
    start_tick: int,
    end_tick: int,
    fps: float,
    tick_rate: float,
) -> bytes | None:
    """Read one row group into Rust's compact TypedArray-ready protocol."""
    from demoparser2 import DemoParser

    cache_key = replay_match_cache_key(demo_path, fps=fps, tick_rate=tick_rate)
    if not cache_key:
        return None
    entry = _load_meta_entry(cache_key)
    if entry is None:
        return None
    meta, parquet_path = entry
    spec = next(
        (
            item
            for item in meta.get("rounds") or []
            if _int(item.get("start_tick")) == int(start_tick)
            and _int(item.get("end_tick")) == int(end_tick)
        ),
        None,
    )
    if not isinstance(spec, dict):
        return None
    binary_reader = getattr(DemoParser, "read_replay_parquet_round_binary", None)
    if binary_reader is None:
        return None
    metadata = {
        "round_number": _int(spec.get("round_number")),
        "start_tick": int(start_tick),
        "end_tick": int(end_tick),
        "tick_rate": float(meta.get("tick_rate") or tick_rate),
        "fps": float(meta.get("fps") or fps),
        "map_transform": meta.get("map_transform"),
        "pov_player_name": meta.get("pov_player_name"),
        "pov_steamid64": meta.get("pov_steamid64"),
        "player_skin_loadouts": meta.get("player_skin_loadouts") or {},
        "shots": [dict(item) for item in spec.get("shots") or [] if isinstance(item, dict)],
        "effect_tracks_version": int(meta.get("effect_tracks_version") or 1),
        "effect_capabilities": meta.get("effect_capabilities") or {},
        "effect_warnings": list(meta.get("effect_warnings") or []),
        "effect_tracks": [
            dict(track)
            for track in meta.get("effect_tracks") or []
            if isinstance(track, dict)
            and _int(track.get("end_tick")) >= int(start_tick)
            and _int(track.get("start_tick")) <= int(end_tick)
        ],
        "effects_pending": False,
        "demo_fingerprint": meta.get("demo_fingerprint"),
        "cache_key": cache_key,
        "cache": {
            "frames": "parquet_binary_hit",
            "effects": "parquet_hit",
            "parsed": False,
        },
    }
    packet = binary_reader(
        str(parquet_path),
        _int(spec.get("row_group")),
        [_int(tick) for tick in spec.get("sample_ticks") or []],
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
    )
    return bytes(packet)
