from ..models import RecordingSegment, SourceType
from ..normalizer import NormalizedRequest

_EVENT_SOURCE_TYPES = {SourceType.kill, SourceType.death}


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def apply_final_round_guard(
    segment: RecordingSegment,
    req: NormalizedRequest,
) -> tuple[RecordingSegment, list[str]]:
    if not segment.is_final_round:
        return segment, []

    options = req.options
    tick_rate = req.demo.tick_rate
    warnings: list[str] = []

    guard_ticks = sec_to_ticks(options.final_round_guard_sec, tick_rate)
    seek_guard_ticks = sec_to_ticks(options.final_round_seek_guard_sec, tick_rate)

    # Compute safe_end_tick (the last tick before the scoreboard/end-of-demo noise)
    if req.demo.final_round_end_tick and req.demo.final_round_end_tick > 0:
        safe_end_tick = req.demo.final_round_end_tick - guard_ticks
    else:
        safe_end_tick = req.demo.demo_end_tick - guard_ticks

    is_event_type = segment.source_type in _EVENT_SOURCE_TYPES
    anchor_ticks = segment.anchor_ticks or []

    if is_event_type and anchor_ticks:
        max_anchor = max(anchor_ticks)
        if safe_end_tick < max_anchor:
            # Guard would cut before the last anchor — skip clamping, use demo_end_tick as hard limit
            end_tick = min(segment.end_tick, req.demo.demo_end_tick)
            warnings.append(
                f"segment {segment.segment_index}: final_round_guard_skipped_because_anchor_inside_guard "
                f"(safe_end={safe_end_tick}, max_anchor={max_anchor})"
            )
            # No pre-roll seek needed when guard is skipped
            updated = segment.model_copy(update={
                "end_tick": end_tick,
                "safe_seek_tick": segment.start_tick,
                "safe_end_tick": safe_end_tick,
            })
            _check_min_duration(updated, options, tick_rate, warnings)
            if not updated.disabled and updated.end_tick - updated.start_tick <= 0:
                updated = updated.model_copy(update={
                    "disabled": True,
                    "disabled_reason": "zero_or_negative_duration_after_guard",
                })
            return updated, warnings
        else:
            # Guard does not reach the anchor — clamp post but anchor is preserved
            end_tick = min(segment.end_tick, safe_end_tick)
            if end_tick < segment.end_tick:
                warnings.append(
                    f"segment {segment.segment_index}: final_round_post_truncated_but_anchor_preserved "
                    f"(safe_end={safe_end_tick}, max_anchor={max_anchor})"
                )
    else:
        # Round-type segments: always clamp to safe_end_tick
        end_tick = min(segment.end_tick, safe_end_tick)

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


def _check_min_duration(
    segment: RecordingSegment,
    options,
    tick_rate: float,
    warnings: list[str],
) -> None:
    pass
