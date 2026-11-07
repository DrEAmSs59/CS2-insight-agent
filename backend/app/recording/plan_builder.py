from __future__ import annotations
from dataclasses import replace
from pathlib import Path

from .models import (
    RecordingRequestDTO, RecordingPlan, RequestType
)
from .normalizer import normalize
from .planners.event_clip_planner import plan_event_clip
from .planners.event_compilation_planner import plan_event_compilation
from .planners.round_pov_planner import plan_round_pov
from .postprocess.segment_postprocessor import postprocess_segments


def build_plan(dto: RecordingRequestDTO) -> RecordingPlan:
    req = normalize(dto)

    extra_warnings: list[str] = list(req.warnings)
    from ..posthumous_kills import read_posthumous_kills_isolated, kills_at_tick
    event_request = req.request_type not in {RequestType.round_compilation, RequestType.timeline_round}
    facts = read_posthumous_kills_isolated(req.demo.demo_path) if event_request and req.events and Path(req.demo.demo_path).is_file() else {}
    flagged = {e.tick: facts[(e.killer.steamid64, e.tick)] for e in req.events
               if (e.killer.steamid64, e.tick) in facts}
    kill_requests = {RequestType.highlight, RequestType.timeline_kill, RequestType.kill_compilation}
    special = [e for e in req.events if e.tick in flagged] if req.request_type in kill_requests else []
    if special:
        req = replace(req, events=[e for e in req.events if e.tick not in flagged])
        for event in special:
            extra_warnings.append(f"tick {event.tick}: 死后击杀，" +
                                  ("单独录制受害者视角" if req.options.posthumous_mode == "victim" else "已跳过本人视角"))

    if special:
        from bisect import bisect_right
        boundaries = sorted({row["attacker_death_tick"] for row in flagged.values()})
        buckets = {}
        for event in req.events:
            buckets.setdefault(bisect_right(boundaries, event.tick), []).append(event)
        raw_segments = [segment for events in buckets.values()
                        for segment in _plan_events(replace(req, events=events))]
    else:
        raw_segments = _plan_events(req) if req.events or req.rounds else []
    extra_warnings.extend(w for w in req.warnings if w not in extra_warnings)
    # Death clips may also request the killer's POV: never select an already-dead killer.
    raw_segments = [s for s in raw_segments if not (
        s.perspective == "killer" and any(t in flagged for t in s.anchor_ticks))]
    # A normal highlight tail must not bleed into the dead-player observer switch.
    for segment in raw_segments:
        if segment.perspective == "killer":
            boundaries = [r["attacker_death_tick"] for r in flagged.values()
                          if segment.start_tick < r["attacker_death_tick"] < segment.end_tick]
            if boundaries:
                segment.end_tick = min(boundaries)
    if req.options.posthumous_mode == "victim":
        for event in special:
            fact = flagged[event.tick]
            candidates = kills_at_tick(fact)
            fact = next((row for row in candidates if row.get("victim_steamid") == event.victim.steamid64), None)
            if fact is None:
                if len(candidates) != 1:
                    extra_warnings.append(f"tick {event.tick}: 无法确定同 tick 死后击杀的受害者，已跳过")
                    continue
                fact = candidates[0]
            victim = event.victim.model_copy(update={
                "name": fact.get("victim_name") or event.victim.name,
                "steamid64": fact.get("victim_steamid") or event.victim.steamid64,
                "spec_slot": event.victim.spec_slot if fact.get("victim_steamid") == event.victim.steamid64 else None,
            })
            option = {RequestType.highlight: "highlight_pre_sec", RequestType.timeline_kill: "timeline_kill_pre_sec",
                      RequestType.kill_compilation: "kill_compilation_pre_sec"}[req.request_type]
            options = req.options.model_copy(update={"death_pre_sec": getattr(req.options, option),
                "death_post_sec": min(req.options.victim_pov_post_sec, 1.5), "enable_fail_killer_pov": False})
            victim_req = replace(req, request_type=RequestType.fail, target_player=victim,
                                 events=[event], options=options)
            for segment in plan_event_clip(victim_req):
                segment.metadata["posthumous_kill"] = True
                raw_segments.append(segment)
    if special:
        raw_segments.sort(key=lambda s:(s.start_tick, s.segment_index))
    active, disabled, all_warnings = postprocess_segments(raw_segments, req, extra_warnings)

    return RecordingPlan(
        request_id=dto.request_id, request_type=dto.request_type, demo_path=dto.demo.demo_path,
        tick_rate=dto.demo.tick_rate, segments=active, disabled_segments=disabled, warnings=all_warnings,
    )


def _plan_events(req):

    EVENT_CLIP_TYPES = {
        RequestType.highlight,
        RequestType.fail,
        RequestType.timeline_kill,
        RequestType.timeline_death,
    }
    EVENT_COMPILATION_TYPES = {
        RequestType.kill_compilation,
        RequestType.death_compilation,
    }
    ROUND_POV_TYPES = {
        RequestType.round_compilation,
        RequestType.timeline_round,
    }

    if req.request_type in EVENT_CLIP_TYPES:
        raw_segments = plan_event_clip(req)
    elif req.request_type in EVENT_COMPILATION_TYPES:
        raw_segments = plan_event_compilation(req)
    elif req.request_type in ROUND_POV_TYPES:
        raw_segments, round_warnings = plan_round_pov(req)
        req.warnings.extend(round_warnings)
    else:
        raise ValueError(f"Unknown request_type: {req.request_type}")
    return raw_segments
