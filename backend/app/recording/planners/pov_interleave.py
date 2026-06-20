"""Build interleaved killer/victim recording segments (one event pair at a time)."""

from __future__ import annotations

from ..models import RecordingSegment, SourceType, Perspective
from ..normalizer import NormalizedRequest
from ..platform_utils import platform_slot_offset, compute_voice_listen_mask, compute_voice_listen_mask_enemy

PREPARE_PREROLL_SEC: float = 5.0
# When V/K follows immediately, CS2 auto death-cam after the event — keep main POV tail minimal.
INTERLEAVE_KILLER_TAIL_SEC: float = 0.35
INTERLEAVE_VICTIM_TAIL_SEC: float = 0.35


def _voice_mask(req: NormalizedRequest) -> int | None:
    offset = platform_slot_offset(req.demo.demo_filename, req.demo.server_name)
    return compute_voice_listen_mask(req.demo.all_players, req.target_player.steamid64, offset)


def _voice_mask_enemy(req: NormalizedRequest) -> int | None:
    offset = platform_slot_offset(req.demo.demo_filename, req.demo.server_name)
    return compute_voice_listen_mask_enemy(req.demo.all_players, req.target_player.steamid64, offset)


def _prepare_seek_tick(start_tick: int, tick_rate: float, first_tick: int) -> int:
    prepare_ticks = int(PREPARE_PREROLL_SEC * tick_rate)
    return max(first_tick, start_tick - prepare_ticks)


def _make_segment(
    *,
    seg_idx: int,
    source_type: SourceType,
    start_tick: int,
    end_tick: int,
    anchor_ticks: list[int],
    round_num: int,
    target_name: str,
    target_steamid64: str,
    target_spec_slot: int | None,
    perspective: Perspective,
    is_final_round: bool,
    tick_rate: float,
    first_tick: int,
    disabled: bool = False,
    disabled_reason: str | None = None,
    req: NormalizedRequest,
) -> RecordingSegment:
    return RecordingSegment(
        segment_index=seg_idx,
        source_type=source_type,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=anchor_ticks,
        round=round_num,
        target_player_name=target_name,
        target_steamid64=target_steamid64,
        target_spec_slot=target_spec_slot,
        perspective=perspective,
        is_final_round=is_final_round,
        safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
        safe_end_tick=None,
        disabled=disabled,
        disabled_reason=disabled_reason,
        metadata={},
        voice_listen_mask=_voice_mask(req),
        voice_listen_mask_enemy=_voice_mask_enemy(req),
    )


def plan_kill_then_victim_pairs(
    req: NormalizedRequest,
    sorted_events: list,
    *,
    source_type: SourceType,
    killer_pre_ticks: int,
    killer_post_ticks: int,
    vic_pre_ticks: int,
    vic_post_ticks: int,
    clamp_fn,
    is_final_round_fn,
) -> list[RecordingSegment]:
    """K→V per kill event. Used when enable_victim_pov=True."""
    first_tick = req.demo.first_tick
    demo_end = req.demo.demo_end_tick
    tick_rate = req.demo.tick_rate
    segments: list[RecordingSegment] = []
    seg_idx = 0

    killer_tail_ticks = min(
        killer_post_ticks,
        max(1, int(INTERLEAVE_KILLER_TAIL_SEC * tick_rate)),
    )

    for event in sorted_events:
        k_start = max(event.tick - killer_pre_ticks, first_tick)
        k_end = min(event.tick + killer_tail_ticks, demo_end)
        k_start, k_end = clamp_fn(k_start, k_end, req)

        segments.append(
            _make_segment(
                seg_idx=seg_idx,
                source_type=source_type,
                start_tick=k_start,
                end_tick=k_end,
                anchor_ticks=[event.tick],
                round_num=event.round,
                target_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                target_spec_slot=req.target_player.spec_slot,
                perspective=Perspective.killer,
                is_final_round=is_final_round_fn(event.round, req),
                tick_rate=tick_rate,
                first_tick=first_tick,
                req=req,
            )
        )
        seg_idx += 1

        victim = event.victim
        victim_steamid64 = (victim.steamid64 or "").strip() if victim else ""

        v_start = max(event.tick - vic_pre_ticks, first_tick)
        v_end = min(event.tick + vic_post_ticks, demo_end)
        v_start, v_end = clamp_fn(v_start, v_end, req)

        segments.append(
            _make_segment(
                seg_idx=seg_idx,
                source_type=source_type,
                start_tick=v_start,
                end_tick=v_end,
                anchor_ticks=[event.tick],
                round_num=event.round,
                target_name=victim.name if victim else "",
                target_steamid64=victim_steamid64,
                target_spec_slot=victim.spec_slot if victim else None,
                perspective=Perspective.victim,
                is_final_round=is_final_round_fn(event.round, req),
                tick_rate=tick_rate,
                first_tick=first_tick,
                req=req,
            )
        )
        seg_idx += 1

    return segments


def plan_victim_then_killer_pairs(
    req: NormalizedRequest,
    sorted_events: list,
    *,
    source_type: SourceType,
    victim_pre_ticks: int,
    victim_post_ticks: int,
    killer_pre_ticks: int,
    killer_post_ticks: int,
    clamp_fn,
    is_final_round_fn,
) -> list[RecordingSegment]:
    """V→K per death event. Used when enable_fail_killer_pov=True on compilations."""
    first_tick = req.demo.first_tick
    demo_end = req.demo.demo_end_tick
    tick_rate = req.demo.tick_rate
    segments: list[RecordingSegment] = []
    seg_idx = 0

    victim_tail_ticks = min(
        victim_post_ticks,
        max(1, int(INTERLEAVE_VICTIM_TAIL_SEC * tick_rate)),
    )

    for event in sorted_events:
        v_start = max(event.tick - victim_pre_ticks, first_tick)
        v_end = min(event.tick + victim_tail_ticks, demo_end)
        v_start, v_end = clamp_fn(v_start, v_end, req)

        segments.append(
            _make_segment(
                seg_idx=seg_idx,
                source_type=source_type,
                start_tick=v_start,
                end_tick=v_end,
                anchor_ticks=[event.tick],
                round_num=event.round,
                target_name=req.target_player.name,
                target_steamid64=req.target_player.steamid64,
                target_spec_slot=req.target_player.spec_slot,
                perspective=Perspective.victim,
                is_final_round=is_final_round_fn(event.round, req),
                tick_rate=tick_rate,
                first_tick=first_tick,
                req=req,
            )
        )
        seg_idx += 1

        killer = event.killer
        killer_steamid64 = (killer.steamid64 or "").strip() if killer else ""
        killer_disabled = not killer_steamid64
        killer_disabled_reason = "missing_killer_steamid64" if killer_disabled else None

        k_start = max(event.tick - killer_pre_ticks, first_tick)
        k_end = min(event.tick + killer_post_ticks, demo_end)
        k_start, k_end = clamp_fn(k_start, k_end, req)

        segments.append(
            _make_segment(
                seg_idx=seg_idx,
                source_type=source_type,
                start_tick=k_start,
                end_tick=k_end,
                anchor_ticks=[event.tick],
                round_num=event.round,
                target_name=killer.name if killer else "",
                target_steamid64=killer_steamid64,
                target_spec_slot=killer.spec_slot if killer else None,
                perspective=Perspective.killer,
                is_final_round=is_final_round_fn(event.round, req),
                tick_rate=tick_rate,
                first_tick=first_tick,
                disabled=killer_disabled,
                disabled_reason=killer_disabled_reason,
                req=req,
            )
        )
        seg_idx += 1

    return segments
