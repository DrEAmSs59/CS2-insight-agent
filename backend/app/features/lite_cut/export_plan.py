"""Read-only projection from a normalized schema-v3 project into export inputs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .export_projection import (
    project_canvas_settings,
    project_encoder_tier,
    project_export_range,
    project_master_volume,
    project_output_settings,
)
from .timeline import (
    _all_overlay_clips_for_export,
    _audio_track_clips_for_export,
    _base_video_track_for_export,
    _has_solo_audio_tracks,
    _project_bgm_clip_for_export,
    _recorded_source_ids_for_export,
)
from .transition_events import project_events_to_render_nodes, resolved_transition_events


@dataclass(frozen=True)
class ExportAssetReference:
    owner: str
    clip_id: str
    source_id: int | None
    file_path: str


@dataclass(frozen=True)
class LiteCutExportPlan:
    base_track_id: str | None
    base_clips: tuple[dict[str, Any], ...]
    video_layers: tuple[dict[str, Any], ...]
    transition_layers: tuple[dict[str, Any], ...]
    overlays: tuple[dict[str, Any], ...]
    audio_events: tuple[dict[str, Any], ...]
    transitions: dict[str, Any]
    transition_events: tuple[dict[str, Any], ...]
    asset_references: tuple[ExportAssetReference, ...]
    recorded_source_ids: tuple[int, ...]
    master_volume: float
    canvas_fit: str
    canvas_color: str
    canvas_blur_amount: int
    output_width: int
    output_height: int
    output_fps: float
    encoder_tier: str
    range_start_sec: float
    range_end_sec: float | None
    framemeld_enabled: bool


def _asset_references(owner: str, clips: tuple[dict[str, Any], ...]) -> list[ExportAssetReference]:
    references: list[ExportAssetReference] = []
    for clip in clips:
        raw_source_id = clip.get("source_id")
        references.append(ExportAssetReference(
            owner=owner,
            clip_id=str(clip.get("id") or ""),
            source_id=int(raw_source_id) if raw_source_id is not None else None,
            file_path=str(clip.get("file_path") or clip.get("asset_path") or ""),
        ))
    return references


def build_lite_cut_export_plan(body: dict[str, Any], reference_media: dict[str, Any] | None = None) -> LiteCutExportPlan:
    """Project current rules only; no encoder selection, probing or process launch."""
    body = project_events_to_render_nodes(body)
    base_track_id, base_clips_raw = _base_video_track_for_export(body)
    base_clips = tuple(base_clips_raw)
    video_layers = tuple(_all_overlay_clips_for_export(body, base_track_id=base_track_id))
    schema_overlays = tuple(item for item in video_layers if item.get("is_timeline_video_layer") is not True)
    audio_events = list(_audio_track_clips_for_export(body))
    bgm = _project_bgm_clip_for_export(body)
    if bgm and not _has_solo_audio_tracks(body):
        audio_events.append(bgm)
    output_width, output_height, output_fps = project_output_settings(body, reference_media or {})
    canvas_fit, canvas_color, canvas_blur_amount = project_canvas_settings(body)
    range_start_sec, range_end_sec = project_export_range(body)
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    references = [
        *_asset_references("base", base_clips),
        *_asset_references("video_layer", video_layers),
        *_asset_references("audio", tuple(audio_events)),
    ]
    transition_events = tuple(resolved_transition_events(body))
    base_index = {str(clip.get("id") or ""): index for index, clip in enumerate(base_clips)}
    boundary_transitions: dict[str, Any] = {}
    for event in transition_events:
        if event.get("mode") != "boundary":
            continue
        from_ref = event.get("from") if isinstance(event.get("from"), dict) else {}
        to_ref = event.get("to") if isinstance(event.get("to"), dict) else {}
        if (
            from_ref.get("kind") != "clip"
            or to_ref.get("kind") != "clip"
            or str(from_ref.get("track_id") or "") != str(base_track_id or "")
            or str(to_ref.get("track_id") or "") != str(base_track_id or "")
        ):
            continue
        from_index = base_index.get(str(from_ref.get("id") or ""))
        to_index = base_index.get(str(to_ref.get("id") or ""))
        if from_index is None or to_index != from_index + 1:
            continue
        boundary_transitions[str(from_index)] = {
            "id": event["id"],
            "type": event["type"],
            "duration": event["duration_sec"],
            "alignment": "center",
        }
    specialized_event_ids = {str(item.get("id") or "") for item in boundary_transitions.values()}
    base_by_id = {str(clip.get("id") or ""): clip for clip in base_clips}
    transition_layers: list[dict[str, Any]] = []
    for event in transition_events:
        if event.get("mode") != "boundary" or str(event.get("id") or "") in specialized_event_ids:
            continue
        for role, endpoint in (("from", event.get("from")), ("to", event.get("to"))):
            ref = endpoint if isinstance(endpoint, dict) else {}
            if ref.get("kind") != "clip" or str(ref.get("track_id") or "") != str(base_track_id or ""):
                continue
            source_clip = base_by_id.get(str(ref.get("id") or ""))
            if not source_clip:
                continue
            transition_layers.append({
                **source_clip,
                "id": f"transition-projection:{event['id']}:{role}",
                "type": "file",
                "source_track_id": str(base_track_id or ""),
                "is_timeline_video_layer": True,
                "_transition_projection_only": True,
                "_transition_events": [{
                    "id": event["id"],
                    "type": event["type"],
                    "role": role,
                    "mode": event["mode"],
                    "duration_sec": event["duration_sec"],
                    "start_sec": event["start_sec"],
                    "end_sec": event["end_sec"],
                    "cut_sec": event["cut_sec"],
                    "stack": "upper" if (
                        (event.get(f"{role}_node") and event.get("to_node" if role == "from" else "from_node"))
                        and (
                            event[f"{role}_node"].layer > event["to_node" if role == "from" else "from_node"].layer
                            or (
                                event[f"{role}_node"].layer == event["to_node" if role == "from" else "from_node"].layer
                                and role == "to"
                            )
                        )
                    ) else "lower",
                }],
                "transform": source_clip.get("transform") if isinstance(source_clip.get("transform"), dict) else {
                    "x": 0.5,
                    "y": 0.5,
                    "scale": 1.0,
                    "rotation": 0.0,
                    "width": 1.0,
                    "height": 1.0,
                    "opacity": 1.0,
                },
            })
    return LiteCutExportPlan(
        base_track_id=base_track_id,
        base_clips=base_clips,
        video_layers=video_layers,
        transition_layers=tuple(transition_layers),
        overlays=schema_overlays,
        audio_events=tuple(audio_events),
        transitions=boundary_transitions,
        transition_events=transition_events,
        asset_references=tuple(references),
        recorded_source_ids=tuple(_recorded_source_ids_for_export(body)),
        master_volume=project_master_volume(body),
        canvas_fit=canvas_fit,
        canvas_color=canvas_color,
        canvas_blur_amount=canvas_blur_amount,
        output_width=output_width,
        output_height=output_height,
        output_fps=output_fps,
        encoder_tier=project_encoder_tier(body),
        range_start_sec=range_start_sec,
        range_end_sec=range_end_sec,
        framemeld_enabled=bool(output.get("framemeld_enabled")),
    )
