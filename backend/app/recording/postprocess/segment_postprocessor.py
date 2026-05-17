from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest
from .final_round_guard import apply_final_round_guard


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def postprocess_segments(
    segments: list[RecordingSegment],
    req: NormalizedRequest,
    extra_warnings: list[str] | None = None,
) -> tuple[list[RecordingSegment], list[RecordingSegment], list[str]]:
    """Returns (active_segments, disabled_segments, warnings)"""
    warnings: list[str] = list(extra_warnings) if extra_warnings else []

    processed: list[RecordingSegment] = []

    for segment in segments:
        # Step 1: Clamp to demo bounds
        start_tick = max(segment.start_tick, req.demo.first_tick)
        end_tick = min(segment.end_tick, req.demo.demo_end_tick)
        segment = segment.model_copy(update={
            "start_tick": start_tick,
            "end_tick": end_tick,
        })

        # Step 2: Apply FinalRoundGuard (returns tuple[segment, warnings])
        segment, guard_warnings = apply_final_round_guard(segment, req)
        warnings.extend(guard_warnings)

        # Step 3: Warn but do NOT disable victim segments with missing steamid64.
        # spec_player works by player name; verification is skipped when steamid64 is empty,
        # but the perspective switch still happens.
        if (
            not segment.disabled
            and segment.perspective == Perspective.victim
            and not (segment.target_steamid64 or "").strip()
        ):
            warnings.append(
                f"segment {segment.segment_index}: victim segment missing steamid64 for "
                f"{segment.target_player_name!r} — will spectate by name without verification"
            )

        # Step 4: Validate minimum duration (zero or negative)
        if not segment.disabled and segment.end_tick - segment.start_tick <= 0:
            segment = segment.model_copy(update={
                "disabled": True,
                "disabled_reason": "zero_or_negative_duration",
            })

        processed.append(segment)

    # Filter disabled vs active
    active: list[RecordingSegment] = []
    disabled: list[RecordingSegment] = []

    for segment in processed:
        if segment.disabled:
            disabled.append(segment)
        else:
            active.append(segment)

    # Re-number segment_index for active segments only
    renumbered: list[RecordingSegment] = []
    for idx, segment in enumerate(active):
        segment = segment.model_copy(update={"segment_index": idx})
        renumbered.append(segment)

    return renumbered, disabled, warnings
