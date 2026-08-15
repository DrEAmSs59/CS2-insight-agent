"""Pure functions to apply LiteCut style presets to a project body (design §6)."""

from __future__ import annotations

import copy
import re
import uuid
from typing import Any, Optional

from .models import (
    AudioMixPresetBody,
    ColorGrade,
    ColorGradePresetBody,
    LiteCutProjectBody,
    OverlayLayer,
    OverlayRecipeLayer,
    OverlayRecipePresetBody,
    OverlayText,
    PackagingBundleBody,
    TextStylePresetBody,
    TransitionEndpoint,
    TransitionEvent,
    TransitionRhythmPresetBody,
    _new_overlay_id,
)
from .project_codec import read_project_body
from .timeline_math import clip_timeline_duration_sec
from .transition_events import normalize_transition_spec
from .visual_material import visual_material_capabilities, visual_material_kind

_PLACEHOLDER_RE = re.compile(r"\{\{(\w+)\}\}")


def _append_single_overlay_transition(project: LiteCutProjectBody, overlay: OverlayLayer, edge: str, raw_type: str | None) -> None:
    if not raw_type:
        return
    spec = normalize_transition_spec(raw_type, min(0.45, overlay.duration))
    if spec["type"] == "cut":
        return
    endpoint = TransitionEndpoint(kind="overlay", track_id="ot1", id=overlay.id)
    project.transitions.append(TransitionEvent(
        id=f"tr-{uuid.uuid4().hex[:12]}",
        type=spec["type"],
        duration_sec=spec["duration_sec"],
        **({"from": endpoint} if edge == "out" else {"to": endpoint}),
    ))


def _resolve_placeholder(template: str, meta: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        val = meta.get(key)
        if val is None and key == "player_name":
            val = meta.get("player") or meta.get("player_name")
        if val is None and key == "map":
            val = meta.get("map_name") or meta.get("map")
        return str(val) if val is not None else m.group(0)

    return _PLACEHOLDER_RE.sub(repl, template)


def _main_video_track(project: LiteCutProjectBody):
    for track in project.tracks:
        if track.type == "video" and track.id == "v1":
            return track
    for track in project.tracks:
        if track.type == "video":
            return track
    return None


def _clip_end_sec(clip) -> float:
    payload = clip.model_dump(mode="python") if hasattr(clip, "model_dump") else dict(clip)
    return float(payload.get("timeline_start") or 0.0) + clip_timeline_duration_sec(payload)


def _target_video_clips(project: LiteCutProjectBody, clip_ids: list[str], scope: str):
    main = _main_video_track(project)
    if not main:
        return []
    clips = list(main.clips)
    if scope == "selection" and clip_ids:
        wanted = set(clip_ids)
        clips = [c for c in clips if c.id in wanted]
    return clips


def apply_text_style(
    project: LiteCutProjectBody,
    preset: TextStylePresetBody,
    *,
    clip_ids: list[str] | None = None,
    scope: str = "project",
) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    targets = _target_video_clips(out, clip_ids or [], scope)
    anchor_clips = targets if targets else (_main_video_track(out).clips if _main_video_track(out) else [])
    if not anchor_clips and _main_video_track(out):
        anchor_clips = list(_main_video_track(out).clips)

    for clip in anchor_clips:
        meta = clip.meta if isinstance(clip.meta, dict) else {}
        content = _resolve_placeholder(preset.content_template, meta)
        layer = OverlayLayer(
            id=_new_overlay_id(),
            type="text",
            timeline_start=clip.timeline_start,
            duration=max(1.0, _clip_end_sec(clip) - clip.timeline_start),
            text=OverlayText(
                content=content,
                font_family=preset.font_family,
                font_file=preset.font_file,
                font_size=preset.font_size,
                font_weight=preset.font_weight,
                line_height=preset.line_height,
                letter_spacing=preset.letter_spacing,
                align=preset.align,
                preset_id=preset.preset_id,
                fill_color=preset.fill_color,
            ),
        )
        out.overlays.append(layer)
        _append_single_overlay_transition(out, layer, "in", preset.anim_in)
        _append_single_overlay_transition(out, layer, "out", preset.anim_out)
    return out


def apply_color_grade(
    project: LiteCutProjectBody,
    preset: ColorGradePresetBody,
    *,
    clip_ids: list[str] | None = None,
    scope: str = "project",
) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    grade = ColorGrade(
        brightness=preset.brightness,
        contrast=preset.contrast,
        saturation=preset.saturation,
        filter_preset=preset.filter_preset,
    )

    def _apply_to_clip(clip) -> None:
        clip.color = grade

    if preset.apply_to == "all_video":
        for track in out.tracks:
            if track.type == "video":
                for clip in track.clips:
                    _apply_to_clip(clip)
        return out

    if preset.apply_to == "all_visual":
        for track in out.tracks:
            if track.type == "video":
                for clip in track.clips:
                    _apply_to_clip(clip)
        for overlay in out.overlays:
            raw = overlay.model_dump(mode="python")
            kind = visual_material_kind(raw)
            if "color" in visual_material_capabilities(kind):
                overlay.color = grade
        return out

    main = _main_video_track(out)
    if not main:
        return out

    if preset.apply_to == "v1_main" or scope == "project":
        targets = main.clips
    else:
        targets = _target_video_clips(out, clip_ids or [], scope)

    for clip in targets:
        _apply_to_clip(clip)
    return out


def apply_transition_rhythm(
    project: LiteCutProjectBody,
    preset: TransitionRhythmPresetBody,
) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    main = _main_video_track(out)
    if not main or len(main.clips) < 2:
        return out

    clips = sorted(main.clips, key=lambda c: c.timeline_start)
    main_clip_ids = {clip.id for clip in clips}
    out.transitions = [
        event for event in out.transitions
        if not (
            (event.from_ is not None and event.from_.kind == "clip" and event.from_.track_id == main.id and event.from_.id in main_clip_ids)
            or (event.to is not None and event.to.kind == "clip" and event.to.track_id == main.id and event.to.id in main_clip_ids)
        )
    ]
    for i, clip in enumerate(clips[:-1]):
        t_type = preset.default_type
        if preset.flash_every_n and preset.flash_every_n > 0 and (i + 1) % preset.flash_every_n == 0:
            t_type = preset.flash_type
        spec = normalize_transition_spec(t_type, preset.default_duration_sec)
        next_clip = clips[i + 1]
        if spec["type"] == "cut":
            continue
        contiguous = abs(_clip_end_sec(clip) - next_clip.timeline_start) <= 0.05
        out.transitions.append(TransitionEvent(
            id=f"tr-{uuid.uuid4().hex[:12]}",
            type=spec["type"],
            duration_sec=spec["duration_sec"],
            from_=TransitionEndpoint(kind="clip", track_id=main.id, id=clip.id),
            # Adjacent materials share one centered edit-point event. Across a
            # gap the same rhythm becomes a full exit against transparent canvas.
            to=TransitionEndpoint(kind="clip", track_id=main.id, id=next_clip.id) if contiguous else None,
        ))
    return out


def apply_audio_mix(project: LiteCutProjectBody, preset: AudioMixPresetBody) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    out.audio.master_volume = preset.master_volume
    out.audio.bgm = copy.deepcopy(preset.bgm)
    return out


def _overlay_duration_sec(layer: OverlayRecipeLayer, clip) -> float:
    if layer.duration_sec == "clip_length":
        return max(0.5, _clip_end_sec(clip) - clip.timeline_start)
    try:
        return float(layer.duration_sec)
    except (TypeError, ValueError):
        return 3.0


def _anchor_start_sec(anchor: str, clip, project: LiteCutProjectBody) -> float:
    if anchor == "timeline_start":
        return 0.0
    if anchor == "clip_end":
        return _clip_end_sec(clip)
    if anchor == "each_clip_start" or anchor == "clip_start":
        return clip.timeline_start
    return clip.timeline_start


def apply_overlay_recipe(
    project: LiteCutProjectBody,
    preset: OverlayRecipePresetBody,
) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    main = _main_video_track(out)
    if not main:
        return out

    for layer_def in preset.layers:
        if layer_def.anchor == "each_clip_start":
            anchor_clips = list(main.clips)
        elif layer_def.anchor == "timeline_start":
            anchor_clips = [main.clips[0]] if main.clips else []
        else:
            anchor_clips = list(main.clips)

        for clip in anchor_clips:
            start = _anchor_start_sec(layer_def.anchor, clip, out) + layer_def.offset_sec
            duration = _overlay_duration_sec(layer_def, clip)
            meta = clip.meta if isinstance(clip.meta, dict) else {}
            text_body: Optional[OverlayText] = None
            if layer_def.type == "text" and layer_def.text_style:
                ts = layer_def.text_style
                content = _resolve_placeholder(ts.content_template, meta)
                text_body = OverlayText(
                    content=content,
                    font_family=ts.font_family,
                    font_file=ts.font_file,
                    font_size=ts.font_size,
                    font_weight=ts.font_weight,
                    line_height=ts.line_height,
                    letter_spacing=ts.letter_spacing,
                    align=ts.align,
                    preset_id=ts.preset_id,
                )
            overlay = OverlayLayer(
                id=_new_overlay_id(),
                type=layer_def.type,
                timeline_start=start,
                duration=duration,
                text=text_body,
                asset_path=layer_def.asset_path,
            )
            out.overlays.append(overlay)
            if layer_def.text_style:
                _append_single_overlay_transition(out, overlay, "in", layer_def.text_style.anim_in)
                _append_single_overlay_transition(out, overlay, "out", layer_def.text_style.anim_out)
    return out


def apply_packaging_bundle(
    project: LiteCutProjectBody,
    bundle: PackagingBundleBody,
    *,
    clip_ids: list[str] | None = None,
    scope: str = "project",
    include: list[str] | None = None,
) -> LiteCutProjectBody:
    out = copy.deepcopy(project)
    keys = set(include) if include else None

    def _want(key: str) -> bool:
        return keys is None or key in keys

    if bundle.color_grade and _want("color_grade"):
        out = apply_color_grade(out, bundle.color_grade, clip_ids=clip_ids, scope=scope)
    if bundle.transition_rhythm and _want("transition_rhythm"):
        out = apply_transition_rhythm(out, bundle.transition_rhythm)
    if bundle.text_styles and _want("text_style"):
        for ts in bundle.text_styles:
            out = apply_text_style(out, ts, clip_ids=clip_ids, scope=scope)
    if bundle.overlay_recipe and _want("overlay_recipe"):
        out = apply_overlay_recipe(out, bundle.overlay_recipe)
    if _want("audio_mix"):
        if bundle.audio_mix:
            out = apply_audio_mix(out, bundle.audio_mix)
        elif bundle.bgm:
            out.audio.bgm = copy.deepcopy(bundle.bgm)
    return out


def apply_preset_to_project(
    project: LiteCutProjectBody | dict[str, Any],
    preset_kind: str,
    preset_body: dict[str, Any],
    *,
    clip_ids: list[str] | None = None,
    scope: str = "project",
    include: list[str] | None = None,
) -> LiteCutProjectBody:
    """Dispatch preset kind → updated project body."""
    if isinstance(project, dict):
        base = read_project_body(project)
    else:
        base = copy.deepcopy(project)

    kind = str(preset_kind).strip()
    if kind == "text_style":
        return apply_text_style(base, TextStylePresetBody.model_validate(preset_body), clip_ids=clip_ids, scope=scope)
    if kind == "color_grade":
        return apply_color_grade(base, ColorGradePresetBody.model_validate(preset_body), clip_ids=clip_ids, scope=scope)
    if kind == "transition_rhythm":
        return apply_transition_rhythm(base, TransitionRhythmPresetBody.model_validate(preset_body))
    if kind == "audio_mix":
        return apply_audio_mix(base, AudioMixPresetBody.model_validate(preset_body))
    if kind == "overlay_recipe":
        return apply_overlay_recipe(base, OverlayRecipePresetBody.model_validate(preset_body))
    if kind == "packaging_bundle":
        return apply_packaging_bundle(
            base,
            PackagingBundleBody.model_validate(preset_body),
            clip_ids=clip_ids,
            scope=scope,
            include=include,
        )
    raise ValueError(f"unsupported preset kind: {kind}")


def parse_project_body(raw: dict[str, Any] | None) -> LiteCutProjectBody:
    """Project decoding facade owned by project_codec."""
    return read_project_body(raw)
