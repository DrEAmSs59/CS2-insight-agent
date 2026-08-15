"""Pure projection of project-level schema fields into export settings."""

from __future__ import annotations

from typing import Any, Optional

from .project_boundaries import (
    AUDIO_MASTER_GAIN_DEFAULT,
    AUDIO_MASTER_GAIN_MAX,
    AUDIO_MASTER_GAIN_MIN,
    CANVAS_BLUR_DEFAULT,
    CANVAS_BLUR_MAX,
    CANVAS_BLUR_MIN,
    CANVAS_FIT_VALUES,
    OUTPUT_FPS_DEFAULT,
    OUTPUT_FPS_MAX,
    OUTPUT_FPS_MIN,
    OUTPUT_HEIGHT_DEFAULT,
    OUTPUT_HEIGHT_MAX,
    OUTPUT_HEIGHT_MIN,
    OUTPUT_WIDTH_DEFAULT,
    OUTPUT_WIDTH_MAX,
    OUTPUT_WIDTH_MIN,
)


def project_master_volume(body: dict[str, Any]) -> float:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    try:
        volume = float(audio.get("master_volume") if audio.get("master_volume") is not None else AUDIO_MASTER_GAIN_DEFAULT)
    except Exception:
        volume = AUDIO_MASTER_GAIN_DEFAULT
    return max(AUDIO_MASTER_GAIN_MIN, min(AUDIO_MASTER_GAIN_MAX, volume))


def project_output_settings(body: dict[str, Any], ref: dict[str, Any]) -> tuple[int, int, float]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}

    def integer_setting(key: str, fallback: int, low: int, high: int) -> int:
        try:
            value = int(output.get(key) if output.get(key) is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(low, min(high, value))

    try:
        fps = float(output.get("fps") if output.get("fps") is not None else float(ref.get("fps") or OUTPUT_FPS_DEFAULT))
    except (TypeError, ValueError):
        fps = float(ref.get("fps") or OUTPUT_FPS_DEFAULT)
    return (
        integer_setting("width", int(ref.get("width") or OUTPUT_WIDTH_DEFAULT), OUTPUT_WIDTH_MIN, OUTPUT_WIDTH_MAX),
        integer_setting("height", int(ref.get("height") or OUTPUT_HEIGHT_DEFAULT), OUTPUT_HEIGHT_MIN, OUTPUT_HEIGHT_MAX),
        max(OUTPUT_FPS_MIN, min(OUTPUT_FPS_MAX, fps)),
    )


def project_encoder_tier(body: dict[str, Any]) -> str:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    return "fast" if str(output.get("encoder_tier") or "").strip().lower() == "fast" else "quality"


def ffmpeg_color(value: Any) -> str:
    raw = str(value or "").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) in (3, 6) and all(character in "0123456789abcdefABCDEF" for character in raw):
        if len(raw) == 3:
            raw = "".join(character * 2 for character in raw)
        return f"0x{raw.lower()}"
    return "black"


def project_canvas_settings(body: dict[str, Any]) -> tuple[str, str, int]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    fit = str(output.get("canvas_fit") or "contain").strip().lower()
    if fit not in CANVAS_FIT_VALUES:
        fit = "contain"
    try:
        blur_amount = int(output.get("blur_amount") if output.get("blur_amount") is not None else CANVAS_BLUR_DEFAULT)
    except (TypeError, ValueError):
        blur_amount = CANVAS_BLUR_DEFAULT
    return fit, ffmpeg_color(output.get("background_color")), max(CANVAS_BLUR_MIN, min(CANVAS_BLUR_MAX, blur_amount))


def project_export_range(body: dict[str, Any]) -> tuple[float, Optional[float]]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    if str(output.get("range_mode") or "full").strip().lower() != "custom":
        return 0.0, None
    try:
        start_sec = max(0.0, float(output.get("range_start_sec") or 0.0))
    except (TypeError, ValueError):
        start_sec = 0.0
    end_sec: Optional[float] = None
    if output.get("range_end_sec") is not None:
        try:
            parsed_end = float(output["range_end_sec"])
            if parsed_end > start_sec + 0.05:
                end_sec = parsed_end
        except (TypeError, ValueError):
            end_sec = None
    return (0.0, None) if start_sec <= 0.0 and end_sec is None else (start_sec, end_sec)
