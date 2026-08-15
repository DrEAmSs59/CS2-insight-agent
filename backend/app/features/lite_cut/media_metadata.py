"""Stable metadata DTO between media probes, policy and proxy executors."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class MediaMetadata:
    video_codec: str = ""
    audio_codec: str = ""
    pixel_format: str = ""
    fps: float | None = None
    has_alpha: bool | None = None
    duration_sec: float | None = None
    width: int | None = None
    height: int | None = None

    @classmethod
    def from_probe(cls, raw: Mapping[str, Any] | None) -> "MediaMetadata":
        source = raw or {}

        def positive_float(value: Any) -> float | None:
            try:
                number = float(value or 0)
            except (TypeError, ValueError):
                return None
            return number if number > 0 else None

        def positive_int(value: Any) -> int | None:
            try:
                number = int(value or 0)
            except (TypeError, ValueError):
                return None
            return number if number > 0 else None

        return cls(
            video_codec=str(source.get("codec_name") or "").strip().lower(),
            audio_codec=str(source.get("audio_codec_name") or "").strip().lower(),
            pixel_format=str(source.get("pixel_format") or "").strip().lower(),
            fps=positive_float(source.get("fps")),
            has_alpha=bool(source.get("has_alpha")) if "has_alpha" in source else None,
            duration_sec=positive_float(source.get("duration_sec")),
            width=positive_int(source.get("width")),
            height=positive_int(source.get("height")),
        )
