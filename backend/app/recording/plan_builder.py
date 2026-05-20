from .models import (
    RecordingRequestDTO, RecordingPlan, RequestType
)
from .normalizer import normalize, NormalizationError
from .planners.event_clip_planner import plan_event_clip
from .planners.event_compilation_planner import plan_event_compilation
from .planners.round_pov_planner import plan_round_pov
from .postprocess.segment_postprocessor import postprocess_segments

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
        raw_segments = plan_event_clip(req)
    elif dto.request_type in EVENT_COMPILATION_TYPES:
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
