"""Canonical text layout contract shared by preview-facing APIs and export."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import ImageFont

from .effect_contract import load_effect_contract


_CONTRACT = load_effect_contract()
TEXT_LAYOUT_CONTRACT: dict[str, Any] = dict(_CONTRACT["text_layout"])
TEXT_STYLE_PRESETS: tuple[dict[str, Any], ...] = tuple(
    dict(item) for item in _CONTRACT.get("text_style_presets", []) if isinstance(item, dict)
)
TEXT_FONT_CATALOG: tuple[dict[str, Any], ...] = tuple(
    dict(item) for item in _CONTRACT.get("text_fonts", []) if isinstance(item, dict)
)

_FONT_SIZE = TEXT_LAYOUT_CONTRACT["font_size"]
_FONT_WEIGHT = TEXT_LAYOUT_CONTRACT["font_weight"]
_LINE_HEIGHT = TEXT_LAYOUT_CONTRACT["line_height"]
_LETTER_SPACING = TEXT_LAYOUT_CONTRACT["letter_spacing"]

TEXT_FONT_SIZE_MIN = int(_FONT_SIZE["min"])
TEXT_FONT_SIZE_MAX = int(_FONT_SIZE["max"])
TEXT_FONT_SIZE_DEFAULT = int(_FONT_SIZE["default"])
TEXT_FONT_WEIGHT_MIN = int(_FONT_WEIGHT["min"])
TEXT_FONT_WEIGHT_MAX = int(_FONT_WEIGHT["max"])
TEXT_FONT_WEIGHT_DEFAULT = int(_FONT_WEIGHT["default"])
TEXT_LINE_HEIGHT_MIN = float(_LINE_HEIGHT["min"])
TEXT_LINE_HEIGHT_MAX = float(_LINE_HEIGHT["max"])
TEXT_LINE_HEIGHT_DEFAULT = float(_LINE_HEIGHT["default"])
TEXT_LETTER_SPACING_DEFAULT = float(_LETTER_SPACING["default"])
TEXT_DEFAULT_FONT_FAMILY = str(TEXT_LAYOUT_CONTRACT["default_font_family"])
TEXT_DEFAULT_PRESET_ID = str(TEXT_LAYOUT_CONTRACT["default_preset_id"])


def _bounded_number(value: Any, *, minimum: float, maximum: float, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def normalize_text_font_size(value: Any) -> int:
    return int(round(_bounded_number(
        value,
        minimum=TEXT_FONT_SIZE_MIN,
        maximum=TEXT_FONT_SIZE_MAX,
        default=TEXT_FONT_SIZE_DEFAULT,
    )))


def normalize_text_font_weight(value: Any) -> int:
    return int(round(_bounded_number(
        value,
        minimum=TEXT_FONT_WEIGHT_MIN,
        maximum=TEXT_FONT_WEIGHT_MAX,
        default=TEXT_FONT_WEIGHT_DEFAULT,
    )))


def normalize_text_line_height(value: Any) -> float:
    return _bounded_number(
        value,
        minimum=TEXT_LINE_HEIGHT_MIN,
        maximum=TEXT_LINE_HEIGHT_MAX,
        default=TEXT_LINE_HEIGHT_DEFAULT,
    )


def normalize_text_align(value: Any) -> str:
    align = str(value or "center").strip().lower()
    return align if align in {"left", "center", "right"} else "center"


def text_style_preset(preset_id: Any) -> dict[str, Any]:
    requested = str(preset_id or TEXT_DEFAULT_PRESET_ID).strip().lower()
    for preset in TEXT_STYLE_PRESETS:
        if str(preset.get("id") or "").lower() == requested:
            return preset
    for preset in TEXT_STYLE_PRESETS:
        if str(preset.get("id") or "").lower() == TEXT_DEFAULT_PRESET_ID:
            return preset
    return {"id": TEXT_DEFAULT_PRESET_ID, "fill_color": "#ffffff"}


def _font_entry_for_family(font_family: Any) -> dict[str, Any]:
    requested = str(font_family or TEXT_DEFAULT_FONT_FAMILY).strip().casefold()
    for entry in TEXT_FONT_CATALOG:
        names = [entry.get("family"), *(entry.get("aliases") or [])]
        if requested in {str(name or "").strip().casefold() for name in names}:
            return entry
    for entry in TEXT_FONT_CATALOG:
        if str(entry.get("family") or "").strip().casefold() == TEXT_DEFAULT_FONT_FAMILY.casefold():
            return entry
    raise RuntimeError("LiteCut text font catalog has no default font")


def canonical_text_font_family(font_family: Any) -> str:
    return str(_font_entry_for_family(font_family)["family"])


def resolve_builtin_text_font_face(font_family: Any, font_weight: Any = None) -> dict[str, Any]:
    entry = _font_entry_for_family(font_family)
    weight = normalize_text_font_weight(
        entry.get("default_weight") if font_weight in (None, "") else font_weight
    )
    faces = [dict(face) for face in entry.get("faces", []) if isinstance(face, dict)]
    face = next(
        (
            candidate
            for candidate in faces
            if int(candidate.get("weight_min", TEXT_FONT_WEIGHT_MIN))
            <= weight
            <= int(candidate.get("weight_max", TEXT_FONT_WEIGHT_MAX))
        ),
        faces[0] if faces else {},
    )
    return {
        **face,
        "family": str(entry["family"]),
        "weight": weight,
    }


def _bundled_font_directory() -> Path:
    return Path(__file__).resolve().parents[3] / "assets" / "fonts"


def builtin_text_font_path(font_family: Any, font_weight: Any = None) -> Path:
    face = resolve_builtin_text_font_face(font_family, font_weight)
    filename = str(face.get("file") or "")
    if face.get("source") == "windows":
        path = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / filename
    else:
        path = _bundled_font_directory() / filename
    if path.is_file():
        return path
    fallback = _bundled_font_directory() / "NotoSansSC-Bold.ttf"
    return fallback if fallback.is_file() else path


def builtin_text_font_path_for_filename(font_name: Any) -> Path | None:
    requested = str(font_name or "").strip()
    for entry in TEXT_FONT_CATALOG:
        for face in entry.get("faces", []):
            if not isinstance(face, dict) or str(face.get("file") or "") != requested:
                continue
            if face.get("source") == "windows":
                path = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / requested
            else:
                path = _bundled_font_directory() / requested
            return path if path.is_file() else None
    return None


def normalize_text_layout(text: dict[str, Any] | None) -> dict[str, Any]:
    raw = text if isinstance(text, dict) else {}
    return {
        "font_family": canonical_text_font_family(raw.get("font_family")),
        "font_size": normalize_text_font_size(raw.get("font_size")),
        "font_weight": normalize_text_font_weight(raw.get("font_weight")),
        "line_height": normalize_text_line_height(raw.get("line_height")),
        "letter_spacing": TEXT_LETTER_SPACING_DEFAULT,
        "align": normalize_text_align(raw.get("align")),
        "preset_id": str(raw.get("preset_id") or TEXT_DEFAULT_PRESET_ID),
        "fill_color": str(raw.get("fill_color") or "").lower() or None,
    }


@lru_cache(maxsize=256)
def _font_line_advance_cached(path: str, font_size: int, modified_ns: int, file_size: int) -> int | None:
    del modified_ns, file_size
    try:
        font = ImageFont.truetype(path, font_size)
        advance = int(getattr(font.font, "height", 0) or 0)
        return advance if advance > 0 else None
    except (OSError, ValueError):
        return None


def font_natural_line_advance(font_file: str | Path, font_size: Any) -> int | None:
    path = Path(str(font_file or ""))
    size = normalize_text_font_size(font_size)
    try:
        stat = path.stat()
    except OSError:
        return None
    return _font_line_advance_cached(str(path), size, stat.st_mtime_ns, stat.st_size)


def drawtext_line_spacing(font_file: str | Path, font_size: Any, line_height: Any) -> int:
    """Translate CSS-style baseline advance into FFmpeg drawtext spacing."""
    size = normalize_text_font_size(font_size)
    target_advance = int(round(size * normalize_text_line_height(line_height)))
    natural_advance = font_natural_line_advance(font_file, size)
    if natural_advance is None:
        path = Path(str(font_file or ""))
        if path.is_file() and TEXT_LAYOUT_CONTRACT.get("font_metric_failure_policy") == "reject_export":
            raise ValueError(f"LiteCut cannot read line metrics from font: {path}")
        return 0
    return target_advance - natural_advance


def ffmpeg_color(value: Any, fallback: str = "#ffffff") -> str:
    raw = str(value or fallback).strip().lower()
    if len(raw) == 7 and raw.startswith("#") and all(char in "0123456789abcdef" for char in raw[1:]):
        return f"0x{raw[1:]}"
    return f"0x{fallback.lstrip('#')}"


def text_style_drawtext_options(preset_id: Any, fill_color: Any = None) -> list[str]:
    preset = text_style_preset(preset_id)
    outline = TEXT_LAYOUT_CONTRACT["outline"]
    outline_opacity = _bounded_number(outline.get("opacity"), minimum=0, maximum=1, default=0.72)
    return [
        f"fontcolor={ffmpeg_color(fill_color or preset.get('fill_color'))}",
        f"borderw={int(round(float(outline.get('width_output_px') or 0)))}",
        f"bordercolor={ffmpeg_color(outline.get('color'), '#000000')}@{outline_opacity:g}",
    ]


__all__ = [
    "TEXT_DEFAULT_FONT_FAMILY",
    "TEXT_DEFAULT_PRESET_ID",
    "TEXT_FONT_CATALOG",
    "TEXT_FONT_SIZE_DEFAULT",
    "TEXT_FONT_SIZE_MAX",
    "TEXT_FONT_SIZE_MIN",
    "TEXT_FONT_WEIGHT_DEFAULT",
    "TEXT_FONT_WEIGHT_MAX",
    "TEXT_FONT_WEIGHT_MIN",
    "TEXT_LAYOUT_CONTRACT",
    "TEXT_LINE_HEIGHT_DEFAULT",
    "TEXT_LINE_HEIGHT_MAX",
    "TEXT_LINE_HEIGHT_MIN",
    "TEXT_STYLE_PRESETS",
    "builtin_text_font_path",
    "builtin_text_font_path_for_filename",
    "canonical_text_font_family",
    "drawtext_line_spacing",
    "font_natural_line_advance",
    "normalize_text_align",
    "normalize_text_font_size",
    "normalize_text_font_weight",
    "normalize_text_layout",
    "normalize_text_line_height",
    "resolve_builtin_text_font_face",
    "text_style_drawtext_options",
    "text_style_preset",
]
