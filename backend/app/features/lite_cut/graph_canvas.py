"""Canvas placement graph builder for LiteCut main-track clips."""

from __future__ import annotations

from typing import Any

from .effect_contract import normalize_video_layer_transform
from .graph_overlay import _ffmpeg_expr_time_variable, _overlay_keyframe_expr
from .graph_transition import _background_boundary_transition_parts


def _clip_canvas_transform_graph(
    input_label: str,
    output_label: str,
    *,
    clip: dict[str, Any],
    fitted_filter: str,
    width: int,
    height: int,
    fps: float,
    duration: float,
    background_color: str,
    transition_in_background: bool = False,
    transition_out_background: bool = False,
) -> str:
    """Place a normalized main-track clip using the editor's canvas coordinates."""
    tr = normalize_video_layer_transform(clip.get("transform"))
    tx = tr["x"]
    ty = tr["y"]
    scale = tr["scale"]
    width_frac = tr["width"] * scale
    height_frac = tr["height"] * scale
    rotation = tr["rotation"]
    opacity = tr["opacity"]
    keyframes = clip.get("keyframes")
    x_expr, dynamic_x = _overlay_keyframe_expr(keyframes, "x", tx, 0.0, duration)
    y_expr, dynamic_y = _overlay_keyframe_expr(keyframes, "y", ty, 0.0, duration)
    width_expr, dynamic_width = _overlay_keyframe_expr(keyframes, "size", width_frac, 0.0, duration)
    height_expr, dynamic_height = _overlay_keyframe_expr(keyframes, "height_size", height_frac, 0.0, duration)
    rotation_expr, dynamic_rotation = _overlay_keyframe_expr(keyframes, "rotation", rotation, 0.0, duration)
    opacity_expr, dynamic_opacity = _overlay_keyframe_expr(keyframes, "opacity", opacity, 0.0, duration)
    dynamic_transform = dynamic_x or dynamic_y or dynamic_width or dynamic_height or dynamic_rotation or dynamic_opacity
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    if dynamic_width or dynamic_height:
        object_filters = (
            f"scale=w='max(2\\,trunc({width}*({width_expr})/2)*2)':"
            f"h='max(2\\,trunc({height}*({height_expr})/2)*2)':eval=frame,format=rgba"
        )
    else:
        target_w = max(2, int(round(width * float(width_expr) / 2) * 2))
        target_h = max(2, int(round(height * float(height_expr) / 2) * 2))
        object_filters = f"scale={target_w}:{target_h},format=rgba"
    if dynamic_opacity:
        opacity_geq = _ffmpeg_expr_time_variable(opacity_expr)
        object_filters += (
            ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
            f"a='alpha(X,Y)*({opacity_geq})'"
        )
    else:
        object_filters += f",colorchannelmixer=aa={float(opacity_expr):.6f}"
    if dynamic_rotation:
        object_filters += (
            f",rotate=angle='({rotation_expr})*PI/180':c=none:"
            "ow='hypot(iw,ih)':oh='hypot(iw,ih)'"
        )
    elif abs(float(rotation_expr)) > 0.001:
        angle = float(rotation_expr) * 3.141592653589793 / 180.0
        object_filters += f",rotate={angle:.8f}:c=none:ow='rotw({angle:.8f})':oh='roth({angle:.8f})'"
    parts = [
        f"{input_label}{fitted_filter},{object_filters}[obj]",
        f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={max(0.1, duration):.6f}[canvas]",
        (
            f"[canvas][obj]overlay=x='W*({x_expr})-w/2':y='H*({y_expr})-h/2':"
            f"eval={'frame' if dynamic_transform else 'init'}:shortest=1,format=yuv420p[scene]"
        ),
    ]
    parts.extend(_background_boundary_transition_parts(
        clip,
        scene_label="[scene]",
        output_label=output_label,
        width=width,
        height=height,
        fps=fps,
        duration=duration,
        background_color=background_color,
        apply_in=transition_in_background,
        apply_out=transition_out_background,
    ))
    return ";".join(parts)

