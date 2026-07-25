from __future__ import annotations

import logging
import math
import os
from bisect import bisect_left
from typing import Any

from app.demo_parse_isolation import extract_radar_timeline_isolated, extract_replay_effects_isolated

logger = logging.getLogger(__name__)


def _normalize_record_segments(
    record_segments: list[dict[str, Any]] | None,
    tick_rate: float,
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    tr = max(float(tick_rate), 0.001)
    for raw in record_segments or []:
        if not isinstance(raw, dict):
            continue
        try:
            start_tick = int(raw["start_tick"])
            end_tick = int(raw["end_tick"])
            video_start_sec = float(raw.get("video_start_sec", 0.0) or 0.0)
        except (KeyError, TypeError, ValueError):
            continue

        if end_tick <= start_tick:
            continue

        duration_sec = raw.get("duration_sec")
        if duration_sec is None:
            duration_sec = (end_tick - start_tick) / tr

        try:
            duration_sec = float(duration_sec)
        except (TypeError, ValueError):
            duration_sec = (end_tick - start_tick) / tr

        normalized.append(
            {
                **raw,
                "start_tick": start_tick,
                "end_tick": end_tick,
                "video_start_sec": video_start_sec,
                "duration_sec": max(0.0, duration_sec),
            },
        )

    normalized.sort(key=lambda seg: float(seg["video_start_sec"]))
    return normalized


def _normalize_radar_timing(radar_timing: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(radar_timing, dict):
        return []

    raw_segments = radar_timing.get("segments")
    if not isinstance(raw_segments, list):
        return []

    segments: list[dict[str, Any]] = []

    for raw in raw_segments:
        if not isinstance(raw, dict):
            continue

        try:
            video_start = float(raw["video_start_sec"])
            video_end = float(raw["video_end_sec"])
        except (KeyError, TypeError, ValueError):
            continue

        if video_end <= video_start:
            continue

        if raw.get("sync_method") in ("hold_previous", "hold_or_empty") or raw.get("type") == "gap":
            segments.append(
                {
                    **raw,
                    "video_start_sec": video_start,
                    "video_end_sec": video_end,
                    "type": raw.get("type", "gap"),
                    "sync_method": raw.get("sync_method", "hold_or_empty"),
                },
            )
            continue

        try:
            demo_start = int(raw["demo_start_tick"])
            demo_end = int(raw["demo_end_tick"])
        except (KeyError, TypeError, ValueError):
            continue

        if demo_end <= demo_start:
            continue

        segments.append(
            {
                **raw,
                "video_start_sec": video_start,
                "video_end_sec": video_end,
                "demo_start_tick": demo_start,
                "demo_end_tick": demo_end,
                "sync_method": raw.get("sync_method", "affine"),
            },
        )

    segments.sort(key=lambda s: float(s["video_start_sec"]))
    return segments


def _tick_for_video_time_from_radar_timing(
    video_time_sec: float,
    segments: list[dict[str, Any]],
    *,
    last_tick: int | None,
) -> int | None:
    if not segments:
        return None

    selected: dict[str, Any] | None = None

    for seg in segments:
        vs = float(seg["video_start_sec"])
        ve = float(seg["video_end_sec"])
        if vs <= video_time_sec < ve:
            selected = seg
            break

    if selected is None:
        for seg in reversed(segments):
            if "demo_end_tick" in seg:
                return int(seg["demo_end_tick"]) - 1
        return last_tick

    sync_method = selected.get("sync_method", "affine")

    if sync_method in ("hold_previous", "hold_or_empty") or selected.get("type") == "gap":
        return last_tick

    video_start = float(selected["video_start_sec"])
    video_end = float(selected["video_end_sec"])
    demo_start = int(selected["demo_start_tick"])
    demo_end = int(selected["demo_end_tick"])

    ratio = (video_time_sec - video_start) / max(video_end - video_start, 0.001)
    ratio = max(0.0, min(1.0, ratio))

    t = demo_start + int(round(ratio * (demo_end - demo_start)))
    t = max(demo_start, min(t, demo_end - 1))

    return int(t)


def _tick_for_video_time_from_segments(
    video_time_sec: float,
    segments: list[dict[str, Any]],
    tick_rate: float,
    sync_offset_sec: float = 0.0,
) -> int:
    if not segments:
        raise ValueError("record_segments is empty")

    # 取「视频时间所在」的段：最后一个 video_start_sec <= video_time_sec 的 segment
    selected = segments[0]
    for seg in segments:
        if float(seg["video_start_sec"]) <= video_time_sec:
            selected = seg
        else:
            break

    local_time_sec = max(0.0, video_time_sec - float(selected["video_start_sec"]))
    local_time_sec += float(sync_offset_sec or 0.0)

    t = int(selected["start_tick"]) + int(round(local_time_sec * tick_rate))
    t = max(int(selected["start_tick"]), min(t, int(selected["end_tick"]) - 1))

    return t


def extract_radar_timeline(
    *,
    demo_path: str,
    map_name: str,
    pov_player_name: str | None,
    pov_steamid64: str | None,
    start_tick: int,
    end_tick: int,
    fps: float,
    duration_sec: float,
    demo_tick_rate: float = 64.0,
    radar_sync_offset_sec: float = 0.0,
    record_segments: list[dict[str, Any]] | None = None,
    radar_timing: dict[str, Any] | None = None,
    include_all_players: bool = False,
    include_effect_tracks: bool = False,
) -> list[dict[str, Any]] | dict[str, Any]:
    """Wrap isolated worker (demoparser native crashes cannot kill FastAPI)."""
    try:
        result = extract_radar_timeline_isolated(
            demo_path=demo_path,
            map_name=map_name,
            pov_player_name=pov_player_name,
            pov_steamid64=pov_steamid64,
            start_tick=int(start_tick),
            end_tick=int(end_tick),
            fps=float(fps),
            duration_sec=float(duration_sec),
            demo_tick_rate=float(demo_tick_rate),
            radar_sync_offset_sec=float(radar_sync_offset_sec),
            record_segments=record_segments,
            radar_timing=radar_timing,
            include_all_players=bool(include_all_players),
            include_effect_tracks=bool(include_effect_tracks),
        )
    except Exception as e:
        logger.warning("radar timeline isolated parse failed: %s", e)
        raise
    if include_effect_tracks:
        if isinstance(result, dict) and isinstance(result.get("frames"), list):
            return result
        frames = result if isinstance(result, list) else []
        return {
            "frames": frames,
            "effect_tracks_version": 1,
            "effect_capabilities": {
                "inferno_cells": False,
                "smoke_voxels": False,
                "smoke_mode": "legacy_circle",
            },
            "effect_tracks": [],
            "effect_warnings": ["effect sidecar missing from worker payload"],
        }
    if not isinstance(result, list):
        if isinstance(result, dict) and isinstance(result.get("frames"), list):
            return result["frames"]
        return []
    return result


def extract_radar_timeline_impl(
    *,
    demo_path: str,
    map_name: str,
    pov_player_name: str | None,
    pov_steamid64: str | None,
    start_tick: int,
    end_tick: int,
    fps: float,
    duration_sec: float,
    demo_tick_rate: float = 64.0,
    radar_sync_offset_sec: float = 0.0,
    record_segments: list[dict[str, Any]] | None = None,
    radar_timing: dict[str, Any] | None = None,
    include_all_players: bool = False,
    include_effect_tracks: bool = False,
    sample_ticks_override: list[int] | None = None,
    include_shots: bool = True,
) -> list[dict[str, Any]] | dict[str, Any]:
    """
    Runs inside parse_worker child process.
    从 demo 中提取雷达时间线（与成片 fps / 时长对齐，每帧一条）。
    时间轴：radar_timing > record_segments > record_start/end 线性铺满 tick 区间。
    """
    map_name_for_effects = map_name
    del map_name

    import pandas as pd
    from demoparser2 import DemoParser

    from app.demo_parser import _to_pandas_df

    def _norm_sid(val: object) -> str:
        if val is None or (isinstance(val, float) and pd.isna(val)):
            return ""
        s = str(val).strip()
        if s.endswith(".0") and s[:-2].isdigit():
            s = s[:-2]
        return s

    def _safe_number(val: object, default: float = 0.0) -> float:
        try:
            parsed = float(val)
        except (TypeError, ValueError):
            return default
        return default if pd.isna(parsed) else parsed

    def _safe_text(value: object) -> str:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return ""
        text = str(value).strip()
        return "" if text.lower() in {"nan", "nat", "none", "null", "undefined"} else text

    def _safe_weapon_text(value: object) -> str:
        text = _safe_text(value).removeprefix("weapon_")
        if not text:
            return ""
        try:
            float(text)
        except ValueError:
            return text
        return ""

    def _safe_bool(value: object) -> bool:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return False
        return bool(value)

    def _safe_inventory(value: object) -> list[str]:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return []
        if hasattr(value, "tolist"):
            value = value.tolist()
        if not isinstance(value, (list, tuple, set)):
            return []
        inventory: list[str] = []
        for item in value:
            text = _safe_weapon_text(item) or _safe_text(item)
            if text:
                inventory.append(text)
        return inventory

    _UTILITY_WEAPON_TOKENS = (
        "knife", "bayonet", "karambit", "smoke", "flash", "hegrenade", "molotov", "incendiary",
        "incgrenade", "decoy", "taser", "zeus", "c4", "defuser", "healthshot",
        "kevlar", "assaultsuit", "helmet", "vest",
    )

    def _primary_from_inventory(inventory: list[str]) -> str:
        for item in inventory:
            lowered = item.lower().replace("-", "").replace(" ", "")
            if any(token in lowered for token in _UTILITY_WEAPON_TOKENS):
                continue
            if lowered in {"armor"}:
                continue
            return item
        return ""

    def _melee_from_inventory(inventory: list[str]) -> str:
        for item in inventory:
            lowered = item.lower()
            if any(
                token in lowered
                for token in (
                    "knife", "bayonet", "karambit", "shadow daggers", "stiletto",
                    "talon", "ursus", "navaja", "nomad", "paracord", "skeleton",
                )
            ):
                return item
        return ""

    def _resolve_weapon(record: pd.Series, inventory: list[str]) -> str:
        weapon = _safe_weapon_text(record.get("active_weapon_name")) or _safe_weapon_text(record.get("active_weapon"))
        if weapon:
            return weapon
        return _primary_from_inventory(inventory) or _melee_from_inventory(inventory) or "knife"

    def _first_text(record: pd.Series, *keys: str) -> str:
        for key in keys:
            value = _safe_text(record.get(key))
            if value:
                return value
        return ""

    def _first_number(record: pd.Series, *keys: str, default: float = 0.0) -> float:
        for key in keys:
            value = _safe_number(record.get(key), math.nan)
            if math.isfinite(value):
                return value
        return default

    def _team_side(team_num: float | int) -> str:
        try:
            t = int(float(team_num))
        except (TypeError, ValueError):
            return "?"
        if t == 3:
            return "CT"
        if t == 2:
            return "T"
        return str(t)

    tick_rate = float(demo_tick_rate or 64.0)
    tick_rate = max(tick_rate, 0.001)
    sync_offset_sec = float(radar_sync_offset_sec or 0.0)
    segments = _normalize_record_segments(record_segments, tick_rate)
    timing_segments = _normalize_radar_timing(radar_timing)

    start_i = int(start_tick)
    end_i = int(end_tick)
    if segments:
        probe_lo = min(int(s["start_tick"]) for s in segments)
        probe_hi = max(int(s["end_tick"]) for s in segments)
    else:
        probe_lo, probe_hi = start_i, end_i

    parser = DemoParser(demo_path)
    pov_sid = _norm_sid(pov_steamid64)
    pov_name_key = (pov_player_name or "").strip().lower()
    pov_team: int | None = None
    pov_display_name = ""

    n_frames = max(1, int(round(max(0.01, duration_sec) * max(0.01, fps))))
    sample_ticks: list[int] = []
    if sample_ticks_override is not None:
        sample_ticks = [
            int(tick)
            for tick in sample_ticks_override
            if int(probe_lo) <= int(tick) < int(probe_hi)
        ]
    else:
        last_tick: int | None = None
        try:
            sync_lead_sec = float(os.environ.get("CS2_INSIGHT_RADAR_SYNC_LEAD_SEC") or 0.0)
        except (TypeError, ValueError):
            sync_lead_sec = 0.0
        for i in range(n_frames):
            video_time_sec = i / max(float(fps), 0.001) + sync_lead_sec
            t: int
            if timing_segments:
                tick_opt = _tick_for_video_time_from_radar_timing(
                    video_time_sec,
                    timing_segments,
                    last_tick=last_tick,
                )
                if tick_opt is None:
                    t = int(start_i)
                else:
                    t = int(tick_opt)
            elif segments:
                t = _tick_for_video_time_from_segments(
                    video_time_sec=video_time_sec,
                    segments=segments,
                    tick_rate=tick_rate,
                    sync_offset_sec=sync_offset_sec,
                )
            else:
                span = max(1, int(end_i) - int(start_i))
                if n_frames <= 1:
                    t = int(start_i)
                else:
                    t = int(start_i) + int(round((i / (n_frames - 1)) * (span - 1)))
                t = max(int(start_i), min(t, int(end_i) - 1))
            last_tick = int(t)
            sample_ticks.append(int(t))

    if not sample_ticks:
        return []

    fields = [
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
    ]

    uniq = sorted(set(sample_ticks))
    try:
        raw = parser.parse_ticks(fields, ticks=uniq)
    except Exception:
        try:
            raw = parser.parse_ticks(
                ["X", "Y", "Z", "yaw", "name", "steamid", "team_num", "is_alive", "player_color"],
                ticks=uniq,
            )
        except Exception:
            raw = None
    pdf = _to_pandas_df(raw)

    if not pdf.empty and "team_num" in pdf.columns:
        sid_col = "steamid" if "steamid" in pdf.columns else None
        name_col = "name" if "name" in pdf.columns else None
        if pov_sid and sid_col:
            hit = pdf[pdf[sid_col].apply(lambda x: _norm_sid(x) == pov_sid)]
            if not hit.empty:
                try:
                    pov_team = int(float(hit.iloc[0]["team_num"]))
                except (TypeError, ValueError):
                    pov_team = None
                if name_col:
                    pov_display_name = str(hit.iloc[0].get(name_col) or "").strip()
        if pov_team is None and pov_name_key and name_col:
            hit = pdf[pdf[name_col].astype(str).str.strip().str.lower() == pov_name_key]
            if not hit.empty:
                try:
                    pov_team = int(float(hit.iloc[0]["team_num"]))
                except (TypeError, ValueError):
                    pov_team = None
                pov_display_name = str(hit.iloc[0].get(name_col) or "").strip()

    if pov_team is None and not include_all_players:
        return []

    snap_by_tick: dict[int, pd.DataFrame] = {}
    if not pdf.empty and "tick" in pdf.columns:
        for tick_val, grp in pdf.groupby("tick", sort=False):
            snap_by_tick[int(tick_val)] = grp

    timeline: list[dict[str, Any]] = []
    last_players: list[dict[str, Any]] = []

    for i, tick in enumerate(sample_ticks):
        grp = snap_by_tick.get(tick)
        players_out: list[dict[str, Any]] = []
        if grp is not None and not grp.empty and "team_num" in grp.columns:
            if "is_alive" in grp.columns and not include_all_players:
                alive_df = grp[grp["is_alive"].astype(bool)]
                work = alive_df if not alive_df.empty else grp
            else:
                work = grp
            for _, r in work.iterrows():
                try:
                    tm = int(float(r.get("team_num")))
                except (TypeError, ValueError):
                    continue
                if not include_all_players and tm != pov_team:
                    continue
                nm = _safe_text(r.get("name"))
                sid_c = _norm_sid(r.get("steamid")) if "steamid" in work.columns else ""
                try:
                    hx = float(r.get("X"))
                    hy = float(r.get("Y"))
                    hz = float(r.get("Z")) if "Z" in work.columns else 0.0
                except (TypeError, ValueError):
                    continue
                yaw_v = 0.0
                if "yaw" in work.columns:
                    try:
                        yaw_v = float(r.get("yaw") or 0.0)
                    except (TypeError, ValueError):
                        yaw_v = 0.0
                alive = True
                if "is_alive" in work.columns:
                    alive = _safe_bool(r.get("is_alive"))
                is_pov = False
                if pov_sid and sid_c and sid_c == pov_sid:
                    is_pov = True
                elif pov_name_key and nm.strip().lower() == pov_name_key:
                    is_pov = True
                elif pov_display_name and nm.strip().lower() == pov_display_name.strip().lower():
                    is_pov = True

                color_slot = -1
                if "player_color" in work.columns:
                    _COLOR_STR_MAP = {
                        "blue": 0, "green": 1, "yellow": 2, "orange": 3, "purple": 4,
                    }
                    try:
                        raw_slot = r.get("player_color")
                        if raw_slot is not None and not (isinstance(raw_slot, float) and pd.isna(raw_slot)):
                            raw_str = str(raw_slot).strip().lower()
                            if raw_str in _COLOR_STR_MAP:
                                # demoparser2 returns color as string name
                                color_slot = _COLOR_STR_MAP[raw_str]
                            else:
                                # Fallback: might be numeric in some versions
                                color_slot = int(float(raw_slot))
                    except (TypeError, ValueError):
                        color_slot = -1

                inventory = _safe_inventory(r.get("inventory")) if "inventory" in work.columns else []
                inventory_keys = {
                    item.lower().replace("weapon_", "").replace(" ", "_")
                    for item in inventory
                }
                has_c4 = (
                    _safe_bool(r.get("has_c4")) if "has_c4" in work.columns else False
                ) or bool({"c4", "c4_explosive"} & inventory_keys)

                players_out.append(
                    {
                        "steamid64": sid_c or None,
                        "name": nm,
                        "team": _team_side(tm),
                        "x": hx,
                        "y": hy,
                        "z": hz,
                        "yaw": yaw_v,
                        "is_alive": alive,
                        "health": max(0, int(_safe_number(r.get("health"), 0))),
                        "armor": max(0, int(_safe_number(r.get("armor"), 0))),
                        "has_helmet": _safe_bool(r.get("has_helmet")) if "has_helmet" in work.columns else False,
                        "money": max(0, int(_safe_number(r.get("balance"), 0))),
                        "equipment_value": max(0, int(_safe_number(r.get("current_equip_value"), 0))),
                        "inventory": inventory,
                        "weapon": _resolve_weapon(r, inventory),
                        "has_defuser": _safe_bool(r.get("has_defuser")) if "has_defuser" in work.columns else False,
                        "has_c4": has_c4,
                        "flash_duration": max(0.0, _safe_number(r.get("flash_duration"), 0.0)),
                        "is_pov": is_pov,
                        "is_teammate": pov_team is not None and tm == pov_team,
                        "slot_color_index": color_slot if 0 <= color_slot <= 4 else -1,
                    },
                )
            if players_out:
                last_players = players_out
        else:
            # Carry last known player state across brief parse misses.
            players_out = [dict(p) for p in last_players]

        time_sec = i / max(fps, 0.001)
        timeline.append(
            {
                "tick": int(tick),
                "time_sec": float(time_sec),
                "players": players_out,
            },
        )

    # Keep replay self-contained for workspaces cached before the shots field
    # existed. Attaching shots to the nearest requested replay frame avoids a second demo
    # parse in the API process and preserves native-parser crash isolation.
    fire_df = pd.DataFrame()
    if include_shots:
        try:
            raw_fire = parser.parse_event(
                "weapon_fire",
                player=["steamid", "name", "team_num", "X", "Y", "Z", "yaw", "pitch"],
                other=["weapon"],
            )
            fire_df = _to_pandas_df(raw_fire)
        except Exception:
            fire_df = pd.DataFrame()

    non_bullet_weapons = {
        "", "c4", "knife", "knife_t", "taser", "hegrenade", "flashbang",
        "smokegrenade", "molotov", "incgrenade", "incendiary", "decoy",
    }
    if timeline and not fire_df.empty and "tick" in fire_df.columns:
        fire_df = fire_df[(fire_df["tick"] >= start_i) & (fire_df["tick"] <= end_i)]
        for _, shot_row in fire_df.iterrows():
            shot_tick = int(_safe_number(shot_row.get("tick"), 0))
            if shot_tick < start_i or shot_tick > end_i:
                continue
            weapon = _safe_weapon_text(shot_row.get("weapon"))
            if weapon.lower() in non_bullet_weapons:
                continue
            actor = _first_text(shot_row, "user_name", "player_name", "name")
            if not actor:
                continue
            insertion = bisect_left(sample_ticks, shot_tick)
            candidates = [index for index in (insertion - 1, insertion) if 0 <= index < len(sample_ticks)]
            if not candidates:
                continue
            frame_index = min(candidates, key=lambda index: abs(sample_ticks[index] - shot_tick))
            payload: dict[str, Any] = {
                "tick": shot_tick,
                "actor": actor,
                "weapon": weapon,
                "yaw": _first_number(shot_row, "user_yaw", "player_yaw", "yaw"),
                "pitch": _first_number(shot_row, "user_pitch", "player_pitch", "pitch"),
            }
            x = _first_number(shot_row, "user_X", "player_X", "X", default=math.nan)
            y = _first_number(shot_row, "user_Y", "player_Y", "Y", default=math.nan)
            if math.isfinite(x) and math.isfinite(y):
                payload.update({"x": x, "y": y})
            timeline[frame_index].setdefault("shots", []).append(payload)

    if not include_effect_tracks:
        return timeline

    effect_payload: dict[str, Any] = {
        "version": 1,
        "capabilities": {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        },
        "effects": [],
        "warnings": [],
        "parse_ms": 0.0,
    }
    try:
        from app.parser.replay_effects import extract_dynamic_effect_tracks

        effect_payload = extract_dynamic_effect_tracks(
            parser,
            start_tick=int(start_tick),
            end_tick=int(end_tick),
            tick_rate=float(demo_tick_rate),
            map_name=str(map_name_for_effects or "") or None,
            demo_path=str(demo_path),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay effect tracks failed: %s", exc)
        effect_payload["warnings"] = [f"effect extract failed: {type(exc).__name__}: {exc}"]

    return {
        "frames": timeline,
        "effect_tracks_version": int(effect_payload.get("version") or 1),
        "effect_capabilities": effect_payload.get("capabilities") or {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        },
        "effect_tracks": effect_payload.get("effects") or [],
        "effect_warnings": effect_payload.get("warnings") or [],
        "effect_parse_ms": effect_payload.get("parse_ms"),
    }


def extract_replay_effects(
    *,
    demo_path: str,
    map_name: str,
    start_tick: int,
    end_tick: int,
    demo_tick_rate: float = 64.0,
) -> dict[str, Any]:
    """Isolated-worker wrapper: smoke/inferno effect tracks for a tick window."""
    try:
        result = extract_replay_effects_isolated(
            demo_path=demo_path,
            map_name=map_name,
            start_tick=int(start_tick),
            end_tick=int(end_tick),
            demo_tick_rate=float(demo_tick_rate),
        )
    except Exception as exc:
        logger.warning("replay effects isolated parse failed: %s", exc)
        raise
    if isinstance(result, dict):
        return result
    return {
        "effect_tracks_version": 1,
        "effect_capabilities": {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        },
        "effect_tracks": [],
        "effect_warnings": ["invalid worker payload"],
    }


def extract_replay_effects_impl(
    *,
    demo_path: str,
    map_name: str,
    start_tick: int,
    end_tick: int,
    demo_tick_rate: float = 64.0,
) -> dict[str, Any]:
    """Runs inside parse_worker: only dynamic utility effect tracks."""
    from demoparser2 import DemoParser

    from app.parser.replay_effects import extract_dynamic_effect_tracks

    parser = DemoParser(demo_path)
    payload = extract_dynamic_effect_tracks(
        parser,
        start_tick=int(start_tick),
        end_tick=int(end_tick),
        tick_rate=float(demo_tick_rate),
        map_name=str(map_name or "") or None,
        demo_path=str(demo_path),
    )
    return {
        "effect_tracks_version": int(payload.get("version") or 1),
        "effect_capabilities": payload.get("capabilities") or {
            "inferno_cells": False,
            "smoke_voxels": False,
            "smoke_mode": "legacy_circle",
        },
        "effect_tracks": payload.get("effects") or [],
        "effect_warnings": payload.get("warnings") or [],
        "effect_parse_ms": payload.get("parse_ms"),
    }
