from ..models import RecordingSegment, SourceType, Perspective
from ..normalizer import NormalizedRequest, RoundInfo


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def plan_round_pov(req: NormalizedRequest) -> tuple[list[RecordingSegment], list[str]]:
    """Returns (segments, additional_warnings) — warnings are merged by plan_builder."""
    segments: list[RecordingSegment] = []
    warnings: list[str] = []

    tick_rate = req.demo.tick_rate
    opts = req.options
    round_freeze_preroll_ticks = sec_to_ticks(opts.round_freeze_preroll_sec, tick_rate)
    default_freeze_ticks = int(15 * tick_rate)

    for segment_index, round_info in enumerate(req.rounds):
        # --- Compute start_tick ---
        if round_info.freeze_end_tick is not None:
            start_tick = round_info.freeze_end_tick - round_freeze_preroll_ticks
        elif round_info.round_start_tick is not None:
            # Fallback 1: round_start_tick + default freeze duration
            start_tick = round_info.round_start_tick + default_freeze_ticks - round_freeze_preroll_ticks
            warnings.append(
                f"round {round_info.round}: freeze_end_tick missing; "
                "used round_start_tick + 15s freeze as fallback for start_tick"
            )
        else:
            # Fallback 2: both freeze_end_tick and round_start_tick are None
            start_tick = req.demo.first_tick
            warnings.append(
                f"round {round_info.round}: both freeze_end_tick and round_start_tick missing, using first_tick as start_tick fallback"
            )

        start_tick = max(start_tick, req.demo.first_tick)

        # --- Compute ceiling tick (next round freeze start or fallbacks) ---
        def _get_ceiling(ri: RoundInfo) -> tuple[int, list[str]]:
            """Return (ceiling_tick, extra_warnings)."""
            ceiling_warnings: list[str] = []
            if ri.next_round_freeze_start_tick is not None:
                return ri.next_round_freeze_start_tick, ceiling_warnings
            if ri.next_round_start_tick is not None:
                ceiling_warnings.append(
                    f"round {ri.round}: next_round_freeze_start_tick missing; "
                    "used next_round_start_tick as ceiling fallback"
                )
                return ri.next_round_start_tick, ceiling_warnings
            if ri.round_end_tick is not None:
                ceiling_warnings.append(
                    f"round {ri.round}: next_round_freeze_start_tick and next_round_start_tick missing; "
                    "used round_end_tick as ceiling fallback"
                )
                return ri.round_end_tick, ceiling_warnings
            # Final fallback
            ceiling_warnings.append(
                f"round {ri.round}: all ceiling tick fields missing; "
                "used demo_end_tick as ceiling fallback"
            )
            return req.demo.demo_end_tick, ceiling_warnings

        # --- Compute end_tick ---
        if round_info.target_death_tick is None:
            # Case A: player did not die this round
            ceiling_tick, ceiling_warnings = _get_ceiling(round_info)
            warnings.extend(ceiling_warnings)
            end_tick = ceiling_tick
        else:
            # Case B: player died this round
            death_post_ticks = sec_to_ticks(opts.round_death_post_sec, tick_rate)
            end_tick = round_info.target_death_tick + death_post_ticks
            # Clamp to ceiling
            ceiling_tick, ceiling_warnings = _get_ceiling(round_info)
            warnings.extend(ceiling_warnings)
            end_tick = min(end_tick, ceiling_tick)

        # Final clamp to demo_end_tick
        end_tick = min(end_tick, req.demo.demo_end_tick)

        is_final_round = (round_info.round == req.demo.final_round)

        segment = RecordingSegment(
            segment_index=segment_index,
            source_type=SourceType.round,
            start_tick=start_tick,
            end_tick=end_tick,
            anchor_ticks=[],
            round=round_info.round,
            target_player_name=req.target_player.name,
            target_steamid64=req.target_player.steamid64,
            perspective=Perspective.round,
            is_final_round=is_final_round,
            safe_seek_tick=start_tick,
            safe_end_tick=None,
            disabled=False,
            disabled_reason=None,
            metadata={},
        )
        segments.append(segment)

    return segments, warnings
