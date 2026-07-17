"""LiteCut project schema v2 Pydantic models."""

from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


SCHEMA_VERSION = 2

PresetKind = Literal[
    "text_style",
    "color_grade",
    "transition_rhythm",
    "audio_mix",
    "overlay_recipe",
    "packaging_bundle",
]

OverlayAnchor = Literal["timeline_start", "clip_start", "clip_end", "each_clip_start"]


class OutputConfig(BaseModel):
    dir: str = ""
    filename: str = "lite_cut_export.mp4"
    width: int = 1920
    height: int = 1080
    fps: int = 60
    encoder: Literal["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"] = "auto"
    encoder_tier: Literal["quality", "fast"] = "quality"
    canvas_fit: Literal["contain", "cover", "blur"] = "contain"
    background_color: str = "#000000"
    blur_amount: int = 24
    range_mode: Literal["full", "custom"] = "full"
    range_start_sec: float = 0.0
    range_end_sec: Optional[float] = None


class Transition(BaseModel):
    type: str = "cut"
    duration_sec: float = 0.5


class ColorGrade(BaseModel):
    brightness: float = 0.0
    contrast: float = 0.0
    saturation: float = 0.0
    filter_preset: Optional[str] = None


class ClipTransform(BaseModel):
    x: float = 0.5
    y: float = 0.5
    scale: float = 1.0
    rotation: float = 0.0
    width: float = 1.0
    height: float = 1.0
    opacity: float = 1.0


class ClipCrop(BaseModel):
    x: float = 0.0
    y: float = 0.0
    width: float = 1.0
    height: float = 1.0


class TimelineClip(BaseModel):
    id: str
    source_type: Literal["recorded_clip", "file", "text", "template_asset"] = "recorded_clip"
    source_id: Optional[int] = None
    file_path: Optional[str] = None
    timeline_start: float = 0.0
    trim_in: float = 0.0
    trim_out: Optional[float] = None
    transition_in: Optional[Transition] = None
    transition_out: Optional[Transition] = None
    color: Optional[ColorGrade] = None
    transform: Optional[ClipTransform] = None
    keyframes: list[dict[str, Any]] = Field(default_factory=list)
    crop: Optional[ClipCrop] = None
    canvas_fit: Optional[Literal["inherit", "contain", "cover", "blur"]] = None
    flip_horizontal: bool = False
    flip_vertical: bool = False
    speed: float = 1.0
    speed_keyframes: list[dict[str, Any]] = Field(default_factory=list)
    preserve_pitch: bool = True
    reverse: bool = False
    freeze_frame_sec: float = 0.0
    volume: float = 1.0
    audio_keyframes: list[dict[str, Any]] = Field(default_factory=list)
    muted: bool = False
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    meta: Optional[dict[str, Any]] = None


class Track(BaseModel):
    id: str
    type: Literal["video", "overlay", "audio"]
    label: str
    name: Optional[str] = Field(default=None, max_length=60)
    locked: bool = False
    hidden: bool = False
    muted: bool = False
    solo: bool = False
    volume: float = 1.0
    clips: list[TimelineClip] = Field(default_factory=list)


class OverlayText(BaseModel):
    content: str = ""
    font_family: str = "sans-serif"
    font_file: Optional[str] = None
    font_size: int = 48
    preset_id: Optional[str] = None
    anim_in: Optional[str] = None
    anim_out: Optional[str] = None


class OverlayTransform(BaseModel):
    x: float = 0.5
    y: float = 0.5
    scale: float = 1.0
    rotation: float = 0.0
    width: float = 0.33
    height: float = 0.33
    opacity: float = 1.0


class OverlayKeyframe(BaseModel):
    time_sec: float = 0.0
    transform: OverlayTransform = Field(default_factory=OverlayTransform)


class OverlayLayer(BaseModel):
    id: str
    type: Literal["text", "sticker", "webm", "name_card"]
    timeline_start: float = 0.0
    duration: float = 3.0
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    transition_in: Optional[Transition] = None
    transition_out: Optional[Transition] = None
    transform: OverlayTransform = Field(default_factory=OverlayTransform)
    keyframes: list[OverlayKeyframe] = Field(default_factory=list)
    flip_horizontal: bool = False
    flip_vertical: bool = False
    text: Optional[OverlayText] = None
    asset_path: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


class BgmConfig(BaseModel):
    path: str = ""
    name: Optional[str] = None
    asset_id: Optional[int] = None
    duration_sec: Optional[float] = None
    volume: float = 1.0
    start_sec: float = 0.0
    fade_in_sec: float = 0.0
    fade_out_sec: float = 0.0
    ducking_enabled: bool = False
    ducking_volume: float = 0.35


class AudioConfig(BaseModel):
    bgm: Optional[BgmConfig] = None
    master_volume: float = 1.0


class TimelineMarker(BaseModel):
    id: str
    time_sec: float = 0.0
    label: str = ""
    color: str = "#f59e0b"


class LiteCutProjectBody(BaseModel):
    schema_version: Literal[2] = SCHEMA_VERSION
    output: OutputConfig = Field(default_factory=OutputConfig)
    tracks: list[Track] = Field(default_factory=list)
    overlays: list[OverlayLayer] = Field(default_factory=list)
    overlay_tracks: list[dict[str, Any]] = Field(default_factory=list)
    markers: list[TimelineMarker] = Field(default_factory=list)
    audio: AudioConfig = Field(default_factory=AudioConfig)
    template_id: Optional[str] = None
    created_from_template: bool = False


def _new_clip_id() -> str:
    return f"clip-{uuid.uuid4().hex[:12]}"


def _new_overlay_id() -> str:
    return f"ov-{uuid.uuid4().hex[:12]}"


def empty_project() -> LiteCutProjectBody:
    """Factory: 主视频轨 + 音频轨（OpenCut 风格，叠加层走 overlays 数组）。"""
    tracks: list[Track] = [
        Track(
            id="v1",
            type="video",
            label="V1",
            locked=False,
            hidden=False,
            muted=False,
            solo=False,
            volume=1.0,
            clips=[],
        ),
        Track(id="a1", type="audio", label="A1", volume=1.0, clips=[]),
    ]
    return LiteCutProjectBody(tracks=tracks, overlays=[], audio=AudioConfig())


# --- Preset bodies (design §6) ---


class TextStylePresetBody(BaseModel):
    preset_id: Optional[str] = None
    font_family: str = "sans-serif"
    font_file: Optional[str] = None
    font_size: int = 48
    color: Optional[str] = None
    anim_in: Optional[str] = None
    anim_out: Optional[str] = None
    content_template: str = "{{player_name}}"


class ColorGradePresetBody(BaseModel):
    brightness: float = 0.0
    contrast: float = 0.0
    saturation: float = 0.0
    filter_preset: Optional[str] = None
    apply_to: Literal["selection", "all_video", "v1_main"] = "v1_main"


class TransitionRhythmPresetBody(BaseModel):
    default_type: str = "fade"
    default_duration_sec: float = 0.5
    flash_every_n: Optional[int] = None
    flash_type: str = "flashwhite"


class OverlayRecipeLayer(BaseModel):
    type: Literal["text", "webm", "sticker", "name_card"]
    anchor: OverlayAnchor = "clip_start"
    offset_sec: float = 0.0
    duration_sec: float | Literal["clip_length"] = 3.0
    text_style: Optional[TextStylePresetBody] = None
    asset_path: Optional[str] = None
    placeholders: list[str] = Field(default_factory=list)


class OverlayRecipePresetBody(BaseModel):
    layers: list[OverlayRecipeLayer] = Field(default_factory=list)


class PackagingBundleBody(BaseModel):
    text_styles: list[TextStylePresetBody] = Field(default_factory=list)
    color_grade: Optional[ColorGradePresetBody] = None
    transition_rhythm: Optional[TransitionRhythmPresetBody] = None
    overlay_recipe: Optional[OverlayRecipePresetBody] = None
    bgm: Optional[BgmConfig] = None


class LiteCutPresetBody(BaseModel):
    """Union wrapper stored in lite_cut_presets.body_json."""

    kind: PresetKind
    text_style: Optional[TextStylePresetBody] = None
    color_grade: Optional[ColorGradePresetBody] = None
    transition_rhythm: Optional[TransitionRhythmPresetBody] = None
    overlay_recipe: Optional[OverlayRecipePresetBody] = None
    packaging_bundle: Optional[PackagingBundleBody] = None


class LiteCutPresetCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: PresetKind
    tags: list[str] = Field(default_factory=list)
    body: dict[str, Any]
    source_project_id: Optional[int] = None


class LiteCutPresetPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    tags: Optional[list[str]] = None


class LiteCutProjectCreate(BaseModel):
    name: str = Field(default="", max_length=240)
    body: Optional[dict[str, Any]] = None


class LiteCutProjectPatch(BaseModel):
    name: Optional[str] = Field(default=None, max_length=240)
    body: Optional[dict[str, Any]] = None


class PresetApplyRequest(BaseModel):
    project_id: Optional[int] = None
    project_body: Optional[dict[str, Any]] = None
    clip_ids: list[str] = Field(default_factory=list)
    scope: Literal["project", "selection"] = "project"
    include: list[str] = Field(default_factory=list)


__all__ = [
    "SCHEMA_VERSION",
    "LiteCutProjectBody",
    "LiteCutPresetBody",
    "empty_project",
    "_new_clip_id",
    "_new_overlay_id",
]
