"""Read-only projection from a normalized schema-v2 project into export inputs."""

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
    _build_positional_transitions,
    _has_solo_audio_tracks,
    _project_bgm_clip_for_export,
    _recorded_source_ids_for_export,
    _video_layer_audio_clips_for_export,
)


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
    overlays: tuple[dict[str, Any], ...]
    audio_events: tuple[dict[str, Any], ...]
    transitions: dict[str, Any]
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
    base_track_id, base_clips_raw = _base_video_track_for_export(body)
    base_clips = tuple(base_clips_raw)
    video_layers = tuple(_all_overlay_clips_for_export(body, base_track_id=base_track_id))
    schema_overlays = tuple(item for item in video_layers if item.get("_timeline_video_layer") is not True)
    audio_events = [
        *_audio_track_clips_for_export(body),
        *_video_layer_audio_clips_for_export(body, base_track_id=base_track_id),
    ]
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
    return LiteCutExportPlan(
        base_track_id=base_track_id,
        base_clips=base_clips,
        video_layers=video_layers,
        overlays=schema_overlays,
        audio_events=tuple(audio_events),
        transitions=_build_positional_transitions(list(base_clips)),
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
