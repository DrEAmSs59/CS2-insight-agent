"""Compatibility facade for LiteCut FFmpeg graph builders.

Implementations are owned by the concern-specific graph modules. This module
preserves historical private imports used by composer.py and protection tests.
"""

from .font_executor import (
    _ascii_ffmpeg_font_cache_dir,
    _stage_custom_font_for_ffmpeg,
)
from .graph_audio import (
    _atempo_chain,
    _audio_filter_chain,
    _audio_mix_filter_complex,
    _pitch_shift_speed_chain,
)
from .graph_canvas import _clip_canvas_transform_graph
from .graph_clip import (
    _FILTER_PRESET_VF,
    _build_color_vf,
    _clip_video_filter_chain,
    _eq_filter,
    _user_eq_filter,
)
from .graph_overlay import (
    _ffmpeg_expr_time_variable,
    _overlay_filter_complex,
    _overlay_height_from_transform,
    _overlay_keyframe_expr,
    _overlay_layout_from_transform,
    _overlay_opacity_from_transform,
)
from .graph_text import (
    _builtin_text_font_file,
    _default_text_font_file,
    _drawtext_alpha_expr,
    _drawtext_filter_complex,
    _drawtext_position_expr,
    _escape_drawtext_value,
    _ffmpeg_filter_path,
    _text_style_drawtext_options,
)
from .graph_transition import (
    _background_boundary_transition_parts,
    _boundary_transition_filter_complex,
)

__all__ = [name for name in globals() if name.startswith("_") and not name.startswith("__")]
