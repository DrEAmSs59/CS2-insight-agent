"""LiteCut export preflight, collision protection, and artifact validation."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Iterable

from ..video_composer import MontageComposerError, ffprobe_streams, resolve_ffprobe_binary, validate_output_path


def ensure_ffmpeg_runnable(ffmpeg_bin: Path) -> None:
    try:
        completed = subprocess.run(
            [str(ffmpeg_bin), "-version"],
            capture_output=True,
            timeout=12,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise MontageComposerError("MONTAGE_FFMPEG_NOT_RUNNABLE") from exc
    if completed.returncode != 0:
        raise MontageComposerError("MONTAGE_FFMPEG_NOT_RUNNABLE")


def unique_output_path(path_str: str, *, reserved: Iterable[str] = ()) -> Path:
    requested = validate_output_path(path_str)
    occupied = {os.path.normcase(str(Path(item).resolve(strict=False))) for item in reserved if item}
    if not requested.exists() and os.path.normcase(str(requested)) not in occupied:
        return requested
    for index in range(1, 10_000):
        candidate = requested.with_name(f"{requested.stem} ({index}){requested.suffix}")
        if not candidate.exists() and os.path.normcase(str(candidate)) not in occupied:
            return candidate
    raise MontageComposerError("MONTAGE_OUTPUT_NAME_EXHAUSTED")


def project_file_paths(project_body: dict[str, Any], recorded_paths: Iterable[Path]) -> list[Path]:
    found: dict[str, Path] = {}

    def visit(value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                visit(child, str(child_key))
            return
        if isinstance(value, list):
            for child in value:
                visit(child, key)
            return
        if key not in {"file_path", "font_file", "font_file_path", "path"} or not isinstance(value, str) or not value.strip():
            return
        path = Path(value).expanduser().resolve(strict=False)
        found[os.path.normcase(str(path))] = path

    visit(project_body)
    for path in recorded_paths:
        resolved = Path(path).expanduser().resolve(strict=False)
        found[os.path.normcase(str(resolved))] = resolved
    return list(found.values())


def ensure_files_readable(paths: Iterable[Path]) -> int:
    total_bytes = 0
    for path in paths:
        try:
            if not path.is_file():
                raise FileNotFoundError(str(path))
            total_bytes += max(0, int(path.stat().st_size))
            with path.open("rb") as stream:
                stream.read(1)
        except FileNotFoundError as exc:
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=path.name or str(path)) from exc
        except OSError as exc:
            raise MontageComposerError("MONTAGE_SOURCE_NOT_READABLE", name=path.name or str(path)) from exc
    return total_bytes


def estimate_required_space(project_body: dict[str, Any], source_bytes: int) -> int:
    # Normalized intermediates are segment-based, so use timeline duration rather
    # than the size of a potentially hours-long source recording.
    duration = 0.0
    for track in project_body.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                continue
            start = max(0.0, float(clip.get("timeline_start") or 0.0))
            trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
            trim_out = max(trim_in, float(clip.get("trim_out") or trim_in))
            duration = max(duration, start + max(0.0, trim_out - trim_in))
    # 40 Mbit/s working estimate plus fixed room for overlays/audio and muxing.
    duration_estimate = int(duration * 5_000_000)
    source_hint = min(max(0, int(source_bytes // 10)), 4 * 1024**3)
    return max(512 * 1024**2, duration_estimate + source_hint)


def ensure_output_space(output_path: Path, required_bytes: int) -> None:
    try:
        free = shutil.disk_usage(output_path.parent).free
    except OSError as exc:
        raise MontageComposerError("MONTAGE_OUTPUT_SPACE_CHECK_FAILED") from exc
    if free < required_bytes:
        raise MontageComposerError(
            "MONTAGE_OUTPUT_DISK_FULL",
            required_gb=f"{required_bytes / 1024**3:.1f}",
            free_gb=f"{free / 1024**3:.1f}",
        )


def validate_export_output(ffmpeg_bin: Path, output_path: Path) -> None:
    try:
        if not output_path.is_file() or output_path.stat().st_size <= 0:
            raise OSError("empty output")
        data = ffprobe_streams(output_path, resolve_ffprobe_binary(ffmpeg_bin))
        streams = data.get("streams") or []
        has_video = any(str(stream.get("codec_type") or "") == "video" for stream in streams if isinstance(stream, dict))
        if not has_video:
            raise OSError("no video stream")
    except Exception as exc:
        raise MontageComposerError("MONTAGE_OUTPUT_NOT_PLAYABLE") from exc


def remove_partial_output(output_path: str | Path) -> None:
    path = Path(output_path)
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass


def cleanup_stale_export_artifacts(output_paths: Iterable[str]) -> None:
    parents: set[Path] = set()
    for raw in output_paths:
        if not raw:
            continue
        path = Path(raw).expanduser().resolve(strict=False)
        remove_partial_output(path)
        parents.add(path.parent)
    for parent in parents:
        if not parent.is_dir():
            continue
        for temp_dir in parent.glob("cs2_lite_cut_*"):
            if temp_dir.is_dir():
                shutil.rmtree(temp_dir, ignore_errors=True)
