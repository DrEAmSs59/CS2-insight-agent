"""LiteCut project schema v2 Pydantic models."""

from __future__ import annotations

import uuid
import math
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator


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
    width: int = Field(default=1920, ge=16, le=7680)
    height: int = Field(default=1080, ge=16, le=4320)
    fps: int = Field(default=60, ge=1, le=240)
    encoder: Literal["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"] = "auto"
    encoder_tier: Literal["quality", "fast"] = "quality"
    canvas_fit: Literal["contain", "cover", "blur"] = "contain"
    background_color: str = "#000000"
    blur_amount: int = Field(default=24, ge=0, le=100)
    range_mode: Literal["full", "custom"] = "full"
    range_start_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    range_end_sec: Optional[float] = Field(default=None, ge=0.0, le=86400.0)

    @model_validator(mode="after")
    def validate_range(self) -> "OutputConfig":
        if self.range_mode == "custom" and self.range_end_sec is not None:
            if self.range_end_sec <= self.range_start_sec:
                raise ValueError("output range_end_sec must be greater than range_start_sec")
        return self


class Transition(BaseModel):
    type: str = Field(default="cut", min_length=1, max_length=64)
    duration_sec: float = Field(default=0.5, ge=0.0, le=10.0)


class ColorGrade(BaseModel):
    brightness: float = Field(default=0.0, ge=-100.0, le=100.0)
    contrast: float = Field(default=0.0, ge=-100.0, le=100.0)
    saturation: float = Field(default=0.0, ge=-100.0, le=100.0)
    filter_preset: Optional[str] = None


class ClipTransform(BaseModel):
    x: float = Field(default=0.5, ge=-10.0, le=10.0)
    y: float = Field(default=0.5, ge=-10.0, le=10.0)
    scale: float = Field(default=1.0, gt=0.0, le=20.0)
    rotation: float = Field(default=0.0, ge=-3600.0, le=3600.0)
    width: float = Field(default=1.0, gt=0.0, le=20.0)
    height: float = Field(default=1.0, gt=0.0, le=20.0)
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)


class ClipCrop(BaseModel):
    x: float = Field(default=0.0, ge=0.0, le=1.0)
    y: float = Field(default=0.0, ge=0.0, le=1.0)
    width: float = Field(default=1.0, gt=0.0, le=1.0)
    height: float = Field(default=1.0, gt=0.0, le=1.0)

    @model_validator(mode="after")
    def validate_bounds(self) -> "ClipCrop":
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("crop rectangle must stay within the source frame")
        return self


class TimelineClip(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    source_type: Literal["recorded_clip", "file", "text", "template_asset"] = "recorded_clip"
    source_id: Optional[int] = None
    file_path: Optional[str] = None
    timeline_start: float = Field(default=0.0, ge=0.0, le=86400.0)
    trim_in: float = Field(default=0.0, ge=0.0, le=86400.0)
    trim_out: Optional[float] = Field(default=None, ge=0.0, le=86400.0)
    transition_in: Optional[Transition] = None
    transition_out: Optional[Transition] = None
    color: Optional[ColorGrade] = None
    transform: Optional[ClipTransform] = None
    keyframes: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    crop: Optional[ClipCrop] = None
    canvas_fit: Optional[Literal["inherit", "contain", "cover", "blur"]] = None
    flip_horizontal: bool = False
    flip_vertical: bool = False
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    speed_keyframes: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    preserve_pitch: bool = True
    reverse: bool = False
    freeze_frame_sec: float = Field(default=0.0, ge=0.0, le=30.0)
    volume: float = Field(default=1.0, ge=0.0, le=5.0)
    audio_keyframes: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    muted: bool = False
    fade_in_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    fade_out_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    meta: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def validate_timing_and_keyframes(self) -> "TimelineClip":
        if self.trim_out is not None and self.trim_out <= self.trim_in:
            raise ValueError("clip trim_out must be greater than trim_in")
        for keyframe in self.speed_keyframes:
            _validate_raw_keyframe(keyframe, "source_sec", "speed", 0.25, 4.0)
        for keyframe in self.audio_keyframes:
            _validate_raw_keyframe(keyframe, "time_sec", "volume", 0.0, 5.0)
        return self


class Track(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    type: Literal["video", "overlay", "audio"]
    label: str
    name: Optional[str] = Field(default=None, max_length=60)
    locked: bool = False
    hidden: bool = False
    muted: bool = False
    solo: bool = False
    volume: float = Field(default=1.0, ge=0.0, le=5.0)
    clips: list[TimelineClip] = Field(default_factory=list, max_length=500)


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
    scale: float = Field(default=1.0, gt=0.0, le=20.0)
    rotation: float = 0.0
    width: float = Field(default=0.33, gt=0.0, le=20.0)
    height: float = Field(default=0.33, gt=0.0, le=20.0)
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)


class OverlayKeyframe(BaseModel):
    time_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    transform: OverlayTransform = Field(default_factory=OverlayTransform)


class OverlayLayer(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    type: Literal["text", "sticker", "webm", "name_card"]
    timeline_start: float = Field(default=0.0, ge=0.0, le=86400.0)
    duration: float = Field(default=3.0, gt=0.0, le=86400.0)
    fade_in_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    fade_out_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    transition_in: Optional[Transition] = None
    transition_out: Optional[Transition] = None
    transform: OverlayTransform = Field(default_factory=OverlayTransform)
    keyframes: list[OverlayKeyframe] = Field(default_factory=list, max_length=500)
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
    volume: float = Field(default=1.0, ge=0.0, le=2.0)
    start_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    fade_in_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    fade_out_sec: float = Field(default=0.0, ge=0.0, le=86400.0)
    ducking_enabled: bool = False
    ducking_volume: float = Field(default=0.35, ge=0.0, le=1.0)


class AudioConfig(BaseModel):
    bgm: Optional[BgmConfig] = None
    master_volume: float = Field(default=1.0, ge=0.0, le=5.0)


class TimelineMarker(BaseModel):
    id: str
    time_sec: float = 0.0
    label: str = ""
    color: str = "#f59e0b"


class LiteCutProjectBody(BaseModel):
    schema_version: Literal[2] = SCHEMA_VERSION
    output: OutputConfig = Field(default_factory=OutputConfig)
    tracks: list[Track] = Field(default_factory=list, max_length=32)
    overlays: list[OverlayLayer] = Field(default_factory=list, max_length=32)
    overlay_tracks: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    markers: list[TimelineMarker] = Field(default_factory=list, max_length=500)
    audio: AudioConfig = Field(default_factory=AudioConfig)
    template_id: Optional[str] = None
    created_from_template: bool = False

    @model_validator(mode="after")
    def validate_unique_ids(self) -> "LiteCutProjectBody":
        _ensure_unique("track", [track.id for track in self.tracks])
        _ensure_unique("clip", [clip.id for track in self.tracks for clip in track.clips])
        _ensure_unique("overlay", [overlay.id for overlay in self.overlays])
        _ensure_unique("marker", [marker.id for marker in self.markers])
        return self


def _ensure_unique(kind: str, values: list[str]) -> None:
    seen: set[str] = set()
    for value in values:
        key = value.strip()
        if not key:
            raise ValueError(f"{kind} id must not be blank")
        if key in seen:
            raise ValueError(f"duplicate {kind} id: {value}")
        seen.add(key)


def _validate_raw_keyframe(
    keyframe: dict[str, Any],
    time_key: str,
    value_key: str,
    minimum: float,
    maximum: float,
) -> None:
    if not isinstance(keyframe, dict):
        raise ValueError("keyframe must be an object")
    try:
        time_value = float(keyframe[time_key])
        value = float(keyframe[value_key])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"keyframe requires numeric {time_key} and {value_key}") from exc
    if not math.isfinite(time_value) or time_value < 0.0 or time_value > 86400.0:
        raise ValueError(f"keyframe {time_key} is out of range")
    if not math.isfinite(value) or value < minimum or value > maximum:
        raise ValueError(f"keyframe {value_key} is out of range")


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
