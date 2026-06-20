from __future__ import annotations

import asyncio
import concurrent.futures

from .models import (
    RecordingRequestDTO, RecordingPlan, RequestType
)
from .normalizer import normalize, NormalizationError
from .planners.event_clip_planner import plan_event_clip
from .planners.event_compilation_planner import plan_event_compilation
from .planners.round_pov_planner import plan_round_pov
from .postprocess.segment_postprocessor import postprocess_segments

_AI_DIRECTOR_TYPES = {
    RequestType.highlight,
    RequestType.kill_compilation,
}


def _run_async(coro):
    """Run coroutine from sync code; works inside FastAPI's running event loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _plan_with_ai_director(req, dto: RecordingRequestDTO, extra_warnings: list[str]) -> list:
    from .ai_director import suggest_recording_outline
    from .planners.ai_directed_planner import plan_from_ai_outline

    outline, source, llm_error = _run_async(suggest_recording_outline(req))
    extra_warnings.append(f"AI director outline source: {source}")
    if llm_error:
        extra_warnings.append(f"AI director LLM error: {llm_error}")
    if outline.rationale:
        extra_warnings.append(f"AI director: {outline.rationale[:200]}")
    victim_blocks = sum(1 for b in outline.blocks if b.type == "kill_with_victim")
    extra_warnings.append(
        f"AI director blocks: {len(outline.blocks)} "
        f"(kill_with_victim={victim_blocks}, segments_est≈{len(outline.blocks) + victim_blocks})"
    )
    return plan_from_ai_outline(req, outline)


def build_plan(dto: RecordingRequestDTO) -> RecordingPlan:
    req = normalize(dto)

    extra_warnings: list[str] = list(req.warnings)

    EVENT_CLIP_TYPES = {
        RequestType.highlight,
        RequestType.fail,
        RequestType.timeline_kill,
        RequestType.timeline_death,
    }
    EVENT_COMPILATION_TYPES = {
        RequestType.kill_compilation,
        RequestType.death_compilation,
    }
    ROUND_POV_TYPES = {
        RequestType.round_compilation,
        RequestType.timeline_round,
    }

    if dto.request_type in EVENT_CLIP_TYPES:
        if req.options.use_ai_director and dto.request_type in _AI_DIRECTOR_TYPES:
            raw_segments = _plan_with_ai_director(req, dto, extra_warnings)
        else:
            raw_segments = plan_event_clip(req)
    elif dto.request_type in EVENT_COMPILATION_TYPES:
        if req.options.use_ai_director and dto.request_type in _AI_DIRECTOR_TYPES:
            raw_segments = _plan_with_ai_director(req, dto, extra_warnings)
        else:
            raw_segments = plan_event_compilation(req)
    elif dto.request_type in ROUND_POV_TYPES:
        raw_segments, round_warnings = plan_round_pov(req)
        extra_warnings.extend(round_warnings)
    else:
        raise ValueError(f"Unknown request_type: {dto.request_type}")

    active, disabled, all_warnings = postprocess_segments(raw_segments, req, extra_warnings)

    return RecordingPlan(
        request_id=dto.request_id,
        request_type=dto.request_type,
        demo_path=dto.demo.demo_path,
        tick_rate=dto.demo.tick_rate,
        segments=active,
        disabled_segments=disabled,
        warnings=all_warnings,
    )
