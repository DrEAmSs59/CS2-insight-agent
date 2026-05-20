from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest
from .event_clip_planner import PREPARE_PREROLL_SEC, _prepare_seek_tick, _voice_mask


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
    _mask = _voice_mask(req)

    pre_ticks = int(opts.kill_compilation_pre_sec * tick_rate)
    post_ticks = int(opts.kill_compilation_post_sec * tick_rate)
    threshold_ticks = int(opts.kill_compilation_jump_cut_threshold_sec * tick_rate)

    first_tick = req.demo.first_tick
    demo_end_tick = req.demo.demo_end_tick

    # Victim POV independent timing — fall back to kill_compilation_pre/post if not set.
    vic_pre_sec = opts.victim_pov_pre_sec if opts.victim_pov_pre_sec is not None else opts.kill_compilation_pre_sec
    vic_post_sec = opts.victim_pov_post_sec
    vic_pre_ticks = int(vic_pre_sec * tick_rate)
    vic_post_ticks = int(vic_post_sec * tick_rate)

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
    seg_idx = 0

    # ── Phase 1: all killer-POV groups ───────────────────────────────────────
    for group in groups:
        start_tick = group[0].tick - pre_ticks
        end_tick = group[-1].tick + post_ticks
        start_tick = max(start_tick, first_tick)
        end_tick = min(end_tick, demo_end_tick)

        anchor_ticks = [e.tick for e in group]
        rep_event = group[0]

        segments.append(
            RecordingSegment(
                segment_index=seg_idx,
                source_type=SourceType.kill,
                start_tick=start_tick,
                end_tick=end_tick,
                anchor_ticks=anchor_ticks,
                round=rep_event.round,
                target_player_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                target_spec_slot=req.target_player.spec_slot,
                perspective=Perspective.killer,
                is_final_round=(rep_event.round == req.demo.final_round),
                safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
                safe_end_tick=None,
                disabled=False,
                disabled_reason=None,
                metadata={},
                voice_listen_mask=_mask,
            )
        )
        seg_idx += 1

    # ── Phase 2: all victim-POV segments (in original kill-event order) ───────
    if opts.enable_victim_pov:
        for victim_event in sorted_events:
            v_start = max(victim_event.tick - vic_pre_ticks, first_tick)
            v_end = min(victim_event.tick + vic_post_ticks, demo_end_tick)
            victim_steamid64 = (victim_event.victim.steamid64 or "").strip()
            victim_disabled = not victim_steamid64
            victim_disabled_reason = "missing_victim_steamid64" if victim_disabled else None

            segments.append(
                RecordingSegment(
                    segment_index=seg_idx,
                    source_type=SourceType.kill,
                    start_tick=v_start,
                    end_tick=v_end,
                    anchor_ticks=[victim_event.tick],
                    round=victim_event.round,
                    target_player_name=victim_event.victim.name,
                    target_steamid64=victim_steamid64,
                    target_spec_slot=victim_event.victim.spec_slot,
                    perspective=Perspective.victim,
                    is_final_round=(victim_event.round == req.demo.final_round),
                    safe_seek_tick=_prepare_seek_tick(v_start, tick_rate, first_tick),
                    safe_end_tick=None,
                    disabled=victim_disabled,
                    disabled_reason=victim_disabled_reason,
                    metadata={},
                    voice_listen_mask=_mask,
                )
            )
            seg_idx += 1

    return segments


def _plan_death_compilation(req: NormalizedRequest) -> list[RecordingSegment]:
    tick_rate = req.demo.tick_rate
    opts = req.options
    _mask = _voice_mask(req)

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
    seg_idx = 0

    # ── Phase 1: all victim-POV groups (target player's death perspective) ────
    for group in groups:
        win_starts = [item[1] for item in group]
        win_ends = [item[2] for item in group]

        start_tick = max(min(win_starts), first_tick)
        end_tick = min(max(win_ends), demo_end_tick)

        anchor_ticks = [item[0].tick for item in group]
        rep_event = group[0][0]

        segments.append(
            RecordingSegment(
                segment_index=seg_idx,
                source_type=SourceType.death,
                start_tick=start_tick,
                end_tick=end_tick,
                anchor_ticks=anchor_ticks,
                round=rep_event.round,
                target_player_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                target_spec_slot=req.target_player.spec_slot,
                perspective=Perspective.victim,
                is_final_round=(rep_event.round == req.demo.final_round),
                safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
                safe_end_tick=None,
                disabled=False,
                disabled_reason=None,
                metadata={},
                voice_listen_mask=_mask,
            )
        )
        seg_idx += 1

    # ── Phase 2: killer-POV segments (one per death event, in original order) ─
    if opts.enable_fail_killer_pov:
        killer_pre_ticks = int(opts.fail_killer_pre_sec * tick_rate)
        killer_post_ticks = int(opts.fail_killer_post_sec * tick_rate)

        for event in sorted_events:
            k_start = max(event.tick - killer_pre_ticks, first_tick)
            k_end = min(event.tick + killer_post_ticks, demo_end_tick)
            killer_steamid64 = (event.killer.steamid64 or "").strip()
            killer_disabled = not killer_steamid64
            killer_disabled_reason = "missing_killer_steamid64" if killer_disabled else None

            segments.append(
                RecordingSegment(
                    segment_index=seg_idx,
                    source_type=SourceType.death,
                    start_tick=k_start,
                    end_tick=k_end,
                    anchor_ticks=[event.tick],
                    round=event.round,
                    target_player_name=event.killer.name,
                    target_steamid64=killer_steamid64,
                    target_spec_slot=event.killer.spec_slot,
                    perspective=Perspective.killer,
                    is_final_round=(event.round == req.demo.final_round),
                    safe_seek_tick=_prepare_seek_tick(k_start, tick_rate, first_tick),
                    safe_end_tick=None,
                    disabled=killer_disabled,
                    disabled_reason=killer_disabled_reason,
                    metadata={},
                    voice_listen_mask=_mask,
                )
            )
            seg_idx += 1

    return segments
