from ..models import RecordingSegment
from ..normalizer import NormalizedRequest


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def apply_demo_end_guard(
    segment: RecordingSegment,
    req: NormalizedRequest,
) -> tuple[RecordingSegment, list[str]]:
    """Keep a segment before real demo EOF without special-casing rounds.

    Reaching PBDEMS2 EOF makes CS2 finish playback and return to the main menu.
    This is the only remaining terminal-playback restriction: no scoreboard,
    round-end, panel, or seek ceiling is applied.
    """

    demo_end_tick = int(req.demo.demo_end_tick)
    tick_rate = float(req.demo.tick_rate)
    guard_ticks = max(1, sec_to_ticks(req.options.demo_end_guard_sec, tick_rate))
    safe_end_tick = min(demo_end_tick - guard_ticks, demo_end_tick - 1)
    warnings: list[str] = []

    anchor_ticks = segment.anchor_ticks or []
    max_anchor = max(anchor_ticks) if anchor_ticks else None
    if max_anchor is not None and max_anchor >= safe_end_tick:
        warnings.append(
            f"segment {segment.segment_index}: anchor_too_close_to_demo_end "
            f"(safe_end={safe_end_tick}, max_anchor={max_anchor})"
        )
        return segment.model_copy(update={
            "disabled": True,
            "disabled_reason": "anchor_too_close_to_demo_end",
            "safe_end_tick": safe_end_tick,
        }), warnings

    end_tick = min(segment.end_tick, safe_end_tick)
    if end_tick <= segment.start_tick:
        return segment.model_copy(update={
            "disabled": True,
            "disabled_reason": "too_close_to_demo_end",
            "safe_end_tick": safe_end_tick,
        }), warnings

    return segment.model_copy(update={
        "end_tick": end_tick,
        "safe_end_tick": safe_end_tick,
    }), warnings
