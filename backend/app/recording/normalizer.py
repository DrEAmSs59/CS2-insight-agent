import logging
from dataclasses import dataclass

from .models import (
    RecordingRequestDTO,
    RequestType,
    SourceType,
    DemoContext,
    TargetPlayer,
    EventInfo,
    RoundInfo,
    RecordingOptions,
    SourceRef,
)

logger = logging.getLogger(__name__)


class NormalizationError(Exception):
    pass


@dataclass
class NormalizedRequest:
    request_id: str
    request_type: RequestType
    source_type: SourceType
    demo: DemoContext
    target_player: TargetPlayer
    events: list[EventInfo]
    rounds: list[RoundInfo]
    options: RecordingOptions
    source_ref: SourceRef
    warnings: list[str]


def normalize(dto: RecordingRequestDTO) -> NormalizedRequest:
    warnings = []

    if dto.demo.tick_rate <= 0:
        raise NormalizationError("demo.tick_rate must be > 0")

    if dto.demo.first_tick < 0:
        raise NormalizationError("demo.first_tick must be >= 0")

    if dto.demo.demo_end_tick <= dto.demo.first_tick:
        raise NormalizationError("demo.demo_end_tick must be > demo.first_tick")

    types_needing_events = {
        RequestType.highlight,
        RequestType.fail,
        RequestType.timeline_kill,
        RequestType.timeline_death,
        RequestType.kill_compilation,
        RequestType.death_compilation,
    }
    if dto.request_type in types_needing_events and not dto.events:
        raise NormalizationError(
            f"request_type {dto.request_type.value} requires non-empty events"
        )

    types_needing_rounds = {RequestType.round_compilation, RequestType.timeline_round}
    if dto.request_type in types_needing_rounds and not dto.rounds:
        raise NormalizationError(
            f"request_type {dto.request_type.value} requires non-empty rounds"
        )

    if not dto.target_player.steamid64:
        raise NormalizationError("target_player.steamid64 must be non-empty")

    for option_name in [
        "highlight_pre_sec",
        "highlight_post_sec",
        "kill_jump_cut_threshold_sec",
        "timeline_kill_pre_sec",
        "timeline_kill_post_sec",
        "death_pre_sec",
        "death_post_sec",
        "kill_compilation_pre_sec",
        "kill_compilation_post_sec",
        "kill_compilation_jump_cut_threshold_sec",
        "death_compilation_pre_sec",
        "death_compilation_post_sec",
        "death_compilation_merge_gap_sec",
        "round_freeze_preroll_sec",
        "round_death_post_sec",
        "final_round_guard_sec",
        "final_round_seek_guard_sec",
        "final_round_min_duration_sec",
        "victim_pov_post_sec",
        "fail_killer_pre_sec",
        "fail_killer_post_sec",
    ]:
        value = getattr(dto.options, option_name)
        if value < 0:
            raise NormalizationError(
                f"options.{option_name} must be >= 0, got {value}"
            )

    normalized_rounds: list[RoundInfo] = []
    for round_info in dto.rounds:
        if round_info.freeze_end_tick is None:
            warnings.append(
                f"round {round_info.round}: freeze_end_tick missing, will use fallback"
            )

        nxt_freeze_start = round_info.next_round_freeze_start_tick
        nxt_freeze_end = round_info.next_round_freeze_end_tick
        nxt_start = round_info.next_round_start_tick
        round_end = round_info.round_end_tick
        tick_rate = dto.demo.tick_rate
        round_end_reliable = True

        # Defensive rewrite: next_round_freeze_start_tick was filled with freeze_end_tick
        # when it is larger than next_round_start_tick and freeze_end is absent.
        if (
            nxt_freeze_start is not None
            and nxt_freeze_end is None
            and nxt_start is not None
            and nxt_freeze_start > nxt_start
        ):
            nxt_freeze_end = nxt_freeze_start
            nxt_freeze_start = None
            warnings.append(
                f"round {round_info.round}: round_metadata_next_freeze_start_rewritten_to_freeze_end"
            )

        # Detect unreliable round_end_tick (derived from recording window arithmetic)
        round_end_unreliable_reason: str | None = None
        if round_end is not None and round_info.target_death_tick is None:
            derived_5s = int(5 * tick_rate)
            if nxt_freeze_end is not None and round_end == nxt_freeze_end - derived_5s:
                round_end_reliable = False
                round_end_unreliable_reason = "derived_from_next_freeze_end_minus_5s"
                warnings.append(
                    f"round {round_info.round}: round_end_tick_unreliable_derived_from_next_freeze"
                )
            elif nxt_start is not None and round_end > nxt_start:
                round_end_reliable = False
                round_end_unreliable_reason = "after_next_round_start"
                warnings.append(
                    f"round {round_info.round}: round_end_tick_after_next_round_start"
                )

        logger.info(
            "[RecordingV3][RoundNormalize] round=%d next_freeze_start=%s next_freeze_end=%s "
            "round_end_reliable=%s%s",
            round_info.round,
            nxt_freeze_start,
            nxt_freeze_end,
            round_end_reliable,
            f" reason={round_end_unreliable_reason}" if round_end_unreliable_reason else "",
        )

        normalized_rounds.append(RoundInfo(
            round=round_info.round,
            round_start_tick=round_info.round_start_tick,
            round_end_tick=round_end,
            freeze_start_tick=round_info.freeze_start_tick,
            freeze_end_tick=round_info.freeze_end_tick,
            next_round_start_tick=nxt_start,
            next_round_freeze_start_tick=nxt_freeze_start,
            next_round_freeze_end_tick=nxt_freeze_end,
            target_death_tick=round_info.target_death_tick,
            round_end_tick_reliable=round_end_reliable,
        ))

    if dto.options.victim_pov_pre_sec is not None and dto.options.victim_pov_pre_sec < 0:
        raise NormalizationError("options.victim_pov_pre_sec must be >= 0 if set")

    if (
        dto.options.enable_victim_pov
        and dto.request_type not in {RequestType.highlight, RequestType.kill_compilation}
    ):
        warnings.append(
            "enable_victim_pov only applies to highlight and kill_compilation"
        )

    return NormalizedRequest(
        request_id=dto.request_id,
        request_type=dto.request_type,
        source_type=dto.source_type,
        demo=dto.demo,
        target_player=dto.target_player,
        events=dto.events,
        rounds=normalized_rounds,
        options=dto.options,
        source_ref=dto.source_ref,
        warnings=warnings,
    )
