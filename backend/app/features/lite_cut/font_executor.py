"""Filesystem side effects used to stage custom fonts for FFmpeg."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path


def _ascii_ffmpeg_font_cache_dir() -> Path:
    """Return a writable ASCII-only directory for FFmpeg drawtext fonts.

    Some Windows FFmpeg/fontconfig builds crash when ``fontfile`` contains a
    non-ASCII path, even though FreeType can read the same font.  LiteCut
    project directories commonly contain Chinese project names, so imported
    fonts must be staged outside the project directory for export.
    """
    candidates: list[Path] = []
    program_data = str(os.environ.get("PROGRAMDATA") or "").strip()
    if program_data:
        candidates.append(Path(program_data) / "CS2InsightAgent" / "FontCache")
    public_dir = str(os.environ.get("PUBLIC") or "").strip()
    if public_dir:
        candidates.append(Path(public_dir) / "Documents" / "CS2InsightAgent" / "FontCache")
    candidates.append(Path(tempfile.gettempdir()) / "cs2_insight_font_cache")

    for candidate in candidates:
        try:
            str(candidate).encode("ascii")
            candidate.mkdir(parents=True, exist_ok=True)
            probe_fd, probe_name = tempfile.mkstemp(prefix="write_", suffix=".tmp", dir=str(candidate))
            os.close(probe_fd)
            Path(probe_name).unlink(missing_ok=True)
            return candidate
        except (OSError, UnicodeEncodeError):
            continue
    raise OSError("No writable ASCII-only font cache directory is available")

def _stage_custom_font_for_ffmpeg(font_file: str, *, cache_dir: Path | None = None) -> Path:
    """Copy an imported font to an ASCII-only path understood by FFmpeg."""
    source = Path(str(font_file or "")).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(str(source))
    target_dir = Path(cache_dir) if cache_dir is not None else _ascii_ffmpeg_font_cache_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    str(target_dir).encode("ascii")
    suffix = source.suffix.lower() if source.suffix.lower() in {".ttf", ".otf", ".ttc", ".woff", ".woff2"} else ".ttf"
    fd, target_name = tempfile.mkstemp(prefix="litecut_font_", suffix=suffix, dir=str(target_dir))
    os.close(fd)
    target = Path(target_name)
    try:
        shutil.copy2(source, target)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target
