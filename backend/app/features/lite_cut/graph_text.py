"""Text material renderer feeding the canonical scene compositor."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .graph_scene import _scene_composite_filter_complex
from .scene_transform import OVERLAY_SCENE_DEFAULTS, normalize_scene_transform
from .text_layout import (
    builtin_text_font_path,
    drawtext_line_spacing,
    normalize_text_layout,
    text_style_drawtext_options,
)
from .timeline_math import clip_duration_sec as _clip_duration_sec


TEXT_SCENE_DEFAULTS = {
    **OVERLAY_SCENE_DEFAULTS,
    "x": 0.5,
    "y": 0.22,
    "width": 0.65,
    "height": 0.18,
}


def _default_text_font_file() -> str:
    font = builtin_text_font_path("Noto Sans SC", 700)
    return str(font) if font.is_file() else ""


def _builtin_text_font_file(font_family: str, font_weight: Any = None) -> str:
    path = builtin_text_font_path(font_family, font_weight)
    return str(path) if path.is_file() else _default_text_font_file()


def _escape_drawtext_value(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
    )

def _ffmpeg_filter_path(path: str) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")


def _text_style_drawtext_options(preset_id: str, fill_color: Any = None) -> list[str]:
    return text_style_drawtext_options(preset_id, fill_color)


def _drawtext_filter_complex(
    *,
    text_clip: dict[str, Any],
    enable_expr: str,
    canvas_width: int = 1920,
    canvas_height: int = 1080,
    fps: float = 60.0,
) -> str:
    """Render text into its authored box, then apply the universal transform."""
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    meta = text_clip.get("meta") if isinstance(text_clip.get("meta"), dict) else {}
    transform = normalize_scene_transform(text_clip.get("transform"), TEXT_SCENE_DEFAULTS)
    duration = _clip_duration_sec(text_clip)
    start = max(0.0, float(text_clip.get("timeline_start") or 0))
    box_width = max(1, int(round(int(canvas_width) * transform["width"])))
    box_height = max(1, int(round(int(canvas_height) * transform["height"])))
    layout = normalize_text_layout(text)
    font_size = layout["font_size"]
    line_height = layout["line_height"]
    align = layout["align"]
    x_expression = {"left": "0", "center": "(w-text_w)/2", "right": "w-text_w"}[align]
    content = _escape_drawtext_value(str(text.get("content") or meta.get("name") or "Text"))
    preset_id = str(text.get("preset_id") or meta.get("textStyleId") or layout["preset_id"])
    font_file = str(text.get("font_file") or "").strip() or _builtin_text_font_file(
        layout["font_family"], layout["font_weight"]
    )
    line_spacing = drawtext_line_spacing(font_file, font_size, line_height)
    options = [
        f"text='{content}'",
        f"fontsize={font_size}",
        f"line_spacing={line_spacing}",
        f"text_align={align}",
        f"x='{x_expression}'",
        "y='(h-text_h)/2'",
        *_text_style_drawtext_options(preset_id, text.get("fill_color")),
    ]
    if font_file:
        options.insert(0, f"fontfile='{_ffmpeg_filter_path(font_file)}'")
    transition_events = text_clip.get("_transition_events") if isinstance(text_clip.get("_transition_events"), list) else []
    authored_end = start + duration
    render_start = min([start, *(float(item.get("start_sec") or start) for item in transition_events if isinstance(item, dict))])
    render_end = max([authored_end, *(float(item.get("end_sec") or authored_end) for item in transition_events if isinstance(item, dict))])
    fps_value = max(1.0, min(1000.0, float(fps or 60.0)))
    fps_text = f"{fps_value:.6f}".rstrip("0").rstrip(".")
    material_graph = (
        f"color=c=black@0:s={box_width}x{box_height}:r={fps_text}:d={max(0.1, render_end - render_start):.9f},"
        f"format=rgba,drawtext={':'.join(options)},setpts=PTS-STARTPTS+{render_start:.9f}/TB[scene_text_material]"
    )
    return _scene_composite_filter_complex(
        material_graph=material_graph,
        material_label="[scene_text_material]",
        transform=transform,
        keyframes=text_clip.get("keyframes"),
        enable_expr=enable_expr,
        timeline_start=start,
        duration=duration,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        content_fit="fill",
        defaults=TEXT_SCENE_DEFAULTS,
        flip_horizontal=bool(text_clip.get("flip_horizontal")),
        flip_vertical=bool(text_clip.get("flip_vertical")),
        transition_events=transition_events,
    )
