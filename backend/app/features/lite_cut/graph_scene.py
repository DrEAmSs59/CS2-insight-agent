"""Single FFmpeg scene compositor for video, image and text materials."""

from __future__ import annotations

from typing import Any

from .scene_transform import (
    OVERLAY_SCENE_DEFAULTS,
    ffmpeg_expr_time_variable,
    normalize_scene_transform,
    scene_transform_expressions,
)
from .transition_events import normalize_transition_type


def _dimension_expression(canvas_size: int, expression: str) -> str:
    return f"max(1\\,round({int(canvas_size)}*({expression})))"


def _scene_composite_filter_complex(
    *,
    material_graph: str,
    material_label: str,
    transform: Any,
    keyframes: Any,
    enable_expr: str,
    timeline_start: float,
    duration: float,
    canvas_width: int,
    canvas_height: int,
    content_fit: str = "fill",
    blur_amount: int = 24,
    base_label: str = "[0:v]",
    output_label: str = "[vout]",
    defaults: dict[str, float] | None = None,
    flip_horizontal: bool = False,
    flip_vertical: bool = False,
    transition_events: Any = None,
) -> str:
    """Transform an RGBA material with the canonical center-anchor contract."""
    start = max(0.0, float(timeline_start))
    dur = max(0.0, float(duration))
    normalized = normalize_scene_transform(transform, defaults or OVERLAY_SCENE_DEFAULTS)
    expressions, animated = scene_transform_expressions(
        normalized,
        keyframes,
        start,
        dur,
        defaults=defaults or OVERLAY_SCENE_DEFAULTS,
    )
    tone_filters: list[str] = []
    wipe_masks: list[str] = []
    transition_alpha_factors: list[str] = []

    for spec in transition_events if isinstance(transition_events, list) else []:
        if not isinstance(spec, dict):
            continue
        transition_type = normalize_transition_type(spec.get("type"))
        event_start = float(spec.get("start_sec") or 0.0)
        event_end = float(spec.get("end_sec") or event_start)
        transition_duration = max(0.0, event_end - event_start)
        if transition_type in {"cut", "none"} or transition_duration <= 0.000001:
            continue
        role = str(spec.get("role") or "to")
        if spec.get("mode") == "boundary" and spec.get("stack") == "lower":
            continue
        factor = f"clip((t-{event_start:.9f})/{transition_duration:.9f}\\,0\\,1)"
        geq_factor = f"clip((T-{event_start:.9f})/{transition_duration:.9f}\\,0\\,1)"
        visibility = factor if role == "to" else f"(1-({factor}))"
        if transition_type in {"fade", "flash", "dip", "zoom"}:
            transition_alpha_factors.append(visibility)
        midpoint = f"(1-abs(2*({factor})-1))"
        if transition_type == "flash":
            tone_filters.append(f"eq=brightness='0.85*{midpoint}':eval=frame")
        elif transition_type == "dip":
            tone_filters.append(f"eq=brightness='-0.95*{midpoint}':eval=frame")
        if transition_type == "zoom":
            zoom = f"(0.82+0.18*({factor}))" if role == "to" else f"(1+0.18*({factor}))"
            expressions["width"] = f"({expressions['width']})*{zoom}"
            expressions["height"] = f"({expressions['height']})*{zoom}"
            animated.update({"width", "height"})
        offset = f"(1-({factor}))" if role == "to" else factor
        if transition_type == "wipe_l":
            if role == "to":
                wipe_masks.append(f"gte(X/W\\,1-({geq_factor}))")
            else:
                wipe_masks.append(f"gte(X/W\\,{geq_factor})")
        elif transition_type == "wipe_r":
            if role == "to":
                wipe_masks.append(f"lte(X/W\\,{geq_factor})")
            else:
                wipe_masks.append(f"lte(X/W\\,1-({geq_factor}))")
        elif transition_type == "slide_up":
            direction = 1 if role == "to" else -1
            expressions["y"] = f"({expressions['y']})+({direction})*({offset})*({expressions['height']})*({expressions['scale']})"
            animated.add("y")
        elif transition_type == "slide_down":
            direction = -1 if role == "to" else 1
            expressions["y"] = f"({expressions['y']})+({direction})*({offset})*({expressions['height']})*({expressions['scale']})"
            animated.add("y")

    width_expression = _dimension_expression(canvas_width, f"({expressions['width']})*({expressions['scale']})")
    height_expression = _dimension_expression(canvas_height, f"({expressions['height']})*({expressions['scale']})")
    scale_eval = ":eval=frame" if animated.intersection({"width", "height", "scale"}) else ""
    fit = str(content_fit or "fill").strip().lower()
    parts = [material_graph] if material_graph else []

    dynamic_dimensions = bool(animated.intersection({"width", "height", "scale"}))
    blur_sigma = max(4, min(80, int(blur_amount)))
    if fit == "contain" and dynamic_dimensions:
        # pad/crop dimensions are init-only in FFmpeg. The fitted pixels are
        # already center-anchored, so an explicit transparent pad is not
        # needed for visible geometry while the box is animated.
        parts.append(
            f"{material_label}scale=w='{width_expression}':h='{height_expression}':force_original_aspect_ratio=decrease{scale_eval},format=rgba[scenebox]"
        )
    elif fit == "contain":
        parts.extend([
            f"{material_label}scale=w='{width_expression}':h='{height_expression}':force_original_aspect_ratio=decrease{scale_eval}[scenefit]",
            f"[scenefit]pad=w='{width_expression}':h='{height_expression}':x='(ow-iw)/2':y='(oh-ih)/2':color=black@0,format=rgba[scenebox]",
        ])
    elif fit == "cover" and not dynamic_dimensions:
        parts.extend([
            f"{material_label}scale=w='{width_expression}':h='{height_expression}':force_original_aspect_ratio=increase{scale_eval}[scenefit]",
            f"[scenefit]crop=w='{width_expression}':h='{height_expression}':x='(iw-ow)/2':y='(ih-oh)/2',format=rgba[scenebox]",
        ])
    elif fit == "blur" and not dynamic_dimensions:
        parts.extend([
            f"{material_label}split=2[scenefg][scenebg]",
            f"[scenebg]scale=w='{width_expression}':h='{height_expression}':force_original_aspect_ratio=increase{scale_eval},crop=w='{width_expression}':h='{height_expression}',gblur=sigma={blur_sigma}[scenebgfit]",
            f"[scenefg]scale=w='{width_expression}':h='{height_expression}':force_original_aspect_ratio=decrease{scale_eval}[scenefgfit]",
            "[scenebgfit][scenefgfit]overlay=x='(W-w)/2':y='(H-h)/2',format=rgba[scenebox]",
        ])
    else:
        parts.append(
            f"{material_label}scale=w='{width_expression}':h='{height_expression}'{scale_eval},format=rgba[scenebox]"
        )

    scene_label = "[scenebox]"
    flips = [name for enabled, name in ((flip_horizontal, "hflip"), (flip_vertical, "vflip")) if enabled]
    if flips:
        parts.append(f"{scene_label}{','.join(flips)}[scenemirror]")
        scene_label = "[scenemirror]"

    rotation_expression = expressions["rotation"]
    if "rotation" in animated or abs(float(rotation_expression)) > 0.000001:
        angle = f"({rotation_expression})*PI/180" if "rotation" in animated else f"{float(rotation_expression) * 3.141592653589793 / 180.0:.12f}"
        parts.append(f"{scene_label}rotate=angle='{angle}':c=none:ow=rotw(iw):oh=roth(ih)[scenerotate]")
        scene_label = "[scenerotate]"

    if wipe_masks:
        alpha_expression = "alpha(X,Y)"
        for mask in wipe_masks:
            alpha_expression += f"*({mask})"
        parts.append(
            f"{scene_label}format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{alpha_expression}'[scenewipe]"
        )
        scene_label = "[scenewipe]"

    if tone_filters:
        parts.append(f"{scene_label}{','.join(tone_filters)}[scenetone]")
        scene_label = "[scenetone]"

    opacity_expression = expressions["opacity"]
    for alpha_factor in transition_alpha_factors:
        opacity_expression = f"({opacity_expression})*({alpha_factor})"
        animated.add("opacity")
    if "opacity" in animated:
        alpha = ffmpeg_expr_time_variable(opacity_expression)
        parts.append(
            f"{scene_label}format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({alpha})'[sceneopacity]"
        )
        scene_label = "[sceneopacity]"
    elif float(opacity_expression) < 0.999999:
        parts.append(f"{scene_label}colorchannelmixer=aa={float(opacity_expression):.9f}[sceneopacity]")
        scene_label = "[sceneopacity]"

    position_x = f"main_w*({expressions['x']})-overlay_w/2"
    position_y = f"main_h*({expressions['y']})-overlay_h/2"
    overlay_eval = "frame" if animated else "init"
    parts.append(
        f"{base_label}{scene_label}overlay=x='{position_x}':y='{position_y}':eval={overlay_eval}:enable='{enable_expr}'{output_label}"
    )
    return ";".join(parts)
