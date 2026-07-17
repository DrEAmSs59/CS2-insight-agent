"""HTTP Range streaming for recorded clip video files."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse


def _guess_media_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed:
        return guessed
    ext = path.suffix.lower()
    if ext == ".mp4":
        return "video/mp4"
    if ext == ".webm":
        return "video/webm"
    if ext == ".mkv":
        return "video/x-matroska"
    return "application/octet-stream"


def validate_recorded_clip_path(raw_path: str) -> Path:
    """Resolve path, ensure it is an existing regular file."""
    if not raw_path or not str(raw_path).strip():
        raise HTTPException(400, "clip output_path is empty")
    path = Path(str(raw_path)).expanduser().resolve()
    if not path.is_file():
        raise HTTPException(404, "clip file not found")
    if not path.is_absolute():
        raise HTTPException(400, "invalid clip path")
    return path


async def stream_file_with_range(file_path: Path, request) -> FileResponse:
    """Serve a local file; Starlette FileResponse handles HTTP Range for <video> seek."""
    _ = request  # kept for API compatibility
    media_type = _guess_media_type(file_path)
    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=file_path.name,
        headers={"Accept-Ranges": "bytes"},
    )
