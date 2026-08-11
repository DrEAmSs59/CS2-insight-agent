"""Pure selectors over schema-v2 LiteCut timeline dictionaries."""

from __future__ import annotations

from typing import Any


def project_tracks(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    source = body if isinstance(body, dict) else {}
    tracks = source.get("tracks")
    return [track for track in tracks if isinstance(track, dict)] if isinstance(tracks, list) else []


def track_by_id(body: dict[str, Any] | None, track_id: str | None) -> dict[str, Any] | None:
    wanted = str(track_id or "")
    return next((track for track in project_tracks(body) if str(track.get("id") or "") == wanted), None)


def track_clips(track: dict[str, Any] | None) -> list[dict[str, Any]]:
    clips = track.get("clips") if isinstance(track, dict) else None
    return [clip for clip in clips if isinstance(clip, dict)] if isinstance(clips, list) else []


def project_clips(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [clip for track in project_tracks(body) for clip in track_clips(track)]


def clip_by_id(body: dict[str, Any] | None, clip_id: str | None) -> tuple[dict[str, Any] | None, str | None]:
    wanted = str(clip_id or "")
    for track in project_tracks(body):
        clip = next((item for item in track_clips(track) if str(item.get("id") or "") == wanted), None)
        if clip is not None:
            return clip, str(track.get("id") or "")
    return None, None


def visible_video_tracks(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [
        track
        for track in project_tracks(body)
        if track.get("type") in (None, "video") and not track.get("hidden")
    ]


def audio_tracks(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [track for track in project_tracks(body) if track.get("type") == "audio"]


def has_solo_audio_tracks(body: dict[str, Any] | None) -> bool:
    return any(track.get("solo") for track in audio_tracks(body))


def project_overlays(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    source = body if isinstance(body, dict) else {}
    overlays = source.get("overlays")
    return [overlay for overlay in overlays if isinstance(overlay, dict)] if isinstance(overlays, list) else []
