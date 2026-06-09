from ..models import RecordingSegment, SourceType
from ..normalizer import NormalizedRequest

_EVENT_SOURCE_TYPES = {SourceType.kill, SourceType.death}


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def _apply_win_panel_guard(
    segment: RecordingSegment,
    req: NormalizedRequest,
    win_panel_tick: int,
) -> tuple[RecordingSegment, list[str]]:
    """win_panel 可用时的干净硬天花板：逐段 end_tick = min(end_tick, ceiling)。

    绕开 legacy 的 safe_end_tick(−final_round_guard_sec) / latest_recordable_tick
    逻辑——win_panel 紧贴最后动作，legacy 的大额减法会误砍主段 post 与 POV post 预留。
    """
    options = req.options
    tick_rate = req.demo.tick_rate
    warnings: list[str] = []

    guard_ticks = sec_to_ticks(options.final_round_win_panel_guard_sec, tick_rate)
    ceiling = win_panel_tick - guard_ticks

    anchor_ticks = segment.anchor_ticks or []
    max_anchor = max(anchor_ticks) if anchor_ticks else None

    if max_anchor is not None and ceiling <= max_anchor:
        # 异常 demo：结算界面竟早于/等于锚点。别砍到锚点前，保锚点 +1 tick。
        end_tick = min(segment.end_tick, max(max_anchor + 1, ceiling))
        warnings.append(
            f"segment {segment.segment_index}: win_panel_ceiling_at_or_before_anchor "
            f"(ceiling={ceiling}, max_anchor={max_anchor})"
        )
    else:
        end_tick = min(segment.end_tick, ceiling)

    duration_ticks = end_tick - segment.start_tick
    min_ticks = sec_to_ticks(options.final_round_min_duration_sec, tick_rate)
    if duration_ticks < min_ticks or end_tick <= segment.start_tick:
        return segment.model_copy(update={
            "disabled": True,
            "disabled_reason": "too_close_to_final_round_end",
            "safe_end_tick": ceiling,
        }), warnings

    return segment.model_copy(update={
        "end_tick": end_tick,
        "safe_end_tick": ceiling,
    }), warnings


def apply_final_round_guard(
    segment: RecordingSegment,
    req: NormalizedRequest,
) -> tuple[RecordingSegment, list[str]]:
    if not segment.is_final_round:
        return segment, []

    win_panel_tick = int(getattr(req.demo, "win_panel_match_tick", 0) or 0)
    if win_panel_tick > 0:
        return _apply_win_panel_guard(segment, req, win_panel_tick)

    options = req.options
    tick_rate = req.demo.tick_rate
    demo_end_tick = req.demo.demo_end_tick
    warnings: list[str] = []

    guard_ticks = sec_to_ticks(options.final_round_guard_sec, tick_rate)
    seek_guard_ticks = sec_to_ticks(options.final_round_seek_guard_sec, tick_rate)
    demo_exit_guard_ticks = sec_to_ticks(options.final_round_demo_exit_guard_sec, tick_rate)

    # safe_end_tick: latest tick before scoreboard/noise (based on final_round_end_tick or demo_end_tick)
    if req.demo.final_round_end_tick and req.demo.final_round_end_tick > 0:
        safe_end_tick = req.demo.final_round_end_tick - guard_ticks
    else:
        safe_end_tick = demo_end_tick - guard_ticks

    # latest_recordable_tick: hard cap that prevents CS2 from reaching demo_end and exiting to main menu
    latest_recordable_tick = demo_end_tick - demo_exit_guard_ticks
    # Ensure we never record to demo_end_tick itself
    latest_recordable_tick = min(latest_recordable_tick, demo_end_tick - 1)

    is_event_type = segment.source_type in _EVENT_SOURCE_TYPES
    anchor_ticks = segment.anchor_ticks or []

    if is_event_type and anchor_ticks:
        max_anchor = max(anchor_ticks)
        if safe_end_tick < max_anchor:
            # Guard would cut before the last anchor — skip scoreboard clamp.
            # Use latest_recordable_tick as the upper bound to prevent demo exit.
            warnings.append(
                f"segment {segment.segment_index}: final_round_guard_skipped_because_anchor_inside_guard "
                f"(safe_end={safe_end_tick}, max_anchor={max_anchor})"
            )

            if latest_recordable_tick > max_anchor:
                end_tick = min(segment.end_tick, latest_recordable_tick)
            else:
                # Anchor is so close to demo_end that even demo_exit_guard eats it.
                # Record just past the anchor, capped at demo_end - 1.
                end_tick = min(demo_end_tick - 1, max_anchor + 1)
                warnings.append(
                    f"segment {segment.segment_index}: final_round_anchor_too_close_to_demo_end "
                    f"(max_anchor={max_anchor}, latest_recordable={latest_recordable_tick})"
                )

            # No pre-roll seek needed when guard is skipped
            updated = segment.model_copy(update={
                "end_tick": end_tick,
                "safe_seek_tick": segment.start_tick,
                "safe_end_tick": safe_end_tick,
            })
            if not updated.disabled and updated.end_tick - updated.start_tick <= 0:
                updated = updated.model_copy(update={
                    "disabled": True,
                    "disabled_reason": "zero_or_negative_duration_after_guard",
                })
            return updated, warnings
        else:
            # Anchor inside safe window — clamp post but anchor is preserved.
            end_tick = min(segment.end_tick, safe_end_tick)
            # Also enforce demo_exit_guard
            end_tick = min(end_tick, latest_recordable_tick)
            if end_tick < segment.end_tick:
                warnings.append(
                    f"segment {segment.segment_index}: final_round_post_truncated_but_anchor_preserved "
                    f"(safe_end={safe_end_tick}, max_anchor={max_anchor})"
                )
    else:
        # Round-type segments: clamp to safe_end_tick to stay clear of post-round scoreboard.
        # Exception: if the planner chose round_end_tick as end_tick (recorded in metadata),
        # the segment already ends at the natural round boundary — not in the scoreboard zone.
        # Applying safe_end_tick here would cut INTO the round, so skip the scoreboard guard.
        # Also skip latest_recordable_tick: demo_end_tick may equal round_end_tick when the
        # frontend had no post-round data, so the exit guard would be unnecessarily conservative.
        meta = segment.metadata or {}
        meta_round_end = meta.get("round_end_tick")
        meta_death = meta.get("target_death_tick")
        death_post_ticks = sec_to_ticks(options.round_death_post_sec, tick_rate)
        # A final round the target SURVIVED may deliberately tail past round_end into
        # the post-round (the match-winning beat). Allow that much overshoot before the
        # scoreboard guard kicks in; a death clip gets no such allowance.
        alive_extra_ticks = (
            sec_to_ticks(options.final_round_extra_post_sec, tick_rate)
            if meta_death is None else 0
        )
        if meta_round_end is not None and segment.end_tick <= meta_round_end + alive_extra_ticks:
            end_tick = segment.end_tick
            if alive_extra_ticks > 0:
                # Recorded into the post-round on purpose — still respect the demo-exit guard.
                end_tick = min(end_tick, latest_recordable_tick)
        elif meta_death is not None and segment.end_tick <= int(meta_death) + death_post_ticks:
            # Defense-in-depth for the final round when round_end_tick is unavailable
            # (e.g. demos parsed before round_end_tick was propagated): the planner ended
            # this clip ~death+post while the round is still live, so there is no
            # scoreboard here. Applying the scoreboard guard (safe_end_tick) would cut
            # INTO the death payload — the reported "成片还没死就结束了" bug. Skip it and
            # only honor the demo-exit guard.
            end_tick = min(segment.end_tick, latest_recordable_tick)
            if end_tick < segment.end_tick:
                warnings.append(
                    f"segment {segment.segment_index}: final_round_death_clip_capped_by_demo_exit_guard "
                    f"(death={int(meta_death)}, latest_recordable={latest_recordable_tick})"
                )
        else:
            end_tick = min(segment.end_tick, safe_end_tick)
            end_tick = min(end_tick, latest_recordable_tick)

    # Compute safe_seek_tick
    latest_safe_seek_tick = safe_end_tick - seek_guard_ticks
    if segment.start_tick <= latest_safe_seek_tick:
        safe_seek_tick = segment.start_tick
    else:
        safe_seek_tick = latest_safe_seek_tick

    duration_ticks = end_tick - segment.start_tick
    min_ticks = sec_to_ticks(options.final_round_min_duration_sec, tick_rate)

    if duration_ticks < min_ticks or end_tick <= segment.start_tick:
        return segment.model_copy(update={
            "disabled": True,
            "disabled_reason": "too_close_to_final_round_end",
            "safe_end_tick": safe_end_tick,
        }), warnings

    return segment.model_copy(update={
        "end_tick": end_tick,
        "safe_seek_tick": safe_seek_tick,
        "safe_end_tick": safe_end_tick,
    }), warnings
