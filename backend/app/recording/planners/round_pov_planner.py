import logging

from ..models import RecordingSegment, SourceType, Perspective, RequestType
from ..normalizer import NormalizedRequest, RoundInfo
from ..platform_utils import platform_slot_offset, compute_voice_listen_mask, compute_voice_listen_mask_enemy

logger = logging.getLogger(__name__)


# Keep the round-result beat visible in round compilations.  ``round_end_tick`` is
# the instant CS2 decides the round (often the same tick as the last kill), not the
# end of the post-round presentation.  This mirrors the 3 s tail used by the round
# timeline path while still being capped before the next round's freeze phase.
_ROUND_COMPILATION_POST_ROUND_END_SEC = 3.0


def sec_to_ticks(sec: float, tick_rate: float) -> int:
    return int(sec * tick_rate)


def plan_round_pov(req: NormalizedRequest) -> tuple[list[RecordingSegment], list[str]]:
    """Returns (segments, additional_warnings) — warnings are merged by plan_builder."""
    segments: list[RecordingSegment] = []
    warnings: list[str] = []

    tick_rate = req.demo.tick_rate
    opts = req.options
    round_freeze_preroll_ticks = sec_to_ticks(opts.round_freeze_preroll_sec, tick_rate)
    _offset = platform_slot_offset(req.demo.demo_filename, req.demo.server_name)
    _mask = compute_voice_listen_mask(req.demo.all_players, req.target_player.steamid64, _offset)
    _mask_enemy = compute_voice_listen_mask_enemy(req.demo.all_players, req.target_player.steamid64, _offset)
    default_freeze_ticks = int(15 * tick_rate)

    # Guard applied to alive-round end boundaries that use next_round_start_tick.
    # next_round_start_tick is the very first tick of the next round's freeze phase.  We must
    # stop the segment well before that tick to avoid capturing a freeze-phase frame.
    #
    # Failure mode without a sufficient guard:
    #   The tick-watcher poll loop checks GSI phase BEFORE the wall-clock estimate.  When a
    #   poll cycle fires slightly late (~100 ms overshoot), the GSI may already report
    #   "freezetime" (demo reached next_round_start_tick) before the wall-clock check runs.
    #   This causes OBS to stop AFTER the demo has entered the next round's freeze phase,
    #   so the last recorded frame shows the buy-phase overlay.
    #
    # Guard budget:
    #   poll_latency ≈ 100 ms  (two poll cycles of 100 ms each to guarantee wall-clock wins)
    #   t0_offset    ≈  50 ms  (demo resumes ~50 ms before t0 is set)
    #   KP-5 → CS2  ≈  16 ms  (key delivery + one game frame for demo to freeze)
    #   Total        ≈ 366 ms  → use 500 ms to have comfortable headroom.
    #
    # Cost: recording ends 0.5 s before the next round's freeze.  The round-end scoreboard
    # is shown for ~5 s (round_end → freeze), so the user still sees ~4.5 s of scoreboard.
    _ALIVE_END_GUARD_SEC = 0.5
    alive_end_guard_ticks = sec_to_ticks(_ALIVE_END_GUARD_SEC, tick_rate)

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

        end_reason: str
        reliable_round_end = (
            round_info.round_end_tick is not None and round_info.round_end_tick_reliable
        )
        is_final_round = (round_info.round == req.demo.final_round)
        is_round_compilation = req.request_type == RequestType.round_compilation
        round_end_post_ticks = sec_to_ticks(
            _ROUND_COMPILATION_POST_ROUND_END_SEC, tick_rate
        )

        # --- Compute end_tick ---
        if round_info.target_death_tick is None:
            # Case A: player alive this round.
            # For round compilations, retain 3 s after a reliable round_end so the
            # final kill/result presentation can finish.  Regardless of the chosen
            # source, cap just before next_round_start_tick so OBS latency cannot
            # capture the following freeze frame.
            # Priority: reliable round_end_tick (+ compilation tail)
            #            → next_round_start_tick - guard
            #            → next_round_freeze_start_tick → demo_end
            if reliable_round_end:
                end_tick = round_info.round_end_tick  # type: ignore[assignment]
                end_reason = "round_end"
                if is_round_compilation and not is_final_round:
                    end_tick += round_end_post_ticks
                    end_reason = "round_end_post"
            elif round_info.next_round_start_tick is not None:
                end_tick = round_info.next_round_start_tick - alive_end_guard_ticks
                end_reason = "fallback_next_round_start"
            elif round_info.next_round_freeze_start_tick is not None:
                end_tick = round_info.next_round_freeze_start_tick - alive_end_guard_ticks
                end_reason = "fallback_next_round_freeze_start"
            else:
                end_tick = req.demo.demo_end_tick
                end_reason = "fallback_demo_end"

            # Clamp to next_round_start_tick - guard to avoid recording into the next round's
            # freeze / buy phase.
            if round_info.next_round_start_tick is not None:
                alive_end_cap = round_info.next_round_start_tick - alive_end_guard_ticks
                if end_tick > alive_end_cap:
                    end_tick = alive_end_cap
                    end_reason = "round_end_clamped_to_next_round_start"
        else:
            # Case B: player died this round.
            death_post_ticks = sec_to_ticks(opts.round_death_post_sec, tick_rate)
            end_tick = round_info.target_death_tick + death_post_ticks
            end_reason = "target_death_post"

            # A round-ending death can share the same tick as round_end.  Round
            # compilations must retain the configured death tail instead of clamping
            # it away at that instant.  The 3 s post-round ceiling and next-round cap
            # below still prevent footage from spilling into the following round.
            if reliable_round_end and end_tick > round_info.round_end_tick:  # type: ignore[operator]
                if is_round_compilation:
                    post_round_cap = round_info.round_end_tick + round_end_post_ticks  # type: ignore[operator]
                    if end_tick > post_round_cap:
                        end_tick = post_round_cap
                        end_reason = "target_death_post_clamped_to_round_end_post"
                else:
                    end_tick = round_info.round_end_tick  # type: ignore[assignment]
                    end_reason = "target_death_post_clamped_to_round_end"

            # Always clamp before next_round_start_tick.  For compilations, keep the
            # same 0.5 s safety margin as alive rounds so poll/OBS latency cannot leak
            # a buy-phase frame into the output.
            if round_info.next_round_start_tick is not None:
                next_round_cap = round_info.next_round_start_tick
                if is_round_compilation:
                    next_round_cap -= alive_end_guard_ticks
                if end_tick > next_round_cap:
                    end_tick = next_round_cap
                    end_reason = "target_death_post_clamped_to_next_round_start"

        # Final round where the target SURVIVED: extend past round_end into the
        # post-round so the match-winning moment / scoreboard beat doesn't cut
        # abruptly. A mid-round death keeps its fixed death+post tail (no extra) —
        # spectating-after-death footage isn't worth lingering on. The demo_end_tick
        # clamp below and the final_round_guard bound this to the real demo end.
        if (
            is_final_round
            and round_info.target_death_tick is None
            and opts.final_round_extra_post_sec > 0
        ):
            end_tick = end_tick + sec_to_ticks(opts.final_round_extra_post_sec, tick_rate)
            end_reason = f"{end_reason}+final_round_alive_extra"

        # Final clamp to demo_end_tick
        end_tick = min(end_tick, req.demo.demo_end_tick)

        logger.info(
            "[RecordingV3][RoundPlan] round=%d start=%d end=%d end_reason=%s",
            round_info.round, start_tick, end_tick, end_reason,
        )

        segment = RecordingSegment(
            segment_index=segment_index,
            source_type=SourceType.round,
            start_tick=start_tick,
            end_tick=end_tick,
            anchor_ticks=[],
            round=round_info.round,
            target_player_name=req.target_player.name,
            target_steamid64=req.target_player.steamid64,
            target_spec_slot=req.target_player.spec_slot,
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
                "next_round_freeze_end_tick": round_info.next_round_freeze_end_tick,
                "target_death_tick": round_info.target_death_tick,
                "end_reason": end_reason,
            },
            voice_listen_mask=_mask,
            voice_listen_mask_enemy=_mask_enemy,
        )
        segments.append(segment)

    return segments, warnings
