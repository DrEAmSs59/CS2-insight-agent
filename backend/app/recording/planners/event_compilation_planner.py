from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest


def plan_event_compilation(req: NormalizedRequest) -> list[RecordingSegment]:
    if req.request_type == RequestType.kill_compilation:
        return _plan_kill_compilation(req)
    elif req.request_type == RequestType.death_compilation:
        return _plan_death_compilation(req)
    else:
        raise ValueError(f"Unsupported request_type: {req.request_type}")


def _plan_kill_compilation(req: NormalizedRequest) -> list[RecordingSegment]:
    tick_rate = req.demo.tick_rate
    opts = req.options

    pre_ticks = int(opts.kill_compilation_pre_sec * tick_rate)
    post_ticks = int(opts.kill_compilation_post_sec * tick_rate)
    threshold_ticks = int(opts.kill_compilation_jump_cut_threshold_sec * tick_rate)

    first_tick = req.demo.first_tick
    demo_end_tick = req.demo.demo_end_tick

    # Sort events by (round, tick) ascending
    sorted_events = sorted(req.events, key=lambda e: (e.round, e.tick))

    # Group events into merge groups
    groups: list[list] = []
    current_group: list = []

    for event in sorted_events:
        if not current_group:
            current_group.append(event)
            continue

        prev = current_group[-1]

        # Merge only if same round, same target_player steamid64, same perspective,
        # and gap <= threshold
        gap = event.tick - prev.tick
        same_round = event.round == prev.round
        same_target = event.target_player.steamid64 == prev.target_player.steamid64
        same_perspective = event.perspective == prev.perspective

        if same_round and same_target and same_perspective and gap <= threshold_ticks:
            current_group.append(event)
        else:
            groups.append(current_group)
            current_group = [event]

    if current_group:
        groups.append(current_group)

    segments: list[RecordingSegment] = []
    for idx, group in enumerate(groups):
        start_tick = group[0].tick - pre_ticks
        end_tick = group[-1].tick + post_ticks

        # Clamp to demo bounds
        start_tick = max(start_tick, first_tick)
        end_tick = min(end_tick, demo_end_tick)

        anchor_ticks = [e.tick for e in group]
        rep_event = group[0]

        segments.append(
            RecordingSegment(
                segment_index=idx,
                source_type=SourceType.kill,
                start_tick=start_tick,
                end_tick=end_tick,
                anchor_ticks=anchor_ticks,
                round=rep_event.round,
                target_player_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                perspective=Perspective.killer,
                is_final_round=(rep_event.round == req.demo.final_round),
                safe_seek_tick=start_tick,
                safe_end_tick=None,
                disabled=False,
                disabled_reason=None,
                metadata={},
            )
        )

    return segments


def _plan_death_compilation(req: NormalizedRequest) -> list[RecordingSegment]:
    tick_rate = req.demo.tick_rate
    opts = req.options

    pre_ticks = int(opts.death_compilation_pre_sec * tick_rate)
    post_ticks = int(opts.death_compilation_post_sec * tick_rate)
    merge_gap_ticks = int(opts.death_compilation_merge_gap_sec * tick_rate)

    first_tick = req.demo.first_tick
    demo_end_tick = req.demo.demo_end_tick

    # Sort events by (round, tick) ascending
    sorted_events = sorted(req.events, key=lambda e: (e.round, e.tick))

    # Build (event, window_start, window_end) tuples
    windowed = [
        (event, event.tick - pre_ticks, event.tick + post_ticks)
        for event in sorted_events
    ]

    # Merge windows by round, overlap or gap <= merge_gap_ticks
    groups: list[list[tuple]] = []  # each group is list of (event, win_start, win_end)
    current_group: list[tuple] = []

    for item in windowed:
        event, win_start, win_end = item
        if not current_group:
            current_group.append(item)
            continue

        prev_event, _, prev_win_end = current_group[-1]

        same_round = event.round == prev_event.round
        # Merge if same round and (windows overlap OR gap <= merge_gap_ticks)
        gap = win_start - prev_win_end

        if same_round and gap <= merge_gap_ticks:
            current_group.append(item)
        else:
            groups.append(current_group)
            current_group = [item]

    if current_group:
        groups.append(current_group)

    segments: list[RecordingSegment] = []
    for idx, group in enumerate(groups):
        win_starts = [item[1] for item in group]
        win_ends = [item[2] for item in group]

        start_tick = min(win_starts)
        end_tick = max(win_ends)

        # Clamp to demo bounds
        start_tick = max(start_tick, first_tick)
        end_tick = min(end_tick, demo_end_tick)

        anchor_ticks = [item[0].tick for item in group]
        rep_event = group[0][0]

        segments.append(
            RecordingSegment(
                segment_index=idx,
                source_type=SourceType.death,
                start_tick=start_tick,
                end_tick=end_tick,
                anchor_ticks=anchor_ticks,
                round=rep_event.round,
                target_player_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                perspective=Perspective.victim,
                is_final_round=(rep_event.round == req.demo.final_round),
                safe_seek_tick=start_tick,
                safe_end_tick=None,
                disabled=False,
                disabled_reason=None,
                metadata={},
            )
        )

    return segments
