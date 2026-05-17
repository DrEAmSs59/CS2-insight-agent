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

    # Sorted round numbers for last-round detection.
    sorted_round_numbers = sorted(ri.round for ri in req.rounds)
    last_selected_round = sorted_round_numbers[-1] if sorted_round_numbers else None

    for segment_index, round_info in enumerate(req.rounds):
        # --- Compute start_tick ---
        if round_info.freeze_end_tick is not None:
            start_tick = round_info.freeze_end_tick - round_freeze_preroll_ticks
        elif round_info.round_start_tick is not None:
            # Fallback: round_start_tick + estimated freeze duration
            start_tick = round_info.round_start_tick + default_freeze_ticks - round_freeze_preroll_ticks
            warnings.append(
                f"round {round_info.round}: freeze_end_tick missing; "
                "used round_start_tick + 15s freeze as fallback for start_tick"
            )
        else:
            start_tick = req.demo.first_tick
            warnings.append(
                f"round {round_info.round}: both freeze_end_tick and round_start_tick missing, "
                "using first_tick as start_tick fallback"
            )

        start_tick = max(start_tick, req.demo.first_tick)

        is_last_selected = round_info.round == last_selected_round
        end_reason: str

        # --- Compute end_tick ---
        if round_info.target_death_tick is None:
            # Case A: player did not die this round.
            # Base end is the round boundary.
            end_tick = round_info.round_end_tick
            end_reason = "round_end"

            # For non-last selected rounds, cap at next_round_start_tick to avoid
            # recording into the next round's freeze screen.
            if not is_last_selected and round_info.next_round_start_tick is not None:
                if end_tick > round_info.next_round_start_tick:
                    end_tick = round_info.next_round_start_tick
                    end_reason = "round_end_clamped_to_next_round_start"
        else:
            # Case B: player died this round.
            death_post_ticks = sec_to_ticks(opts.round_death_post_sec, tick_rate)
            end_tick = round_info.target_death_tick + death_post_ticks
            end_reason = "target_death_post"
            # Clamp to round_end_tick to avoid spilling into the next round's freeze.
            if end_tick > round_info.round_end_tick:
                end_tick = round_info.round_end_tick
                end_reason = "target_death_post_clamped_to_round_end"

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
            metadata={
                "round_start_tick": round_info.round_start_tick,
                "round_end_tick": round_info.round_end_tick,
                "freeze_end_tick": round_info.freeze_end_tick,
                "next_round_start_tick": round_info.next_round_start_tick,
                "next_round_freeze_start_tick": round_info.next_round_freeze_start_tick,
                "target_death_tick": round_info.target_death_tick,
                "end_reason": end_reason,
            },
        )
        segments.append(segment)

    return segments, warnings
