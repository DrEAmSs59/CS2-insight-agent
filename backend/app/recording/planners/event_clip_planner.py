from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def plan_event_clip(req: NormalizedRequest) -> list[RecordingSegment]:
    rt = req.request_type
    if rt == RequestType.highlight:
        return _plan_highlight(req)
    elif rt == RequestType.fail:
        return _plan_fail(req)
    elif rt == RequestType.timeline_kill:
        return _plan_timeline_kill(req)
    elif rt == RequestType.timeline_death:
        return _plan_timeline_death(req)
    else:
        raise ValueError(f"plan_event_clip does not handle request_type={rt!r}")


def _clamp(start_tick: int, end_tick: int, req: NormalizedRequest) -> tuple[int, int]:
    start_tick = max(start_tick, req.demo.first_tick)
    end_tick = min(end_tick, req.demo.demo_end_tick)
    return start_tick, end_tick


def _is_final_round(event_round: int, req: NormalizedRequest) -> bool:
    try:
        return event_round == req.demo.final_round
    except Exception:
        return False


def _plan_highlight(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate

    pre_ticks = sec_to_ticks(opts.highlight_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.highlight_post_sec, tick_rate)
    threshold_ticks = sec_to_ticks(opts.kill_jump_cut_threshold_sec, tick_rate)

    sorted_events = sorted(req.events, key=lambda e: e.tick)

    # Group events by jump-cut threshold
    groups: list[list] = []
    current_group: list = []
    for event in sorted_events:
        if not current_group:
            current_group.append(event)
        else:
            gap = event.tick - current_group[-1].tick
            if gap <= threshold_ticks:
                current_group.append(event)
            else:
                groups.append(current_group)
                current_group = [event]
    if current_group:
        groups.append(current_group)

    segments: list[RecordingSegment] = []
    seg_idx = 0

    for group in groups:
        start_tick = group[0].tick - pre_ticks
        end_tick = group[-1].tick + post_ticks
        start_tick, end_tick = _clamp(start_tick, end_tick, req)

        anchor_ticks = [e.tick for e in group]
        first_event = group[0]

        seg = RecordingSegment(
            segment_index=seg_idx,
            source_type=SourceType.kill,
            start_tick=start_tick,
            end_tick=end_tick,
            anchor_ticks=anchor_ticks,
            round=first_event.round,
            target_player_name=req.target_player.name,
            target_steamid64=req.target_player.steamid64,
            perspective=Perspective.killer,
            is_final_round=_is_final_round(first_event.round, req),
            safe_seek_tick=start_tick,
            safe_end_tick=None,
            disabled=False,
            disabled_reason=None,
            metadata={},
        )
        segments.append(seg)
        seg_idx += 1

        # Victim POV: one segment per kill event regardless of group size
        if opts.enable_victim_pov:
            for victim_event in group:
                v_start = victim_event.tick - pre_ticks
                v_end = victim_event.tick + post_ticks
                v_start, v_end = _clamp(v_start, v_end, req)

                victim_seg = RecordingSegment(
                    segment_index=seg_idx,
                    source_type=SourceType.kill,
                    start_tick=v_start,
                    end_tick=v_end,
                    anchor_ticks=[victim_event.tick],
                    round=victim_event.round,
                    target_player_name=victim_event.victim.name,
                    target_steamid64=victim_event.victim.steamid64,
                    perspective=Perspective.victim,
                    is_final_round=_is_final_round(victim_event.round, req),
                    safe_seek_tick=v_start,
                    safe_end_tick=None,
                    disabled=False,
                    disabled_reason=None,
                    metadata={},
                )
                segments.append(victim_seg)
                seg_idx += 1

    return segments


def _plan_fail(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate

    pre_ticks = sec_to_ticks(opts.death_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.death_post_sec, tick_rate)

    event = req.events[0]
    start_tick = event.tick - pre_ticks
    end_tick = event.tick + post_ticks
    start_tick, end_tick = _clamp(start_tick, end_tick, req)

    seg = RecordingSegment(
        segment_index=0,
        source_type=SourceType.death,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=[event.tick],
        round=event.round,
        target_player_name=req.target_player.name,
        target_steamid64=req.target_player.steamid64,
        perspective=Perspective.victim,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=start_tick,
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
    )
    return [seg]


def _plan_timeline_kill(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate

    pre_ticks = sec_to_ticks(opts.timeline_kill_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.timeline_kill_post_sec, tick_rate)

    event = req.events[0]
    start_tick = event.tick - pre_ticks
    end_tick = event.tick + post_ticks
    start_tick, end_tick = _clamp(start_tick, end_tick, req)

    seg = RecordingSegment(
        segment_index=0,
        source_type=SourceType.kill,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=[event.tick],
        round=event.round,
        target_player_name=req.target_player.name,
        target_steamid64=req.target_player.steamid64,
        perspective=Perspective.killer,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=start_tick,
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
    )
    return [seg]


def _plan_timeline_death(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate

    pre_ticks = sec_to_ticks(opts.death_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.death_post_sec, tick_rate)

    event = req.events[0]
    start_tick = event.tick - pre_ticks
    end_tick = event.tick + post_ticks
    start_tick, end_tick = _clamp(start_tick, end_tick, req)

    seg = RecordingSegment(
        segment_index=0,
        source_type=SourceType.death,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=[event.tick],
        round=event.round,
        target_player_name=req.target_player.name,
        target_steamid64=req.target_player.steamid64,
        perspective=Perspective.victim,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=start_tick,
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
    )
    return [seg]
