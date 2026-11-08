"""Resolve OBS targets from the playback source, never from platform offsets."""
from collections import defaultdict
import logging
from pathlib import Path
from types import SimpleNamespace

from ..demo_player_entities import live_player_entities, network_entity_index
from .models import RecordingPlan, RecordingSegment
from .demo_body_timeline import read_takeover_entities, takeover_timeline

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


def resolve_obs_targets(demo_path: str, targets: list[dict], *, parser=None, takeover_reader=None) -> list[dict]:
    """Worker entry point: batch both prepare/start snapshots for one Demo."""
    from demoparser2 import DemoParser, WantedPropState

    if not targets:
        return []
    parser = parser or DemoParser(demo_path)
    ticks = sorted({int(target[key]) for target in targets for key in ("seek_tick", "start_tick")})
    body_fields = [
        "entity_id", "is_alive", "CCSPlayerPawn.m_hController",
        "CCSPlayerController.m_hPlayerPawn", "CCSPlayerController.m_bControllingBot",
    ]
    columns = _columns(parser.parse_ticks(body_fields, ticks=ticks))
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

    # Only unavailable starts need a full body scan; batch them instead of
    # reparsing the DEM for every candidate tick. Never search past a cut's end.
    missing = [t for t in targets if checked_body(by_tick[t["start_tick"]], t)[1] is None]
    if missing:
        search_ticks = sorted({tick for t in missing
                               for tick in range(t["start_tick"], t["end_tick"])})
        samples = _columns(parser.parse_ticks(body_fields, ticks=search_ticks))
        sampled = defaultdict(list)
        for i, tick in enumerate(samples.get("tick", [])):
            sampled[int(tick)].append({key: values[i] for key, values in samples.items()})
        by_tick.update(sampled)
    available_ticks = sorted(by_tick)

    resolved = []
    report = None
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
            if report is None:
                report = (takeover_reader or read_takeover_entities)(
                    Path(demo_path), min(t["seek_tick"] for t in targets), max(t["end_tick"] for t in targets))
            steamid = target["steamid64"] or str((start_row or {}).get("steamid") or "")
            if not steamid.isdigit() or not steamid.startswith("7656") or len(steamid) != 17:
                raise ValueError(f"OBS 玩家 {label} 缺少可核验的 SteamID")
            # OBS settles at the cut start before it starts capturing. A body
            # timeline must cover the whole cut, including later takeover/death.
            segment = SimpleNamespace(label=label, target_xuid=steamid,
                                      start_tick=start_tick, end_tick=target["end_tick"])
            # Select the earliest live snapshot by SteamID, then run the full
            # strict timeline/serial checks from that actual recording start.
            # Missing prefix snapshots must not weaken checks on captured ticks.
            changes = defaultdict(list)
            for entry in report["rows"]:
                changes[int(entry["tick"])].append(entry)
            current = {}
            for tick in sorted(set(changes) | {start_tick}):
                for entry in changes.get(tick, []):
                    current[int(entry["slot"])] = entry
                if not start_tick <= tick < target["end_tick"]:
                    continue
                candidate = _identity(list(current.values()), "", steamid)
                if candidate and candidate.get("alive") and candidate.get("valid") and candidate.get("bodyKnown"):
                    start_tick = tick
                    segment.start_tick = tick
                    start_row, start = checked_body(by_tick[tick], target)
                    break
            timeline = takeover_timeline(report, segment, start_tick, strict_identity=True)
            if not timeline or not timeline[0]["pawn"]:
                raise ValueError(f"OBS tick {start_tick} 玩家 {label} 没有可核验的存活身体")
            first = timeline[0]
            if start is not None and not first["takeover"] and start != (first["slot"], first["pawn"]):
                raise ValueError(f"OBS tick {start_tick} 玩家控制器与身体时间线不一致")
            resolved.append({"slot": first["slot"], "pawn": first["pawn"], "steamid64": steamid,
                             "start_tick": start_tick, "seek_tick": start_tick, "timeline": timeline})
            continue
        if start is None:
            for tick in available_ticks:
                if target["start_tick"] < tick < target["end_tick"]:
                    candidate_row, candidate = checked_body(by_tick[tick], target)
                    if candidate:
                        start_tick, start_row, start = tick, candidate_row, candidate
                        break
        if start is None:
            raise ValueError(f"OBS 无法在 tick {start_tick} 确认玩家 {label} 的控制器：目标缺失、重名、已死亡或实体关系不一致。")
        steamid = str(start_row.get("steamid") or "")
        if not steamid.isdigit() or not steamid.startswith("7656") or len(steamid) != 17:
            raise ValueError(f"OBS 玩家 {label} 缺少可供 GSI 核验的 SteamID，无法确认录制视角。")
        # If the player is absent/dead in preroll, or reconnects into a different
        # controller, prepare at the verified start instead of selecting a neighbor.
        actual_seek = seek_tick if start_tick == target["start_tick"] and seek and seek[0] == start[0] else start_tick
        resolved.append({"slot": start[0], "pawn": start[1],
                         "steamid64": steamid, "start_tick": start_tick, "seek_tick": actual_seek})
    return resolved


def prepare_obs_plan_targets(plans: list[RecordingPlan], demo_path: Path, *, resolver=None) -> list[RecordingPlan]:
    """Replace only execution-local OBS metadata; shared raw slots stay intact."""
    from ..demo_parse_isolation import resolve_obs_targets_isolated

    copies = [plan.model_copy(deep=True) for plan in plans]
    # An explicitly selected posthumous victim POV is optional. Validate it on
    # its own, so an unavailable victim does not cancel unrelated normal cuts.
    for plan in copies:
        for segment in plan.segments:
            if segment.disabled or not segment.metadata.get("posthumous_kill"):
                continue
            single = plan.model_copy(deep=True)
            single.segments = [segment.model_copy(deep=True)]
            single.segments[0].metadata.pop("posthumous_kill", None)
            try:
                prepared_plan = prepare_obs_plan_targets([single], demo_path, resolver=resolver)[0]
                prepared = prepared_plan.segments[0]
            except (ValueError, RuntimeError) as exc:
                segment.disabled = True
                segment.disabled_reason = "死后击杀受害者视角无法核验"
                plan.warnings.append(f"tick {segment.anchor_ticks}: {segment.disabled_reason}: {exc}")
            else:
                segment.metadata.update(prepared.metadata)
                segment.target_steamid64 = prepared.target_steamid64
                segment.start_tick = prepared.start_tick
                segment.safe_seek_tick = prepared.safe_seek_tick
                plan.warnings.extend(single_warning for single_warning in
                                     prepared_plan.warnings if single_warning not in plan.warnings)
    segments = [(plan, segment) for plan in copies for segment in plan.segments if not segment.disabled]
    segments = [(plan, segment) for plan, segment in segments if not segment.metadata.get("posthumous_kill")]
    targets = [{"name": segment.target_player_name, "steamid64": segment.target_steamid64 or "",
                "start_tick": segment.start_tick, "end_tick": segment.end_tick,
                "seek_tick": obs_prepare_tick(segment, plan.tick_rate)}
               for plan, segment in segments]
    resolved = (resolver or resolve_obs_targets_isolated)(str(demo_path), targets) if targets else []
    if not isinstance(resolved, list) or len(resolved) != len(segments):
        raise ValueError("OBS 玩家控制器解析结果不完整")
    for (plan, segment), target in zip(segments, resolved):
        slot = target.get("slot")
        seek = target.get("seek_tick")
        start = target.get("start_tick", segment.start_tick)
        if (type(slot) is not int or not 1 <= slot <= 64 or type(seek) is not int
                or type(start) is not int or not segment.start_tick <= start < segment.end_tick
                or not 0 <= seek <= start or not target.get("steamid64")):
            raise ValueError("OBS 玩家控制器解析结果无效")
        if start != segment.start_tick:
            message = f"OBS 玩家 {segment.target_player_name} 的录制起点从 tick {segment.start_tick} 调整到首个有效身体 tick {start}"
            plan.warnings.append(message)
            logging.getLogger(__name__).info(message)
            segment.start_tick = start
            segment.safe_seek_tick = seek
        segment.metadata = {key: value for key, value in segment.metadata.items()
                            if key not in {"obs_spec_slot_offset", "obs_body_timeline"}}
        segment.metadata.update({"obs_controller_slot": slot, "obs_controller_pawn": target["pawn"],
                                 "obs_prepare_tick": seek})
        if target.get("timeline"):
            from .obs_observer import validate_timeline
            segment.metadata["obs_body_timeline"] = validate_timeline(
                target["timeline"], segment.start_tick, segment.end_tick, slot, target["pawn"])
        segment.target_steamid64 = target["steamid64"]
    for plan in copies:
        plan.estimated_duration_sec = sum(s.end_tick - s.start_tick for s in plan.segments
                                          if not s.disabled) / plan.tick_rate if plan.tick_rate > 0 else 0.0
    return copies
