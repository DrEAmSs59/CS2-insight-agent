"""Apply AIDirectorOutline to RecordingSegment list."""

from __future__ import annotations

from ..ai_director import AIDirectorBlock, AIDirectorOutline
from ..models import Perspective, RecordingSegment, SourceType
from ..normalizer import NormalizedRequest
from .event_clip_planner import _clamp, _is_final_round, _prepare_seek_tick, _voice_mask, _voice_mask_enemy
from .pov_interleave import plan_kill_then_victim_pairs


def _killer_pre_post_ticks(req: NormalizedRequest) -> tuple[int, int]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    if req.request_type.value == "kill_compilation":
        pre = int(opts.kill_compilation_pre_sec * tick_rate)
        post = int(opts.kill_compilation_post_sec * tick_rate)
    else:
        pre = int(opts.highlight_pre_sec * tick_rate)
        post = int(opts.highlight_post_sec * tick_rate)
    return pre, post


def _victim_pre_post_ticks(req: NormalizedRequest) -> tuple[int, int]:
    opts = req.options
    tick_rate = req.demo.tick_rate
    if req.request_type.value == "kill_compilation":
        vic_pre_sec = opts.victim_pov_pre_sec if opts.victim_pov_pre_sec is not None else opts.kill_compilation_pre_sec
    else:
        vic_pre_sec = opts.victim_pov_pre_sec if opts.victim_pov_pre_sec is not None else opts.highlight_pre_sec
    vic_post_sec = opts.victim_pov_post_sec
    return int(vic_pre_sec * tick_rate), int(vic_post_sec * tick_rate)


def _jump_threshold_ticks(req: NormalizedRequest) -> int:
    opts = req.options
    tick_rate = req.demo.tick_rate
    if req.request_type.value == "kill_compilation":
        sec = opts.kill_compilation_jump_cut_threshold_sec
    else:
        sec = opts.kill_jump_cut_threshold_sec
    return int(sec * tick_rate)


def _split_indices_by_jump_cut(
    indices: list[int],
    events: list,
    req: NormalizedRequest,
) -> list[list[int]]:
    """Split kill indices when gap > jump-cut threshold or round changes (matches legacy compilation)."""
    if not indices:
        return []
    if len(indices) == 1:
        return [indices]
    threshold = _jump_threshold_ticks(req)
    ordered = sorted(indices, key=lambda i: (events[i].round, events[i].tick))
    groups: list[list[int]] = [[ordered[0]]]
    for idx in ordered[1:]:
        prev = events[groups[-1][-1]]
        ev = events[idx]
        gap = ev.tick - prev.tick
        same_round = ev.round == prev.round
        if same_round and gap <= threshold:
            groups[-1].append(idx)
        else:
            groups.append([idx])
    return groups


def normalize_outline_jump_cuts(outline: AIDirectorOutline, req: NormalizedRequest) -> AIDirectorOutline:
    """Split killer_merged blocks that span long dead time into multiple blocks/segments."""
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    if not events or not outline.blocks:
        return outline
    new_blocks: list[AIDirectorBlock] = []
    for block in outline.blocks:
        if block.type != "killer_merged" or len(block.kill_indices) <= 1:
            new_blocks.append(block)
            continue
        for sub in _split_indices_by_jump_cut(block.kill_indices, events, req):
            if len(sub) == 1:
                new_blocks.append(
                    AIDirectorBlock(
                        type="killer_single",
                        kill_index=sub[0],
                        label=block.label or "单杀",
                    )
                )
            else:
                new_blocks.append(
                    AIDirectorBlock(
                        type="killer_merged",
                        kill_indices=sub,
                        label=block.label or f"合并 {len(sub)} 杀",
                    )
                )
    return AIDirectorOutline(blocks=new_blocks, rationale=outline.rationale)


def _append_merged_killer_segment(
    segments: list[RecordingSegment],
    req: NormalizedRequest,
    events: list,
    indices: list[int],
    seg_idx: int,
    pre_ticks: int,
    post_ticks: int,
) -> int:
    tick_rate = req.demo.tick_rate
    first_tick = req.demo.first_tick
    _mask = _voice_mask(req)
    _mask_enemy = _voice_mask_enemy(req)
    group = [events[i] for i in indices]
    start_tick = group[0].tick - pre_ticks
    end_tick = group[-1].tick + post_ticks
    start_tick, end_tick = _clamp(start_tick, end_tick, req)
    rep = group[0]
    segments.append(
        RecordingSegment(
            segment_index=seg_idx,
            source_type=SourceType.kill,
            start_tick=start_tick,
            end_tick=end_tick,
            anchor_ticks=[e.tick for e in group],
            round=rep.round,
            target_player_name=req.target_player.name,
            target_steamid64=req.target_player.steamid64,
            target_spec_slot=req.target_player.spec_slot,
            perspective=Perspective.killer,
            is_final_round=_is_final_round(rep.round, req),
            safe_seek_tick=_prepare_seek_tick(start_tick, tick_rate, first_tick),
            safe_end_tick=None,
            disabled=False,
            disabled_reason=None,
            metadata={"ai_director_block": "killer_merged", "kill_indices": indices},
            voice_listen_mask=_mask,
            voice_listen_mask_enemy=_mask_enemy,
        )
    )
    return seg_idx + 1


def plan_from_ai_outline(req: NormalizedRequest, outline: AIDirectorOutline) -> list[RecordingSegment]:
    events = sorted(req.events, key=lambda e: (e.round, e.tick))
    if not events or not outline.blocks:
        return []

    pre_ticks, post_ticks = _killer_pre_post_ticks(req)
    vic_pre, vic_post = _victim_pre_post_ticks(req)
    segments: list[RecordingSegment] = []
    seg_idx = 0

    for block in outline.blocks:
        if block.type == "killer_merged":
            subgroups = _split_indices_by_jump_cut(block.kill_indices, events, req)
            for sub in subgroups:
                seg_idx = _append_merged_killer_segment(
                    segments, req, events, sub, seg_idx, pre_ticks, post_ticks
                )
        elif block.type == "killer_single":
            ki = block.kill_index if block.kill_index is not None else 0
            seg_idx = _append_merged_killer_segment(
                segments, req, events, [ki], seg_idx, pre_ticks, post_ticks
            )
        elif block.type == "kill_with_victim":
            ki = block.kill_index if block.kill_index is not None else 0
            pair = plan_kill_then_victim_pairs(
                req,
                [events[ki]],
                source_type=SourceType.kill,
                killer_pre_ticks=pre_ticks,
                killer_post_ticks=post_ticks,
                vic_pre_ticks=vic_pre,
                vic_post_ticks=vic_post,
                clamp_fn=_clamp,
                is_final_round_fn=_is_final_round,
            )
            for seg in pair:
                segments.append(
                    seg.model_copy(
                        update={
                            "segment_index": seg_idx,
                            "metadata": {
                                **(seg.metadata or {}),
                                "ai_director_block": "kill_with_victim",
                                "kill_index": ki,
                            },
                        }
                    )
                )
                seg_idx += 1

    return segments
