from ..models import RecordingSegment
from ..normalizer import NormalizedRequest


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def apply_final_round_guard(
    segment: RecordingSegment,
    req: NormalizedRequest,
) -> RecordingSegment:
    if not segment.is_final_round:
        return segment

    options = req.options
    tick_rate = req.demo.tick_rate

    guard_ticks = sec_to_ticks(options.final_round_guard_sec, tick_rate)
    seek_guard_ticks = sec_to_ticks(options.final_round_seek_guard_sec, tick_rate)

    # Compute safe_end_tick
    if req.demo.final_round_end_tick and req.demo.final_round_end_tick > 0:
        safe_end_tick = req.demo.final_round_end_tick - guard_ticks
    else:
        safe_end_tick = req.demo.demo_end_tick - guard_ticks

    # Clamp segment end_tick
    end_tick = min(segment.end_tick, safe_end_tick)

    # Compute safe_seek_tick
    latest_safe_seek_tick = safe_end_tick - seek_guard_ticks
    if segment.start_tick <= latest_safe_seek_tick:
        safe_seek_tick = segment.start_tick
    else:
        safe_seek_tick = latest_safe_seek_tick

    # Check if segment is too short
    duration_ticks = end_tick - segment.start_tick
    min_ticks = sec_to_ticks(options.final_round_min_duration_sec, tick_rate)

    if duration_ticks < min_ticks or end_tick <= segment.start_tick:
        return segment.model_copy(update={
            "disabled": True,
            "disabled_reason": "too_close_to_final_round_end",
            "safe_end_tick": safe_end_tick,
        })

    return segment.model_copy(update={
        "end_tick": end_tick,
        "safe_seek_tick": safe_seek_tick,
        "safe_end_tick": safe_end_tick,
    })
