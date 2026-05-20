from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest
from ..platform_utils import platform_slot_offset, compute_voice_listen_mask


def _voice_mask(req: NormalizedRequest) -> "int | None":
    offset = platform_slot_offset(req.demo.demo_filename, req.demo.server_name)
    return compute_voice_listen_mask(req.demo.all_players, req.target_player.steamid64, offset)

# Seconds seeked before each segment's start_tick to absorb spec_player / GSI-verify overhead
# without consuming the user-configured highlight_pre_sec recording window.
PREPARE_PREROLL_SEC: float = 5.0


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


def _prepare_seek_tick(start_tick: int, tick_rate: float, first_tick: int) -> int:
    """Seek 5 s before start_tick so spec_player / GSI-verify don't consume pre-roll."""
    prepare_ticks = sec_to_ticks(PREPARE_PREROLL_SEC, tick_rate)
    return max(first_tick, start_tick - prepare_ticks)


def _plan_highlight(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    first_tick = req.demo.first_tick
    _mask = _voice_mask(req)

    pre_ticks = sec_to_ticks(opts.highlight_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.highlight_post_sec, tick_rate)
    threshold_ticks = sec_to_ticks(opts.kill_jump_cut_threshold_sec, tick_rate)

    # Victim POV independent timing — fall back to killer pre/post if not set.
    vic_pre_sec = opts.victim_pov_pre_sec if opts.victim_pov_pre_sec is not None else opts.highlight_pre_sec
    vic_post_sec = opts.victim_pov_post_sec
    vic_pre_ticks = sec_to_ticks(vic_pre_sec, tick_rate)
    vic_post_ticks = sec_to_ticks(vic_post_sec, tick_rate)

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

    # ── Phase 1: all killer-POV groups ───────────────────────────────────────
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
            target_spec_slot=req.target_player.spec_slot,
            perspective=Perspective.killer,
            is_final_round=_is_final_round(first_event.round, req),
            safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
            safe_end_tick=None,
            disabled=False,
            disabled_reason=None,
            metadata={},
            voice_listen_mask=_mask,
        )
        segments.append(seg)
        seg_idx += 1

    # ── Phase 2: all victim-POV segments (in original kill-event order) ───────
    if opts.enable_victim_pov:
        for victim_event in sorted_events:
            v_start = victim_event.tick - vic_pre_ticks
            v_end = victim_event.tick + vic_post_ticks
            v_start, v_end = _clamp(v_start, v_end, req)
            victim_steamid64 = (victim_event.victim.steamid64 or "").strip()
            victim_disabled = not victim_steamid64
            victim_disabled_reason = "missing_victim_steamid64" if victim_disabled else None

            victim_seg = RecordingSegment(
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
                is_final_round=_is_final_round(victim_event.round, req),
                safe_seek_tick=_prepare_seek_tick(v_start, tick_rate, first_tick),
                safe_end_tick=None,
                disabled=victim_disabled,
                disabled_reason=victim_disabled_reason,
                metadata={},
                voice_listen_mask=_mask,
            )
            segments.append(victim_seg)
            seg_idx += 1

    return segments


def _plan_fail(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    first_tick = req.demo.first_tick
    _mask = _voice_mask(req)

    pre_ticks = sec_to_ticks(opts.death_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.death_post_sec, tick_rate)

    event = req.events[0]
    start_tick = event.tick - pre_ticks
    end_tick = event.tick + post_ticks
    start_tick, end_tick = _clamp(start_tick, end_tick, req)

    segments: list[RecordingSegment] = []

    seg = RecordingSegment(
        segment_index=0,
        source_type=SourceType.death,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=[event.tick],
        round=event.round,
        target_player_name=req.target_player.name,
        target_steamid64=req.target_player.steamid64,
        target_spec_slot=req.target_player.spec_slot,
        perspective=Perspective.victim,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
        voice_listen_mask=_mask,
    )
    segments.append(seg)

    # ── Optional killer POV segment ──────────────────────────────────────────
    if opts.enable_fail_killer_pov:
        killer = event.killer
        killer_steamid64 = killer.steamid64 if killer else ""

        if not killer_steamid64:
            k_start = event.tick - sec_to_ticks(opts.fail_killer_pre_sec, tick_rate)
            k_end = event.tick + sec_to_ticks(opts.fail_killer_post_sec, tick_rate)
            k_start, k_end = _clamp(k_start, k_end, req)
            killer_seg = RecordingSegment(
                segment_index=1,
                source_type=SourceType.death,
                start_tick=k_start,
                end_tick=k_end,
                anchor_ticks=[event.tick],
                round=event.round,
                target_player_name=killer.name if killer else "",
                target_steamid64="",
                target_spec_slot=None,
                perspective=Perspective.killer,
                is_final_round=_is_final_round(event.round, req),
                safe_seek_tick=_prepare_seek_tick(k_start, tick_rate, first_tick),
                safe_end_tick=None,
                disabled=True,
                disabled_reason="missing_killer_steamid64",
                metadata={},
                voice_listen_mask=_mask,
            )
        else:
            k_start = event.tick - sec_to_ticks(opts.fail_killer_pre_sec, tick_rate)
            k_end = event.tick + sec_to_ticks(opts.fail_killer_post_sec, tick_rate)
            k_start, k_end = _clamp(k_start, k_end, req)
            killer_seg = RecordingSegment(
                segment_index=1,
                source_type=SourceType.death,
                start_tick=k_start,
                end_tick=k_end,
                anchor_ticks=[event.tick],
                round=event.round,
                target_player_name=killer.name if killer else "",
                target_steamid64=killer_steamid64,
                target_spec_slot=killer.spec_slot if killer else None,
                perspective=Perspective.killer,
                is_final_round=_is_final_round(event.round, req),
                safe_seek_tick=_prepare_seek_tick(k_start, tick_rate, first_tick),
                safe_end_tick=None,
                disabled=False,
                disabled_reason=None,
                metadata={},
                voice_listen_mask=_mask,
            )
        segments.append(killer_seg)

    return segments


def _plan_timeline_kill(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    first_tick = req.demo.first_tick
    _mask = _voice_mask(req)

    pre_ticks = sec_to_ticks(opts.timeline_kill_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.timeline_kill_post_sec, tick_rate)

    vic_pre_sec = opts.victim_pov_pre_sec if opts.victim_pov_pre_sec is not None else opts.timeline_kill_pre_sec
    vic_post_sec = opts.victim_pov_post_sec
    vic_pre_ticks = sec_to_ticks(vic_pre_sec, tick_rate)
    vic_post_ticks = sec_to_ticks(vic_post_sec, tick_rate)

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
        target_spec_slot=req.target_player.spec_slot,
        perspective=Perspective.killer,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
        voice_listen_mask=_mask,
    )
    segments = [seg]

    # ── Optional victim POV segment ──────────────────────────────────────────
    if opts.enable_victim_pov:
        victim = event.victim
        victim_steamid64 = (victim.steamid64 or "").strip() if victim else ""
        victim_disabled = not victim_steamid64
        victim_disabled_reason = "missing_victim_steamid64" if victim_disabled else None

        v_start = event.tick - vic_pre_ticks
        v_end = event.tick + vic_post_ticks
        v_start, v_end = _clamp(v_start, v_end, req)

        victim_seg = RecordingSegment(
            segment_index=1,
            source_type=SourceType.kill,
            start_tick=v_start,
            end_tick=v_end,
            anchor_ticks=[event.tick],
            round=event.round,
            target_player_name=victim.name if victim else "",
            target_steamid64=victim_steamid64,
            target_spec_slot=victim.spec_slot if victim else None,
            perspective=Perspective.victim,
            is_final_round=_is_final_round(event.round, req),
            safe_seek_tick=_prepare_seek_tick(v_start, tick_rate, first_tick),
            safe_end_tick=None,
            disabled=victim_disabled,
            disabled_reason=victim_disabled_reason,
            metadata={},
            voice_listen_mask=_mask,
        )
        segments.append(victim_seg)

    return segments


def _plan_timeline_death(req: NormalizedRequest) -> list[RecordingSegment]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    first_tick = req.demo.first_tick
    _mask = _voice_mask(req)

    pre_ticks = sec_to_ticks(opts.fail_killer_pre_sec, tick_rate)
    post_ticks = sec_to_ticks(opts.fail_killer_post_sec, tick_rate)

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
        target_spec_slot=req.target_player.spec_slot,
        perspective=Perspective.victim,
        is_final_round=_is_final_round(event.round, req),
        safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
        safe_end_tick=None,
        disabled=False,
        disabled_reason=None,
        metadata={},
        voice_listen_mask=_mask,
    )
    segments = [seg]

    # ── Optional killer POV segment ──────────────────────────────────────────
    if opts.enable_fail_killer_pov:
        killer = event.killer
        killer_steamid64 = (killer.steamid64 or "").strip() if killer else ""
        killer_disabled = not killer_steamid64
        killer_disabled_reason = "missing_killer_steamid64" if killer_disabled else None

        k_start = event.tick - sec_to_ticks(opts.fail_killer_pre_sec, tick_rate)
        k_end = event.tick + sec_to_ticks(opts.fail_killer_post_sec, tick_rate)
        k_start, k_end = _clamp(k_start, k_end, req)

        killer_seg = RecordingSegment(
            segment_index=1,
            source_type=SourceType.death,
            start_tick=k_start,
            end_tick=k_end,
            anchor_ticks=[event.tick],
            round=event.round,
            target_player_name=killer.name if killer else "",
            target_steamid64=killer_steamid64,
            target_spec_slot=killer.spec_slot if killer else None,
            perspective=Perspective.killer,
            is_final_round=_is_final_round(event.round, req),
            safe_seek_tick=_prepare_seek_tick(k_start, tick_rate, first_tick),
            safe_end_tick=None,
            disabled=killer_disabled,
            disabled_reason=killer_disabled_reason,
            metadata={},
            voice_listen_mask=_mask,
        )
        segments.append(killer_seg)

    return segments
