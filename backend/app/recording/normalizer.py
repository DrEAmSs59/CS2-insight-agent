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
    ]:
        value = getattr(dto.options, option_name)
        if value < 0:
            raise NormalizationError(
                f"options.{option_name} must be >= 0, got {value}"
            )

    for round_info in dto.rounds:
        if round_info.freeze_end_tick is None:
            warnings.append(
                f"round {round_info.round}: freeze_end_tick missing, will use fallback"
            )

        if round_info.next_round_freeze_start_tick is None:
            warnings.append(
                f"round {round_info.round}: next_round_freeze_start_tick missing, will use fallback"
            )

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
        rounds=dto.rounds,
        options=dto.options,
        source_ref=dto.source_ref,
        warnings=warnings,
    )
