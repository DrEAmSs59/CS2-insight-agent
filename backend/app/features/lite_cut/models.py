"""LiteCut project schema v3 Pydantic models."""

from __future__ import annotations

import uuid
import math
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .text_layout import (
    TEXT_DEFAULT_FONT_FAMILY,
    TEXT_FONT_SIZE_DEFAULT,
    TEXT_FONT_SIZE_MAX,
    TEXT_FONT_SIZE_MIN,
    TEXT_FONT_WEIGHT_DEFAULT,
    TEXT_FONT_WEIGHT_MAX,
    TEXT_FONT_WEIGHT_MIN,
    TEXT_LINE_HEIGHT_DEFAULT,
    TEXT_LINE_HEIGHT_MAX,
    TEXT_LINE_HEIGHT_MIN,
)
from .project_boundaries import (
    AUDIO_BGM_GAIN_DEFAULT,
    AUDIO_BGM_GAIN_MAX,
    AUDIO_BGM_GAIN_MIN,
    AUDIO_CLIP_GAIN_DEFAULT,
    AUDIO_CLIP_GAIN_MAX,
    AUDIO_CLIP_GAIN_MIN,
    AUDIO_DUCKING_GAIN_DEFAULT,
    AUDIO_DUCKING_GAIN_MAX,
    AUDIO_DUCKING_GAIN_MIN,
    AUDIO_FADE_DURATION_DEFAULT,
    AUDIO_FADE_DURATION_MAX,
    AUDIO_FADE_DURATION_MIN,
    AUDIO_MASTER_GAIN_DEFAULT,
    AUDIO_MASTER_GAIN_MAX,
    AUDIO_MASTER_GAIN_MIN,
    AUDIO_TRACK_GAIN_DEFAULT,
    AUDIO_TRACK_GAIN_MAX,
    AUDIO_TRACK_GAIN_MIN,
    CANVAS_BLUR_DEFAULT,
    CANVAS_BLUR_MAX,
    CANVAS_BLUR_MIN,
    OUTPUT_FPS_DEFAULT,
    OUTPUT_FPS_MAX,
    OUTPUT_FPS_MIN,
    OUTPUT_HEIGHT_DEFAULT,
    OUTPUT_HEIGHT_MAX,
    OUTPUT_HEIGHT_MIN,
    OUTPUT_WIDTH_DEFAULT,
    OUTPUT_WIDTH_MAX,
    OUTPUT_WIDTH_MIN,
    TIMELINE_DURATION_DEFAULT,
    TIMELINE_DURATION_MAX,
    TIMELINE_DURATION_MIN_EXCLUSIVE,
    TIMELINE_TIME_DEFAULT,
    TIMELINE_TIME_MAX,
    TIMELINE_TIME_MIN,
)
from .scene_transform import OVERLAY_SCENE_DEFAULTS, SCENE_TRANSFORM_LIMITS, VIDEO_SCENE_DEFAULTS
from .transition_events import TRANSITION_DURATION_DEFAULT, TRANSITION_DURATION_MAX, TRANSITION_DURATION_MIN
from .visual_material import (
    VISUAL_COLOR_DEFAULT,
    VISUAL_COLOR_MAX,
    VISUAL_COLOR_MIN,
    VISUAL_CROP_POSITION_MAX,
    VISUAL_CROP_POSITION_MIN,
    VISUAL_CROP_SIZE_MAX,
    VISUAL_CROP_SIZE_MIN,
    VISUAL_FREEZE_DEFAULT_SEC,
    VISUAL_FREEZE_MAX_SEC,
    VISUAL_FREEZE_MIN_SEC,
    VISUAL_MATERIAL_DEFAULTS,
    VISUAL_SPEED_DEFAULT,
    VISUAL_SPEED_MAX,
    VISUAL_SPEED_MIN,
)


SCHEMA_VERSION = 3

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
    width: int = Field(default=OUTPUT_WIDTH_DEFAULT, ge=OUTPUT_WIDTH_MIN, le=OUTPUT_WIDTH_MAX)
    height: int = Field(default=OUTPUT_HEIGHT_DEFAULT, ge=OUTPUT_HEIGHT_MIN, le=OUTPUT_HEIGHT_MAX)
    fps: int = Field(default=OUTPUT_FPS_DEFAULT, ge=OUTPUT_FPS_MIN, le=OUTPUT_FPS_MAX)
    encoder: Literal["auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"] = "auto"
    encoder_tier: Literal["quality", "fast"] = "quality"
    framemeld_enabled: bool = False
    canvas_fit: Literal["contain", "cover", "blur"] = "contain"
    background_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    blur_amount: int = Field(default=CANVAS_BLUR_DEFAULT, ge=CANVAS_BLUR_MIN, le=CANVAS_BLUR_MAX)
    range_mode: Literal["full", "custom"] = "full"
    range_start_sec: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    range_end_sec: Optional[float] = Field(default=None, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)

    @model_validator(mode="after")
    def validate_range(self) -> "OutputConfig":
        if self.range_mode == "custom" and self.range_end_sec is not None:
            if self.range_end_sec <= self.range_start_sec:
                raise ValueError("output range_end_sec must be greater than range_start_sec")
        return self


class TransitionEndpoint(BaseModel):
    kind: Literal["clip", "overlay"]
    track_id: str = Field(default="", max_length=160)
    id: str = Field(min_length=1, max_length=160)


class TransitionEvent(BaseModel):
    """A transition owned by an edit point, never by either material."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=160)
    type: Literal["fade", "flash", "dip", "zoom", "wipe_l", "wipe_r", "slide_up", "slide_down"]
    duration_sec: float = Field(default=TRANSITION_DURATION_DEFAULT, ge=TRANSITION_DURATION_MIN, le=TRANSITION_DURATION_MAX)
    easing: Literal["linear"] = "linear"
    from_: Optional[TransitionEndpoint] = Field(default=None, alias="from", serialization_alias="from")
    to: Optional[TransitionEndpoint] = None

    @model_validator(mode="after")
    def validate_endpoints(self) -> "TransitionEvent":
        if self.from_ is None and self.to is None:
            raise ValueError("transition event requires at least one endpoint")
        return self


class ColorGrade(BaseModel):
    brightness: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    contrast: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    saturation: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    filter_preset: Optional[str] = None


class SceneTransform(BaseModel):
    """One canvas-relative, center-anchored transform for every visual node."""

    x: float = Field(default=VIDEO_SCENE_DEFAULTS["x"], ge=SCENE_TRANSFORM_LIMITS["position_min"], le=SCENE_TRANSFORM_LIMITS["position_max"])
    y: float = Field(default=VIDEO_SCENE_DEFAULTS["y"], ge=SCENE_TRANSFORM_LIMITS["position_min"], le=SCENE_TRANSFORM_LIMITS["position_max"])
    width: float = Field(default=VIDEO_SCENE_DEFAULTS["width"], ge=SCENE_TRANSFORM_LIMITS["size_min"], le=SCENE_TRANSFORM_LIMITS["size_max"])
    height: float = Field(default=VIDEO_SCENE_DEFAULTS["height"], ge=SCENE_TRANSFORM_LIMITS["size_min"], le=SCENE_TRANSFORM_LIMITS["size_max"])
    scale: float = Field(default=VIDEO_SCENE_DEFAULTS["scale"], ge=SCENE_TRANSFORM_LIMITS["scale_min"], le=SCENE_TRANSFORM_LIMITS["scale_max"])
    rotation: float = Field(default=VIDEO_SCENE_DEFAULTS["rotation"], ge=SCENE_TRANSFORM_LIMITS["rotation_min"], le=SCENE_TRANSFORM_LIMITS["rotation_max"])
    opacity: float = Field(default=VIDEO_SCENE_DEFAULTS["opacity"], ge=SCENE_TRANSFORM_LIMITS["opacity_min"], le=SCENE_TRANSFORM_LIMITS["opacity_max"])


class SceneKeyframe(BaseModel):
    time_sec: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    transform: SceneTransform = Field(default_factory=SceneTransform)


class ClipCrop(BaseModel):
    x: float = Field(default=VISUAL_MATERIAL_DEFAULTS["crop"]["x"], ge=VISUAL_CROP_POSITION_MIN, le=VISUAL_CROP_POSITION_MAX)
    y: float = Field(default=VISUAL_MATERIAL_DEFAULTS["crop"]["y"], ge=VISUAL_CROP_POSITION_MIN, le=VISUAL_CROP_POSITION_MAX)
    width: float = Field(default=VISUAL_MATERIAL_DEFAULTS["crop"]["width"], ge=VISUAL_CROP_SIZE_MIN, le=VISUAL_CROP_SIZE_MAX)
    height: float = Field(default=VISUAL_MATERIAL_DEFAULTS["crop"]["height"], ge=VISUAL_CROP_SIZE_MIN, le=VISUAL_CROP_SIZE_MAX)

    @model_validator(mode="after")
    def validate_bounds(self) -> "ClipCrop":
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("crop rectangle must stay within the source frame")
        return self


class VisualMaterialEffects(BaseModel):
    """Canonical effects shared by every visual material."""

    color: Optional[ColorGrade] = None
    transform: Optional[SceneTransform] = None
    keyframes: list[SceneKeyframe] = Field(default_factory=list, max_length=500)
    crop: Optional[ClipCrop] = None
    content_fit: Optional[Literal["inherit", "fill", "contain", "cover", "blur"]] = None
    flip_horizontal: bool = False
    flip_vertical: bool = False


class TimelineClip(VisualMaterialEffects):
    id: str = Field(min_length=1, max_length=160)
    source_type: Literal["recorded_clip", "file", "text", "template_asset"] = "recorded_clip"
    source_id: Optional[int] = None
    file_path: Optional[str] = None
    timeline_start: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    trim_in: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    trim_out: Optional[float] = Field(default=None, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    speed: float = Field(default=VISUAL_SPEED_DEFAULT, ge=VISUAL_SPEED_MIN, le=VISUAL_SPEED_MAX)
    speed_keyframes: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    preserve_pitch: bool = True
    reverse: bool = False
    freeze_frame_sec: float = Field(default=VISUAL_FREEZE_DEFAULT_SEC, ge=VISUAL_FREEZE_MIN_SEC, le=VISUAL_FREEZE_MAX_SEC)
    volume: float = Field(default=AUDIO_CLIP_GAIN_DEFAULT, ge=AUDIO_CLIP_GAIN_MIN, le=AUDIO_CLIP_GAIN_MAX)
    audio_keyframes: list[dict[str, Any]] = Field(default_factory=list, max_length=500)
    muted: bool = False
    fade_in_sec: float = Field(default=AUDIO_FADE_DURATION_DEFAULT, ge=AUDIO_FADE_DURATION_MIN, le=AUDIO_FADE_DURATION_MAX)
    fade_out_sec: float = Field(default=AUDIO_FADE_DURATION_DEFAULT, ge=AUDIO_FADE_DURATION_MIN, le=AUDIO_FADE_DURATION_MAX)
    meta: Optional[dict[str, Any]] = None

    @model_validator(mode="after")
    def validate_timing_and_keyframes(self) -> "TimelineClip":
        if self.trim_out is not None and self.trim_out <= self.trim_in:
            raise ValueError("clip trim_out must be greater than trim_in")
        for keyframe in self.speed_keyframes:
            _validate_raw_keyframe(keyframe, "source_sec", "speed", VISUAL_SPEED_MIN, VISUAL_SPEED_MAX)
        for keyframe in self.audio_keyframes:
            _validate_raw_keyframe(keyframe, "time_sec", "volume", AUDIO_CLIP_GAIN_MIN, AUDIO_CLIP_GAIN_MAX)
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
    volume: float = Field(default=AUDIO_TRACK_GAIN_DEFAULT, ge=AUDIO_TRACK_GAIN_MIN, le=AUDIO_TRACK_GAIN_MAX)
    clips: list[TimelineClip] = Field(default_factory=list, max_length=500)


class OverlayText(BaseModel):
    content: str = ""
    font_family: str = TEXT_DEFAULT_FONT_FAMILY
    font_file: Optional[str] = None
    font_size: int = Field(default=TEXT_FONT_SIZE_DEFAULT, ge=TEXT_FONT_SIZE_MIN, le=TEXT_FONT_SIZE_MAX)
    font_weight: int = Field(default=TEXT_FONT_WEIGHT_DEFAULT, ge=TEXT_FONT_WEIGHT_MIN, le=TEXT_FONT_WEIGHT_MAX)
    line_height: float = Field(default=TEXT_LINE_HEIGHT_DEFAULT, ge=TEXT_LINE_HEIGHT_MIN, le=TEXT_LINE_HEIGHT_MAX)
    letter_spacing: Literal[0.0] = 0.0
    align: Literal["left", "center", "right"] = "center"
    preset_id: Optional[str] = None
    fill_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


OverlayKeyframe = SceneKeyframe


class OverlayLayer(VisualMaterialEffects):
    id: str = Field(min_length=1, max_length=160)
    type: Literal["text", "sticker", "webm", "name_card"]
    timeline_start: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    duration: float = Field(default=TIMELINE_DURATION_DEFAULT, gt=TIMELINE_DURATION_MIN_EXCLUSIVE, le=TIMELINE_DURATION_MAX)
    transform: SceneTransform = Field(default_factory=lambda: SceneTransform(**OVERLAY_SCENE_DEFAULTS))
    content_fit: Optional[Literal["inherit", "fill", "contain", "cover", "blur"]] = "fill"
    trim_in: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    text: Optional[OverlayText] = None
    asset_path: Optional[str] = None
    meta: Optional[dict[str, Any]] = None

class BgmConfig(BaseModel):
    path: str = ""
    name: Optional[str] = None
    asset_id: Optional[int] = None
    duration_sec: Optional[float] = Field(default=None, gt=TIMELINE_DURATION_MIN_EXCLUSIVE, le=TIMELINE_DURATION_MAX)
    volume: float = Field(default=AUDIO_BGM_GAIN_DEFAULT, ge=AUDIO_BGM_GAIN_MIN, le=AUDIO_BGM_GAIN_MAX)
    start_sec: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    fade_in_sec: float = Field(default=AUDIO_FADE_DURATION_DEFAULT, ge=AUDIO_FADE_DURATION_MIN, le=AUDIO_FADE_DURATION_MAX)
    fade_out_sec: float = Field(default=AUDIO_FADE_DURATION_DEFAULT, ge=AUDIO_FADE_DURATION_MIN, le=AUDIO_FADE_DURATION_MAX)
    ducking_enabled: bool = False
    ducking_volume: float = Field(default=AUDIO_DUCKING_GAIN_DEFAULT, ge=AUDIO_DUCKING_GAIN_MIN, le=AUDIO_DUCKING_GAIN_MAX)


class AudioConfig(BaseModel):
    bgm: Optional[BgmConfig] = None
    master_volume: float = Field(default=AUDIO_MASTER_GAIN_DEFAULT, ge=AUDIO_MASTER_GAIN_MIN, le=AUDIO_MASTER_GAIN_MAX)


class TimelineMarker(BaseModel):
    id: str
    time_sec: float = Field(default=TIMELINE_TIME_DEFAULT, ge=TIMELINE_TIME_MIN, le=TIMELINE_TIME_MAX)
    label: str = ""
    color: str = "#f59e0b"


class LiteCutProjectBody(BaseModel):
    schema_version: Literal[3] = SCHEMA_VERSION
    output: OutputConfig = Field(default_factory=OutputConfig)
    tracks: list[Track] = Field(default_factory=list, max_length=32)
    overlays: list[OverlayLayer] = Field(default_factory=list, max_length=32)
    transition_model_version: Literal[1] = 1
    transitions: list[TransitionEvent] = Field(default_factory=list, max_length=1000)
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
        _ensure_unique("transition", [transition.id for transition in self.transitions])
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
    if not math.isfinite(time_value) or time_value < TIMELINE_TIME_MIN or time_value > TIMELINE_TIME_MAX:
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
            volume=AUDIO_TRACK_GAIN_DEFAULT,
            clips=[],
        ),
        Track(id="a1", type="audio", label="A1", volume=AUDIO_TRACK_GAIN_DEFAULT, clips=[]),
    ]
    return LiteCutProjectBody(tracks=tracks, overlays=[], audio=AudioConfig())


# --- Preset bodies (design §6) ---


class TextStylePresetBody(BaseModel):
    preset_id: Optional[str] = None
    font_family: str = TEXT_DEFAULT_FONT_FAMILY
    font_file: Optional[str] = None
    font_size: int = Field(default=TEXT_FONT_SIZE_DEFAULT, ge=TEXT_FONT_SIZE_MIN, le=TEXT_FONT_SIZE_MAX)
    font_weight: int = Field(default=TEXT_FONT_WEIGHT_DEFAULT, ge=TEXT_FONT_WEIGHT_MIN, le=TEXT_FONT_WEIGHT_MAX)
    line_height: float = Field(default=TEXT_LINE_HEIGHT_DEFAULT, ge=TEXT_LINE_HEIGHT_MIN, le=TEXT_LINE_HEIGHT_MAX)
    letter_spacing: Literal[0.0] = 0.0
    align: Literal["left", "center", "right"] = "center"
    fill_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    anim_in: Optional[str] = None
    anim_out: Optional[str] = None
    content_template: str = "{{player_name}}"


class ColorGradePresetBody(BaseModel):
    brightness: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    contrast: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    saturation: float = Field(default=VISUAL_COLOR_DEFAULT, ge=VISUAL_COLOR_MIN, le=VISUAL_COLOR_MAX)
    filter_preset: Optional[str] = None
    apply_to: Literal["selection", "all_video", "all_visual", "v1_main"] = "v1_main"


class TransitionRhythmPresetBody(BaseModel):
    default_type: Literal["cut", "fade", "flash", "dip", "zoom", "wipe_l", "wipe_r", "slide_up", "slide_down"] = "fade"
    default_duration_sec: float = TRANSITION_DURATION_DEFAULT
    flash_every_n: Optional[int] = Field(default=None, ge=1)
    flash_type: Literal["fade", "flash", "dip", "zoom", "wipe_l", "wipe_r", "slide_up", "slide_down"] = "flash"

    @model_validator(mode="after")
    def validate_default_duration(self) -> "TransitionRhythmPresetBody":
        if self.default_type == "cut":
            self.default_duration_sec = 0.0
            return self
        if not math.isfinite(self.default_duration_sec) or not TRANSITION_DURATION_MIN <= self.default_duration_sec <= TRANSITION_DURATION_MAX:
            raise ValueError(
                f"timed transition duration must be between {TRANSITION_DURATION_MIN} and {TRANSITION_DURATION_MAX} seconds"
            )
        return self


class AudioMixPresetBody(BaseModel):
    master_volume: float = Field(default=AUDIO_MASTER_GAIN_DEFAULT, ge=AUDIO_MASTER_GAIN_MIN, le=AUDIO_MASTER_GAIN_MAX)
    bgm: Optional[BgmConfig] = None


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
    audio_mix: Optional[AudioMixPresetBody] = None
    bgm: Optional[BgmConfig] = None


class LiteCutPresetBody(BaseModel):
    """Union wrapper stored in lite_cut_presets.body_json."""

    kind: PresetKind
    text_style: Optional[TextStylePresetBody] = None
    color_grade: Optional[ColorGradePresetBody] = None
    transition_rhythm: Optional[TransitionRhythmPresetBody] = None
    overlay_recipe: Optional[OverlayRecipePresetBody] = None
    audio_mix: Optional[AudioMixPresetBody] = None
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
