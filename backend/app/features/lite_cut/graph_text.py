"""Text/drawtext graph builders for LiteCut exports."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .graph_overlay import _overlay_opacity_from_transform
from .timeline import _clip_visual_fade, _map_transition_type
from .timeline_math import clip_duration_sec as _clip_duration_sec


def _default_text_font_file() -> str:
    font = Path(__file__).resolve().parents[3] / "assets" / "fonts" / "NotoSansSC-Bold.ttf"
    return str(font) if font.is_file() else ""

def _builtin_text_font_file(font_family: str) -> str:
    normalized_family = str(font_family or "").strip().lower()
    filename = {
        "noto sans sc": "NotoSansSC-Bold.ttf",
        "思源黑体 medium": "NotoSansSC-Medium.ttf",
        # Legacy projects using Rajdhani are intentionally rendered with the
        # stable Chinese fallback after Rajdhani was removed from LiteCut.
        "rajdhani bold": "NotoSansSC-Bold.ttf",
        "rajdhani": "NotoSansSC-Bold.ttf",
    }.get(normalized_family)
    system_filename = {
        "微软雅黑": "msyhbd.ttc",
        "impact": "impact.ttf",
    }.get(normalized_family)
    if system_filename:
        windows_font = Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts" / system_filename
        if windows_font.is_file():
            return str(windows_font)
    if not filename:
        return _default_text_font_file()
    path = Path(__file__).resolve().parents[3] / "assets" / "fonts" / filename
    return str(path) if path.is_file() else _default_text_font_file()

def _escape_drawtext_value(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        # Pass real line-feed characters to drawtext. This FFmpeg build
        # renders an escaped `\\n` as a literal n instead of a line break.
    )

def _ffmpeg_filter_path(path: str) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")

def _text_style_drawtext_options(preset_id: str) -> list[str]:
    preset = str(preset_id or "plain").strip().lower()
    color = {
        "ace": "0xfbbf24",
        "clutch": "0x67e8f9",
        "creator": "0xfde047",
        "retro": "0xf0abfc",
        "bubble": "0x111827",
        "plain": "white",
        "large-title": "white",
        "namecard": "white",
    }.get(preset, "white")
    opts = [f"fontcolor={color}", "borderw=3", "bordercolor=black@0.72"]
    if preset == "bubble":
        opts.extend(["box=1", "boxcolor=white@0.95", "boxborderw=18"])
    return opts

def _drawtext_alpha_expr(text_clip: dict[str, Any], opacity: float) -> str | None:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    start = max(0.0, float(text_clip.get("timeline_start") or 0))
    duration = _clip_duration_sec(text_clip)
    end = start + duration
    fade_in = _clip_visual_fade(text_clip, "fade_in_sec")
    fade_out = _clip_visual_fade(text_clip, "fade_out_sec")
    anim_dur = min(0.45, duration)
    if str(text.get("anim_in") or "").strip().lower() == "fade":
        fade_in = max(fade_in, anim_dur)
    if str(text.get("anim_out") or "").strip().lower() == "fade":
        fade_out = max(fade_out, anim_dur)
    # Text uses a drawtext-compatible version of clip transitions. Slides are
    # represented by the position expression below; all other transition
    # styles fade text so preview and export keep the same visible timing.
    transition_in = text_clip.get("transition_in") if isinstance(text_clip.get("transition_in"), dict) else None
    transition_out = text_clip.get("transition_out") if isinstance(text_clip.get("transition_out"), dict) else None
    slide_types = {"slide_left", "slide_right", "slide_up", "slide_down"}
    def transition_duration(spec: dict[str, Any] | None) -> float:
        try:
            return min(duration, max(0.0, float((spec or {}).get("duration_sec") or 0)))
        except (TypeError, ValueError):
            return 0.0

    if transition_in and _map_transition_type(str(transition_in.get("type") or "cut")) not in slide_types:
        fade_in = max(fade_in, transition_duration(transition_in))
    if transition_out and _map_transition_type(str(transition_out.get("type") or "cut")) not in slide_types:
        fade_out = max(fade_out, transition_duration(transition_out))
    if opacity >= 0.999 and fade_in <= 0 and fade_out <= 0:
        return None
    expr = f"{opacity:.6f}"
    if fade_in > 0:
        expr = f"if(lt(t\\,{start + fade_in:.6f})\\,{opacity:.6f}*(t-{start:.6f})/{fade_in:.6f}\\,{expr})"
    if fade_out > 0:
        out_start = max(start, end - fade_out)
        expr = f"if(gt(t\\,{out_start:.6f})\\,{opacity:.6f}*({end:.6f}-t)/{fade_out:.6f}\\,{expr})"
    return f"'{expr}'"

def _drawtext_position_expr(
    text_clip: dict[str, Any],
    tx: float,
    ty: float,
    *,
    x_anchor_expr: str | None = None,
    y_anchor_expr: str | None = None,
) -> tuple[str, str]:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    start = max(0.0, float(text_clip.get("timeline_start") or 0))
    duration = _clip_duration_sec(text_clip)
    end = start + duration
    anim_dur = min(0.45, duration)
    x_expr = x_anchor_expr or f"w*{tx:.6f}-text_w/2"
    y_expr = y_anchor_expr or f"h*{ty:.6f}-text_h/2"
    if anim_dur <= 0:
        return x_expr, y_expr

    def apply_slide_in(expr: str, offset: str, anim: str, axis: str) -> str:
        if anim not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        sign = 1 if anim in {"slide_left", "slide_up"} else -1
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*(1-(t-{start:.6f})/{anim_dur:.6f})"
        return f"if(lt(t\\,{start + anim_dur:.6f})\\,{moved}\\,{expr})" if axis in anim else expr

    def apply_slide_out(expr: str, offset: str, anim: str, axis: str) -> str:
        if anim not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        sign = -1 if anim in {"slide_left", "slide_up"} else 1
        out_start = max(start, end - anim_dur)
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*((t-{out_start:.6f})/{anim_dur:.6f})"
        return f"if(gt(t\\,{out_start:.6f})\\,{moved}\\,{expr})" if axis in anim else expr

    anim_in = str(text.get("anim_in") or "").strip().lower()
    anim_out = str(text.get("anim_out") or "").strip().lower()
    x_expr = apply_slide_in(x_expr, "w*0.120000", anim_in, "left") if "left" in anim_in or "right" in anim_in else x_expr
    x_expr = apply_slide_in(x_expr, "w*0.120000", anim_in, "right") if "left" in anim_in or "right" in anim_in else x_expr
    y_expr = apply_slide_in(y_expr, "h*0.100000", anim_in, "up") if "up" in anim_in or "down" in anim_in else y_expr
    y_expr = apply_slide_in(y_expr, "h*0.100000", anim_in, "down") if "up" in anim_in or "down" in anim_in else y_expr
    x_expr = apply_slide_out(x_expr, "w*0.120000", anim_out, "left") if "left" in anim_out or "right" in anim_out else x_expr
    x_expr = apply_slide_out(x_expr, "w*0.120000", anim_out, "right") if "left" in anim_out or "right" in anim_out else x_expr
    y_expr = apply_slide_out(y_expr, "h*0.100000", anim_out, "up") if "up" in anim_out or "down" in anim_out else y_expr
    y_expr = apply_slide_out(y_expr, "h*0.100000", anim_out, "down") if "up" in anim_out or "down" in anim_out else y_expr

    def apply_transition_slide(expr: str, offset: str, spec: dict[str, Any] | None, axis: str, entering: bool) -> str:
        if not spec:
            return expr
        transition_type = _map_transition_type(str(spec.get("type") or "cut"))
        if axis not in transition_type or transition_type not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        try:
            transition_duration = max(0.0, min(duration, float(spec.get("duration_sec") or 0)))
        except (TypeError, ValueError):
            transition_duration = 0.0
        if transition_duration <= 0:
            return expr
        # Incoming left/up transitions begin on the positive side; outgoing
        # transitions leave in their named direction. This mirrors
        # textTransitionPreviewVisual in the editor.
        if entering:
            sign = 1 if transition_type in {"slide_left", "slide_up"} else -1
            moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*(1-(t-{start:.6f})/{transition_duration:.6f})"
            return f"if(lt(t\\,{start + transition_duration:.6f})\\,{moved}\\,{expr})"
        sign = -1 if transition_type in {"slide_left", "slide_up"} else 1
        out_start = max(start, end - transition_duration)
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*((t-{out_start:.6f})/{transition_duration:.6f})"
        return f"if(gt(t\\,{out_start:.6f})\\,{moved}\\,{expr})"

    transition_in = text_clip.get("transition_in") if isinstance(text_clip.get("transition_in"), dict) else None
    transition_out = text_clip.get("transition_out") if isinstance(text_clip.get("transition_out"), dict) else None
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_in, "left", True)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_in, "right", True)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_in, "up", True)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_in, "down", True)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_out, "left", False)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_out, "right", False)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_out, "up", False)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_out, "down", False)
    return x_expr, y_expr

def _drawtext_filter_complex(*, text_clip: dict[str, Any], enable_expr: str, canvas_width: int = 1920, canvas_height: int = 1080) -> str:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    meta = text_clip.get("meta") if isinstance(text_clip.get("meta"), dict) else {}
    transform = text_clip.get("transform") if isinstance(text_clip.get("transform"), dict) else {}
    tx = max(0.0, min(1.0, float(transform.get("x", 0.5))))
    ty = max(0.0, min(1.0, float(transform.get("y", 0.22))))
    scale = max(0.1, min(5.0, float(transform.get("scale", 1.0))))
    box_height = max(0.02, min(10.0, float(transform.get("height", 0.18))))
    box_width = max(0.02, min(10.0, float(transform.get("width", 0.65))))
    base_font_size = float(text.get("font_size") or 64)
    content = _escape_drawtext_value(str(text.get("content") or meta.get("name") or "Text"))
    # font_size is stored in output-canvas pixels. The browser preview scales
    # those pixels with the canvas; export must use the exact same value.
    font_size = max(1, min(2000, int(round(base_font_size * scale))))
    text_align = str(text.get("align") or "center").strip().lower()
    if text_align not in {"left", "center", "right"}:
        text_align = "center"
    # Text scale only changes glyph size, while the authored box remains the
    # paragraph-alignment area.  ``transform.x`` anchors the rendered text
    # block itself (as in the browser preview), not the fixed-width box: left
    # and right alignment must therefore offset the box so the widest line
    # stays centred on the authored anchor.
    box_width_px = max(1, int(round(canvas_width * box_width)))
    box_height_px = max(1, int(round(canvas_height * box_height)))
    preset_id = str(text.get("preset_id") or meta.get("textStyleId") or "plain")
    font_file = str(text.get("font_file") or "").strip() or _builtin_text_font_file(str(text.get("font_family") or ""))
    opacity = _overlay_opacity_from_transform(transform)
    if text_align == "left":
        x_anchor_expr = f"w*{tx:.6f}-text_w/2"
    elif text_align == "right":
        x_anchor_expr = f"w*{tx:.6f}-w*{box_width:.6f}+text_w/2"
    else:
        x_anchor_expr = f"w*{tx:.6f}-w*{box_width:.6f}/2"
    x_expr, y_expr = _drawtext_position_expr(
        text_clip,
        tx,
        ty,
        x_anchor_expr=x_anchor_expr,
        y_anchor_expr=f"h*{ty:.6f}-h*{box_height:.6f}/2+(h*{box_height:.6f}-text_h)/2",
    )
    opts = [
        f"text='{content}'",
        f"fontsize={font_size}",
        f"text_align={text_align}",
        f"boxw={box_width_px}",
        f"boxh={box_height_px}",
        f"x='{x_expr}'",
        f"y='{y_expr}'",
        f"enable='{enable_expr}'",
        *_text_style_drawtext_options(preset_id),
    ]
    alpha_expr = _drawtext_alpha_expr(text_clip, opacity)
    if alpha_expr:
        opts.append(f"alpha={alpha_expr}")
    if font_file:
        opts.insert(0, f"fontfile='{_ffmpeg_filter_path(font_file)}'")
    return "[0:v]drawtext=" + ":".join(opts) + "[vout]"
