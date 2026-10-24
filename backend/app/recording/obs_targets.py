"""Resolve OBS targets from the playback source, never from platform offsets."""
from collections import defaultdict
from pathlib import Path

from ..demo_player_entities import live_player_entities, network_entity_index
from .models import RecordingPlan, RecordingSegment

OBS_PREPARE_PREROLL_SECONDS = 5.0


def obs_prepare_tick(segment: RecordingSegment, tick_rate: float) -> int:
    if segment.safe_seek_tick < segment.start_tick:
        return max(0, segment.safe_seek_tick)
    return max(0, segment.start_tick - int(OBS_PREPARE_PREROLL_SECONDS * tick_rate))


def _identity(rows, name: str, steamid: str):
    # An ID survives renames. Never substitute a same-name player for a missing ID.
    if steamid:
        candidates = [row for row in rows if str(row.get("steamid") or "") == steamid]
    else:
        candidates = [row for row in rows
                      if name and str(row.get("name") or "").strip().casefold() == name.strip().casefold()]
    return candidates[0] if len(candidates) == 1 else None


def _columns(value):
    return value.to_dict(orient="list") if hasattr(value, "to_dict") else value


def resolve_obs_targets(demo_path: str, targets: list[dict], *, parser=None) -> list[dict]:
    """Worker entry point: batch both prepare/start snapshots for one Demo."""
    from demoparser2 import DemoParser, WantedPropState

    if not targets:
        return []
    parser = parser or DemoParser(demo_path)
    ticks = sorted({int(target[key]) for target in targets for key in ("seek_tick", "start_tick")})
    columns = _columns(parser.parse_ticks([
        "entity_id", "is_alive", "CCSPlayerPawn.m_hController",
        "CCSPlayerController.m_hPlayerPawn", "CCSPlayerController.m_bControllingBot",
    ], ticks=ticks))
    by_tick = defaultdict(list)
    for i, tick in enumerate(columns.get("tick", [])):
        by_tick[int(tick)].append({key: values[i] for key, values in columns.items()})

    # OBS retains its own death/observer behavior. A BOT takeover requires the
    # separate verified body timeline; do not silently treat it as a normal cut.
    flag = "CCSPlayerController.m_bControllingBot"
    scan_ticks = sorted({tick for target in targets
                         for tick in range(target["seek_tick"], target["end_tick"] + 1)})
    bot_columns = _columns(parser.parse_ticks(
        [flag], ticks=scan_ticks, prop_states=[WantedPropState(flag, True)],
    ))
    bot_rows = [{key: values[i] for key, values in bot_columns.items()}
                for i in range(len(bot_columns.get("tick", [])))]

    def checked_body(rows, target):
        row = _identity(rows, target["name"], target["steamid64"])
        body = live_player_entities(row)
        if body and sum(network_entity_index(r.get("CCSPlayerPawn.m_hController")) == body[0]
                        for r in rows) != 1:
            return row, None
        return row, body

    resolved = []
    for target in targets:
        label = target["name"] or target["steamid64"]
        start_tick, seek_tick = target["start_tick"], target["seek_tick"]
        start_row, start = checked_body(by_tick[start_tick], target)
        seek_row, seek = checked_body(by_tick[seek_tick], target)
        takeover = any(row and row.get(flag) for row in (start_row, seek_row))
        takeover = takeover or any(
            row.get(flag) and seek_tick <= int(row["tick"]) <= target["end_tick"]
            and _identity([row], target["name"], target["steamid64"]) is not None
            for row in bot_rows
        )
        if takeover:
            raise ValueError(f"OBS 片段包含玩家 {label} 接管 BOT，暂不支持；请拆分片段后重试。")
        if start is None:
            raise ValueError(f"OBS 无法在 tick {start_tick} 确认玩家 {label} 的控制器：目标缺失、重名、已死亡或实体关系不一致。")
        steamid = str(start_row.get("steamid") or "")
        if not steamid.isdigit() or not steamid.startswith("7656") or len(steamid) != 17:
            raise ValueError(f"OBS 玩家 {label} 缺少可供 GSI 核验的 SteamID，无法确认录制视角。")
        # If the player is absent/dead in preroll, or reconnects into a different
        # controller, prepare at the verified start instead of selecting a neighbor.
        actual_seek = seek_tick if seek and seek[0] == start[0] else start_tick
        resolved.append({"slot": start[0], "pawn": start[1],
                         "steamid64": steamid, "seek_tick": actual_seek})
    return resolved


def prepare_obs_plan_targets(plans: list[RecordingPlan], demo_path: Path, *, resolver=None) -> list[RecordingPlan]:
    """Replace only execution-local OBS metadata; shared raw slots stay intact."""
    from ..demo_parse_isolation import resolve_obs_targets_isolated

    copies = [plan.model_copy(deep=True) for plan in plans]
    segments = [(plan, segment) for plan in copies for segment in plan.segments if not segment.disabled]
    targets = [{"name": segment.target_player_name, "steamid64": segment.target_steamid64 or "",
                "start_tick": segment.start_tick, "end_tick": segment.end_tick,
                "seek_tick": obs_prepare_tick(segment, plan.tick_rate)}
               for plan, segment in segments]
    resolved = (resolver or resolve_obs_targets_isolated)(str(demo_path), targets) if targets else []
    if not isinstance(resolved, list) or len(resolved) != len(segments):
        raise ValueError("OBS 玩家控制器解析结果不完整")
    for (_, segment), target in zip(segments, resolved):
        slot = target.get("slot")
        seek = target.get("seek_tick")
        if (type(slot) is not int or not 1 <= slot <= 64 or type(seek) is not int
                or not 0 <= seek <= segment.start_tick or not target.get("steamid64")):
            raise ValueError("OBS 玩家控制器解析结果无效")
        segment.metadata = {key: value for key, value in segment.metadata.items()
                            if key != "obs_spec_slot_offset"}
        segment.metadata.update({"obs_controller_slot": slot, "obs_controller_pawn": target["pawn"],
                                 "obs_prepare_tick": seek})
        segment.target_steamid64 = target["steamid64"]
    return copies
