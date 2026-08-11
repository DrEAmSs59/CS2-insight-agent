"""Pure projection of project-level schema fields into export settings."""

from __future__ import annotations

from typing import Any, Optional


def project_master_volume(body: dict[str, Any]) -> float:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    try:
        volume = float(audio.get("master_volume") if audio.get("master_volume") is not None else 1.0)
    except Exception:
        volume = 1.0
    return max(0.0, min(2.0, volume))


def project_output_settings(body: dict[str, Any], ref: dict[str, Any]) -> tuple[int, int, float]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}

    def integer_setting(key: str, fallback: int, low: int, high: int) -> int:
        try:
            value = int(output.get(key) if output.get(key) is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(low, min(high, value))

    try:
        fps = float(output.get("fps") if output.get("fps") is not None else float(ref.get("fps") or 60))
    except (TypeError, ValueError):
        fps = float(ref.get("fps") or 60)
    return (
        integer_setting("width", int(ref.get("width") or 1920), 320, 7680),
        integer_setting("height", int(ref.get("height") or 1080), 180, 4320),
        max(1.0, min(1000.0, fps)),
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
    if fit not in {"contain", "cover", "blur"}:
        fit = "contain"
    try:
        blur_amount = int(output.get("blur_amount") if output.get("blur_amount") is not None else 24)
    except (TypeError, ValueError):
        blur_amount = 24
    return fit, ffmpeg_color(output.get("background_color")), max(4, min(80, blur_amount))


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
