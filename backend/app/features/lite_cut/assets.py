"""LiteCut user asset upload helpers (overlay fonts, WebM, stickers)."""

from __future__ import annotations

import re
import logging
import os
import shutil
import subprocess
import struct
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException, UploadFile

from ...env_utils import get_data_dir, load_config
from ...ffmpeg_process import decode_process_output
from .effect_contract import load_effect_contract
from .media_policy import (
    alpha_preview_proxy_command as build_alpha_preview_proxy_command,
    asset_exceeds_direct_preview_limits as exceeds_direct_preview_limits,
    asset_kind_for_path as classify_asset_path,
    asset_needs_browser_proxy as needs_browser_proxy,
    mp4_container_mentions_hevc,
    preview_proxy_command as build_preview_proxy_command,
    preview_proxy_remux_command as build_preview_proxy_remux_command,
)

_ASSET_MAX_BYTES = 20 * 1024 * 1024 * 1024
_ASSET_UPLOAD_CHUNK_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)

_ALLOWED_EXT = frozenset(
    f".{str(extension).strip().lower().lstrip('.')}"
    for extension in load_effect_contract().get("import_extensions", [])
    if str(extension).strip()
)

_PROXY_LOCKS = tuple(threading.Lock() for _ in range(64))


def _proxy_lock_for(path: Path) -> threading.Lock:
    """Serialize proxy creation for one asset across concurrent API requests."""
    return _PROXY_LOCKS[hash(str(path.resolve()).casefold()) % len(_PROXY_LOCKS)]


def lite_cut_assets_dir() -> Path:
    configured = str(load_config().lite_cut_assets_dir or "").strip()
    d = Path(configured).expanduser().resolve() if configured else get_data_dir() / "lite_cut_assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def lite_cut_derived_cache_dir() -> Path:
    directory = lite_cut_assets_dir() / ".derived"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


_WINDOWS_RESERVED_DIR_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def project_asset_directory_name(project_name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(project_name or "").strip())
    name = name.rstrip(" .")[:120] or "未命名工程"
    if name.upper() in _WINDOWS_RESERVED_DIR_NAMES:
        name = f"_{name}"
    return name


def project_asset_directory(project_name: str) -> Path:
    directory = lite_cut_assets_dir() / project_asset_directory_name(project_name)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def stable_project_asset_directory(project_id: int, project_name: str, existing_paths: list[str] | None = None) -> Path:
    """Return one rename-safe directory while preserving legacy project folders."""
    root = lite_cut_assets_dir().resolve()
    for raw_path in existing_paths or []:
        try:
            parent = Path(str(raw_path)).expanduser().resolve().parent
            parent.relative_to(root)
            if parent != root:
                parent.mkdir(parents=True, exist_ok=True)
                return parent
        except (OSError, ValueError):
            continue
    prefix = f"{int(project_id)}_"
    try:
        existing = next((item for item in root.iterdir() if item.is_dir() and item.name.startswith(prefix)), None)
    except OSError:
        existing = None
    if existing is not None:
        return existing
    directory = root / f"{prefix}{project_asset_directory_name(project_name)}"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def asset_kind_for_path(path: Path) -> str:
    return classify_asset_path(path)


def validate_linked_asset_path(raw_path: str) -> Path:
    """Validate one user-selected external source without broadening stream access."""
    if not raw_path or not str(raw_path).strip():
        raise HTTPException(400, "asset path empty")
    candidate = Path(str(raw_path)).expanduser()
    if not candidate.is_absolute():
        raise HTTPException(400, "linked asset path must be absolute")
    try:
        path = candidate.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(404, "asset file not found") from exc
    if not path.is_file():
        raise HTTPException(404, "asset file not found")
    if path.suffix.lower() not in _ALLOWED_EXT:
        raise HTTPException(400, f"unsupported file type: {path.suffix.lower() or '(none)'}")
    return path


def asset_source_path(row: dict[str, Any]) -> Path:
    """Resolve the source recorded for an asset row using its storage policy."""
    mode = str(row.get("storage_mode") or "managed").strip().lower()
    raw_path = row.get("original_path") if mode == "link" else row.get("managed_path")
    raw_path = str(raw_path or row.get("file_path") or "")
    return validate_linked_asset_path(raw_path) if mode == "link" else validate_stored_asset_path(raw_path)


def asset_source_status(row: dict[str, Any]) -> str:
    # Imported linked-project assets intentionally keep their original path as
    # a locator hint even when it is unavailable or failed identity checks.
    # They stay offline until the explicit, validated relink operation updates
    # the persisted state to available.
    if str(row.get("source_status") or "").strip().lower() == "missing":
        return "missing"
    mode = str(row.get("storage_mode") or "managed").strip().lower()
    raw_path = row.get("original_path") if mode == "link" else row.get("managed_path")
    path = Path(str(raw_path or row.get("file_path") or "")).expanduser()
    try:
        stat = path.stat()
    except OSError:
        return "missing"
    if not path.is_file():
        return "missing"
    expected_size = row.get("size_bytes")
    expected_mtime = row.get("mtime_ns")
    if expected_size is not None and int(expected_size) != int(stat.st_size):
        return "changed"
    if expected_mtime is not None and int(expected_mtime) != int(stat.st_mtime_ns):
        return "changed"
    return "available"


def _derived_asset_directory(row: dict[str, Any]) -> Path:
    asset_id = max(0, int(row.get("id") or 0))
    fingerprint = re.sub(r"[^a-zA-Z0-9_-]+", "", str(row.get("fingerprint") or ""))[:20] or "source"
    return lite_cut_derived_cache_dir() / f"asset-{asset_id}-{fingerprint}"


def asset_preview_paths(row: dict[str, Any]) -> tuple[Path, Path]:
    source = Path(str(row.get("file_path") or ""))
    if str(row.get("storage_mode") or "managed").lower() != "link":
        return preview_proxy_path_for_asset(source), alpha_preview_proxy_path_for_asset(source)
    directory = _derived_asset_directory(row)
    return directory / "preview60-v3.mp4", directory / "preview-alpha-v3.webm"


def asset_waveform_cache_path(row: dict[str, Any]) -> Path:
    if str(row.get("storage_mode") or "managed").lower() != "link":
        from .waveform import waveform_cache_path

        return waveform_cache_path(Path(str(row.get("file_path") or "")))
    return _derived_asset_directory(row) / "waveform-v1.json"


def probe_image_dimensions(path: Path) -> tuple[int, int] | None:
    """Read raster dimensions without decoding the full (possibly huge) image."""
    try:
        with path.open("rb") as source:
            head = source.read(32)
            if head.startswith(b"\x89PNG\r\n\x1a\n") and len(head) >= 24:
                width, height = struct.unpack(">II", head[16:24])
                return (width, height) if width > 0 and height > 0 else None
            if head[:2] == b"\xff\xd8":
                source.seek(2)
                while True:
                    marker_start = source.read(1)
                    if not marker_start:
                        break
                    if marker_start != b"\xff":
                        continue
                    marker = source.read(1)
                    while marker == b"\xff":
                        marker = source.read(1)
                    if not marker or marker in {b"\xd8", b"\xd9"}:
                        continue
                    length_raw = source.read(2)
                    if len(length_raw) != 2:
                        break
                    length = struct.unpack(">H", length_raw)[0]
                    if marker[0] in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                        frame = source.read(5)
                        if len(frame) == 5:
                            height, width = struct.unpack(">HH", frame[1:5])
                            return (width, height) if width > 0 and height > 0 else None
                        break
                    source.seek(max(0, length - 2), 1)
    except OSError:
        return None
    return None


def preview_proxy_path_for_asset(path: Path) -> Path:
    # Versioned name: v3 also marks proxies created for high-cadence/high-
    # bitrate sources. Keeping this separate prevents a stale size-only proxy
    # from being mistaken for an intentional smooth-playback proxy.
    return path.with_name(f"{path.stem}.preview60-v3.mp4")


def alpha_preview_proxy_path_for_asset(path: Path) -> Path:
    # Versioned so assets imported before preview fixes do not keep reusing a
    # stale/broken or silent transparent proxy. V3 preserves the source audio.
    return path.with_name(f"{path.stem}.preview-alpha-v3.webm")


def asset_companion_paths(path: Path) -> list[Path]:
    from .waveform import waveform_cache_path

    return [
        preview_proxy_path_for_asset(path),
        path.with_name(f"{path.stem}.preview60.mp4"),
        path.with_name(f"{path.stem}.preview.mp4"),
        alpha_preview_proxy_path_for_asset(path),
        path.with_name(f"{path.stem}.preview-alpha-v2.webm"),
        path.with_name(f"{path.stem}.preview.webm"),
        waveform_cache_path(path),
    ]


def _unlink_with_retry(path: Path, *, attempts: int = 50, delay_sec: float = 0.1) -> None:
    """Delete a file after short-lived Windows media handles are released."""
    for attempt in range(attempts):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(delay_sec)


def delete_asset_file_bundle(raw_path: str | Path) -> None:
    for candidate in asset_file_bundle_paths(raw_path):
        _unlink_with_retry(candidate)
    remove_empty_asset_directory(raw_path)


def asset_file_bundle_paths(raw_path: str | Path) -> list[Path]:
    """Return existing files in one managed asset bundle without mutating disk."""
    root = lite_cut_assets_dir().resolve()
    path = Path(raw_path).expanduser().resolve()
    try:
        path.relative_to(root)
    except ValueError:
        logger.warning("Refusing to delete LiteCut asset outside storage: %s", path)
        return []
    return [candidate for candidate in [*asset_companion_paths(path), path] if candidate.is_file()]


def asset_row_bundle_paths(row: dict[str, Any]) -> list[Path]:
    """Return deletable files for an asset while protecting linked originals."""
    is_link = str(row.get("storage_mode") or "managed").lower() == "link"
    if is_link:
        normal_proxy, alpha_proxy = asset_preview_paths(row)
        waveform = asset_waveform_cache_path(row)
        files = [candidate for candidate in (normal_proxy, alpha_proxy, waveform) if candidate.is_file()]
    else:
        files = asset_file_bundle_paths(str(row.get("managed_path") or row.get("file_path") or ""))
    root = lite_cut_assets_dir().resolve()
    asset_id = max(0, int(row.get("id") or 0))
    for directory in root.glob(f"*/.preview/asset-{asset_id}-*"):
        try:
            directory.resolve().relative_to(root)
        except (OSError, ValueError):
            continue
        files.extend(candidate for candidate in directory.rglob("*") if candidate.is_file())
    return list(dict.fromkeys(files))


def delete_asset_row_bundle(row: dict[str, Any]) -> None:
    candidates = asset_row_bundle_paths(row)
    for candidate in candidates:
        _unlink_with_retry(candidate)
    from .proxy_executor import remove_segment_preview_files

    remove_segment_preview_files(row)
    if str(row.get("storage_mode") or "managed").lower() == "link":
        try:
            _derived_asset_directory(row).rmdir()
        except OSError:
            pass
        root = lite_cut_assets_dir().resolve()
        for candidate in candidates:
            parent = candidate.parent
            while parent != root:
                try:
                    parent.relative_to(root)
                    parent.rmdir()
                except (OSError, ValueError):
                    break
                parent = parent.parent
    else:
        remove_empty_asset_directory(str(row.get("managed_path") or row.get("file_path") or ""))


def remove_empty_asset_directory(raw_path: str | Path) -> None:
    root = lite_cut_assets_dir().resolve()
    path = Path(raw_path).expanduser().resolve()
    parent = path.parent
    if parent != root:
        try:
            parent.rmdir()
        except OSError:
            pass


def relocate_asset_file_bundle(raw_path: str | Path, project_name: str) -> Path:
    root = lite_cut_assets_dir().resolve()
    source = Path(raw_path).expanduser().resolve()
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise ValueError("asset path outside storage") from exc
    if not source.is_file():
        raise FileNotFoundError(source)
    target_dir = project_asset_directory(project_name).resolve()
    if source.parent == target_dir:
        return source
    target = target_dir / source.name
    if target.exists() and target.resolve() != source:
        target = target.with_name(f"{target.stem}_{uuid.uuid4().hex[:8]}{target.suffix}")
    source_companions = asset_companion_paths(source)
    target_companions = asset_companion_paths(target)
    with _proxy_lock_for(source):
        for old, new in zip(source_companions, target_companions):
            if old.is_file():
                shutil.move(str(old), str(new))
        if source.is_file():
            shutil.move(str(source), str(target))
    if source.parent != root:
        try:
            source.parent.rmdir()
        except OSError:
            pass
    return target


def asset_stream_path(
    path: Path,
    *,
    video_codec: str | None = None,
    duration_sec: float | None = None,
    fps: float | None = None,
) -> Path:
    # Direct-source preview policy: legacy proxy files are never selected.
    _ = (video_codec, duration_sec, fps)
    return path


def asset_stream_path_for_row(row: dict[str, Any]) -> Path:
    return asset_source_path(row)


def _mp4_container_mentions_hevc(path: Path) -> bool:
    return mp4_container_mentions_hevc(path)


def asset_exceeds_direct_preview_limits(
    path: Path,
    *,
    duration_sec: float | None = None,
    fps: float | None = None,
) -> bool:
    return exceeds_direct_preview_limits(path, duration_sec=duration_sec, fps=fps)


def asset_needs_browser_proxy(
    path: Path,
    *,
    video_codec: str | None = None,
    duration_sec: float | None = None,
    fps: float | None = None,
) -> bool:
    return needs_browser_proxy(path, video_codec=video_codec, duration_sec=duration_sec, fps=fps)


def preview_proxy_remux_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    duration_sec: float | None = None,
    copy_audio: bool = False,
) -> list[str]:
    return build_preview_proxy_remux_command(
        ffmpeg_bin=ffmpeg_bin,
        source=source,
        output=output,
        duration_sec=duration_sec,
        copy_audio=copy_audio,
    )


def preview_proxy_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    video_encode_quality: list[str],
    duration_sec: float | None = None,
    max_edge: int = 1280,
) -> list[str]:
    return build_preview_proxy_command(
        ffmpeg_bin=ffmpeg_bin,
        source=source,
        output=output,
        video_encode_quality=video_encode_quality,
        duration_sec=duration_sec,
        max_edge=max_edge,
    )


def audio_preview_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    copy_audio: bool,
) -> list[str]:
    command = [
        str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(source), "-map", "0:a:0", "-vn", "-c:a", "copy" if copy_audio else "aac",
    ]
    if not copy_audio:
        command.extend(["-b:a", "128k"])
    command.extend(["-map_metadata", "-1", "-movflags", "+faststart", str(output)])
    return command


def _run_proxy_process(
    command: list[str],
    *,
    cancel_event: threading.Event | None = None,
    idle_priority: bool = False,
    timeout_sec: float = 3600,
) -> subprocess.CompletedProcess[str]:
    """Run FFmpeg while allowing asset/project deletion to stop it cleanly."""
    if cancel_event is not None and cancel_event.is_set():
        return subprocess.CompletedProcess(command, 130, "", "cancelled")
    creation_flags = 0
    if os.name == "nt":
        priority_class = (
            getattr(subprocess, "IDLE_PRIORITY_CLASS", 0)
            if idle_priority
            else getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        )
        creation_flags = (
            priority_class
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        creationflags=creation_flags,
    )
    deadline = time.monotonic() + max(1.0, float(timeout_sec))
    while True:
        try:
            stdout, stderr = process.communicate(timeout=0.2)
            return subprocess.CompletedProcess(
                command,
                int(process.returncode or 0),
                decode_process_output(stdout),
                decode_process_output(stderr),
            )
        except subprocess.TimeoutExpired:
            cancelled = cancel_event is not None and cancel_event.is_set()
            timed_out = time.monotonic() >= deadline
            if not cancelled and not timed_out:
                continue
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            reason = "cancelled" if cancelled else "preview proxy timed out"
            return subprocess.CompletedProcess(
                command,
                130 if cancelled else 124,
                decode_process_output(stdout),
                decode_process_output(stderr) or reason,
            )


def create_browser_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    video_encode_quality: list[str] | Callable[[], list[str]],
    output_path: Path | None = None,
    duration_sec: float | None = None,
    cancel_event: threading.Event | None = None,
    max_edge: int = 1280,
    copy_video: bool = False,
    copy_audio: bool = False,
    force: bool = False,
    on_mode_change: Callable[[str], None] | None = None,
) -> Path | None:
    """Create an MP4 preview for containers that ordinary browser video cannot decode."""
    if not force and not asset_needs_browser_proxy(source):
        return None
    output = output_path or preview_proxy_path_for_asset(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with _proxy_lock_for(output):
        if output.is_file():
            return output
        temporary = output.with_name(f"{output.stem}.{uuid.uuid4().hex}.tmp.mp4")
        try:
            commands: list[tuple[str, Callable[[], list[str]]]] = []
            if copy_video:
                commands.append((
                    "remux",
                    lambda: preview_proxy_remux_command(
                        ffmpeg_bin=ffmpeg_bin,
                        source=source,
                        output=temporary,
                        duration_sec=duration_sec,
                        copy_audio=copy_audio,
                    ),
                ))
            commands.append((
                "transcode",
                lambda: preview_proxy_command(
                    ffmpeg_bin=ffmpeg_bin,
                    source=source,
                    output=temporary,
                    video_encode_quality=(
                        video_encode_quality()
                        if callable(video_encode_quality)
                        else video_encode_quality
                    ),
                    duration_sec=duration_sec,
                    max_edge=max_edge,
                ),
            ))
            last_result: subprocess.CompletedProcess[str] | None = None
            for mode, build_command in commands:
                if on_mode_change is not None:
                    on_mode_change(mode)
                temporary.unlink(missing_ok=True)
                result = _run_proxy_process(build_command(), cancel_event=cancel_event)
                last_result = result
                if result.returncode == 0 and temporary.is_file():
                    temporary.replace(output)
                    return output
                if cancel_event is not None and cancel_event.is_set():
                    temporary.unlink(missing_ok=True)
                    return None
                if mode == "remux":
                    logger.info("LiteCut fast remux unavailable for %s; falling back to transcode", source.name)
            tail = ((last_result.stderr or last_result.stdout) if last_result else "").strip()[-600:]
            logger.warning("LiteCut preview proxy failed for %s: %s", source.name, tail)
            temporary.unlink(missing_ok=True)
            return None
        except Exception:
            logger.warning("LiteCut preview proxy failed for %s", source.name, exc_info=True)
            temporary.unlink(missing_ok=True)
            return None


def create_audio_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    output_path: Path,
    audio_codec: str | None = None,
) -> Path | None:
    """Create one full-duration, seekable audio cache without decoding video."""
    output = output_path.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with _proxy_lock_for(output):
        if output.is_file() and output.stat().st_size > 0:
            return output
        temporary = output.with_name(f".{output.stem}.{uuid.uuid4().hex}.partial{output.suffix}")
        copy_first = str(audio_codec or "").strip().lower() == "aac"
        modes = [True, False] if copy_first else [False]
        last_result: subprocess.CompletedProcess[str] | None = None
        try:
            for copy_audio in modes:
                temporary.unlink(missing_ok=True)
                command = audio_preview_command(
                    ffmpeg_bin=ffmpeg_bin,
                    source=source,
                    output=temporary,
                    copy_audio=copy_audio,
                )
                result = _run_proxy_process(command, timeout_sec=1800)
                last_result = result
                if result.returncode == 0 and temporary.is_file() and temporary.stat().st_size > 0:
                    temporary.replace(output)
                    return output
                if copy_audio:
                    logger.info("LiteCut audio stream copy unavailable for %s; falling back to AAC", source.name)
            tail = ((last_result.stderr or last_result.stdout) if last_result else "").strip()[-600:]
            logger.warning("LiteCut audio preview failed for %s: %s", source.name, tail)
            return None
        except Exception:
            logger.warning("LiteCut audio preview failed for %s", source.name, exc_info=True)
            return None
        finally:
            temporary.unlink(missing_ok=True)


def alpha_preview_proxy_command(*, ffmpeg_bin: Path, source: Path, output: Path, duration_sec: float | None = None, max_edge: int = 1280) -> list[str]:
    return build_alpha_preview_proxy_command(
        ffmpeg_bin=ffmpeg_bin,
        source=source,
        output=output,
        duration_sec=duration_sec,
        max_edge=max_edge,
    )


def create_alpha_browser_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    output_path: Path | None = None,
    duration_sec: float | None = None,
    cancel_event: threading.Event | None = None,
    max_edge: int = 1280,
) -> Path | None:
    """Create a browser-decodable VP9 WebM proxy while preserving MOV alpha."""
    output = output_path or alpha_preview_proxy_path_for_asset(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with _proxy_lock_for(output):
        if output.is_file():
            return output
        temporary = output.with_name(f"{output.stem}.{uuid.uuid4().hex}.tmp.webm")
        try:
            result = _run_proxy_process(
                alpha_preview_proxy_command(ffmpeg_bin=ffmpeg_bin, source=source, output=temporary, duration_sec=duration_sec, max_edge=max_edge),
                cancel_event=cancel_event,
            )
            if result.returncode != 0 or not temporary.is_file():
                if cancel_event is not None and cancel_event.is_set():
                    temporary.unlink(missing_ok=True)
                    return None
                tail = (result.stderr or result.stdout or "").strip()[-600:]
                logger.warning("LiteCut alpha preview proxy failed for %s: %s", source.name, tail)
                temporary.unlink(missing_ok=True)
                return None
            temporary.replace(output)
            return output
        except Exception:
            logger.warning("LiteCut alpha preview proxy failed for %s", source.name, exc_info=True)
            temporary.unlink(missing_ok=True)
            return None


def ensure_alpha_mov_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    duration_sec: float | None = None,
    cancel_event: threading.Event | None = None,
    max_edge: int = 1280,
    has_alpha: bool | None = None,
    output_path: Path | None = None,
) -> Path | None:
    """Return an alpha-preserving browser proxy when ``source`` is an alpha MOV."""
    if source.suffix.lower() != ".mov":
        return None
    existing = output_path or alpha_preview_proxy_path_for_asset(source)
    if existing.is_file():
        return existing
    if has_alpha is False:
        return None
    try:
        from ...video_composer import probe_video_audio_summary, resolve_ffprobe_binary

        info: dict = {}
        if has_alpha is None:
            info = probe_video_audio_summary(source, resolve_ffprobe_binary(ffmpeg_bin))
            if not info.get("has_alpha"):
                return None
        if cancel_event is not None and cancel_event.is_set():
            return None
        return create_alpha_browser_preview_proxy(
            source,
            ffmpeg_bin=ffmpeg_bin,
            output_path=existing,
            duration_sec=duration_sec or info.get("duration"),
            cancel_event=cancel_event,
            max_edge=max_edge,
        )
    except Exception:
        logger.warning("LiteCut alpha MOV detection failed for %s", source.name, exc_info=True)
        return None


def validate_asset_filename(name: str) -> str:
    base = Path(name or "asset").name
    if not base or base in (".", ".."):
        raise HTTPException(400, "invalid filename")
    if ".." in base or "/" in base or "\\" in base:
        raise HTTPException(400, "invalid filename")
    return base


def validate_stored_asset_path(raw_path: str) -> Path:
    if not raw_path or not str(raw_path).strip():
        raise HTTPException(400, "asset path empty")
    assets_root = lite_cut_assets_dir().resolve()
    path = Path(str(raw_path)).expanduser().resolve()
    if not path.is_file():
        raise HTTPException(404, "asset file not found")
    try:
        path.relative_to(assets_root)
    except ValueError as exc:
        raise HTTPException(403, "asset path outside storage") from exc
    return path


async def save_uploaded_asset(
    file: UploadFile,
    *,
    project_name: str | None = None,
    destination_dir: Path | None = None,
) -> tuple[Path, str, str]:
    """Write an upload into its project folder. Returns (path, kind, mime)."""
    original = validate_asset_filename(file.filename or "asset.bin")
    suffix = Path(original).suffix.lower()
    if suffix not in _ALLOWED_EXT:
        raise HTTPException(400, f"unsupported file type: {suffix or '(none)'}")

    safe_stem = re.sub(r"[^a-zA-Z0-9_\-.]+", "_", Path(original).stem)[:80] or "asset"
    resolved_destination = destination_dir or (project_asset_directory(project_name) if project_name else lite_cut_assets_dir())
    resolved_destination.mkdir(parents=True, exist_ok=True)
    dest = resolved_destination / f"{safe_stem}_{uuid.uuid4().hex[:10]}{suffix}"
    bytes_written = 0
    try:
        with dest.open("wb") as output:
            while chunk := await file.read(_ASSET_UPLOAD_CHUNK_BYTES):
                bytes_written += len(chunk)
                if bytes_written > _ASSET_MAX_BYTES:
                    raise HTTPException(400, "file too large (max 20GB)")
                output.write(chunk)
        if bytes_written <= 0:
            raise HTTPException(400, "empty file")
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    mime = file.content_type or ""
    kind = asset_kind_for_path(dest)
    # Browsers produce microphone recordings as audio/webm. WebM is also used
    # for visual overlays, so the MIME type is the only reliable distinction.
    if suffix == ".webm" and mime.lower().startswith("audio/"):
        kind = "audio"
    return dest, kind, mime
