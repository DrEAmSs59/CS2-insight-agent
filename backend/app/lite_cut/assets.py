"""LiteCut user asset upload helpers (overlay fonts, WebM, stickers)."""

from __future__ import annotations

import re
import logging
import shutil
import subprocess
import struct
import threading
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from ..env_utils import get_data_dir, load_config

_ASSET_MAX_BYTES = 20 * 1024 * 1024 * 1024
_ASSET_UPLOAD_CHUNK_BYTES = 1024 * 1024
logger = logging.getLogger(__name__)

_ALLOWED_EXT = frozenset({
    ".webm",
    ".png",
    ".gif",
    ".jpg",
    ".jpeg",
    ".webp",
    ".mp4",
    ".mov",
    ".m4v",
    ".mkv",
    ".avi",
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".ogg",
    ".flac",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
})

_KIND_BY_EXT = {
    ".webm": "webm",
    ".mp4": "video",
    ".mov": "video",
    ".m4v": "video",
    ".mkv": "video",
    ".avi": "video",
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".aac": "audio",
    ".ogg": "audio",
    ".flac": "audio",
    ".png": "image",
    # GIFs are animated timeline media.  Keep the original for export, while
    # serving a seekable MP4 proxy to the browser preview.
    ".gif": "video",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".woff": "font",
    ".woff2": "font",
    ".ttf": "font",
    ".otf": "font",
}

_BROWSER_PROXY_EXTS = frozenset({".avi", ".mkv", ".gif", ".mov"})
_LARGE_VIDEO_PROXY_BYTES = 256 * 1024 * 1024
_PROXY_LOCKS = tuple(threading.Lock() for _ in range(64))


def _proxy_lock_for(path: Path) -> threading.Lock:
    """Serialize proxy creation for one asset across concurrent API requests."""
    return _PROXY_LOCKS[hash(str(path.resolve()).casefold()) % len(_PROXY_LOCKS)]


def lite_cut_assets_dir() -> Path:
    configured = str(load_config().lite_cut_assets_dir or "").strip()
    d = Path(configured).expanduser().resolve() if configured else get_data_dir() / "lite_cut_assets"
    d.mkdir(parents=True, exist_ok=True)
    return d


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
    return _KIND_BY_EXT.get(path.suffix.lower(), "file")


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
    # Versioned name: v2 preserves source cadence up to 60 fps. Keeping this
    # separate prevents reuse of older fixed-30-fps proxies.
    return path.with_name(f"{path.stem}.preview60.mp4")


def alpha_preview_proxy_path_for_asset(path: Path) -> Path:
    # Versioned so assets imported before preview fixes do not keep reusing a
    # stale/broken or silent transparent proxy. V3 preserves the source audio.
    return path.with_name(f"{path.stem}.preview-alpha-v3.webm")


def asset_companion_paths(path: Path) -> list[Path]:
    from .waveform import waveform_cache_path

    return [
        preview_proxy_path_for_asset(path),
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
    root = lite_cut_assets_dir().resolve()
    path = Path(raw_path).expanduser().resolve()
    try:
        path.relative_to(root)
    except ValueError:
        logger.warning("Refusing to delete LiteCut asset outside storage: %s", path)
        return
    for candidate in [*asset_companion_paths(path), path]:
        _unlink_with_retry(candidate)
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


def asset_stream_path(path: Path) -> Path:
    alpha_proxy = alpha_preview_proxy_path_for_asset(path)
    if alpha_proxy.is_file():
        return alpha_proxy
    proxy = preview_proxy_path_for_asset(path)
    return proxy if proxy.is_file() else path


def asset_needs_browser_proxy(path: Path) -> bool:
    if path.suffix.lower() in _BROWSER_PROXY_EXTS:
        return True
    if path.suffix.lower() in {".mp4", ".m4v"}:
        try:
            return path.stat().st_size >= _LARGE_VIDEO_PROXY_BYTES
        except OSError:
            return False
    return False


def preview_proxy_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    video_encode_quality: list[str],
    duration_sec: float | None = None,
    max_edge: int = 1280,
) -> list[str]:
    edge = max(360, min(2160, int(max_edge or 1280)))
    command = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
    ]
    if duration_sec is not None and duration_sec > 0:
        command.extend(["-t", f"{float(duration_sec):.6f}"])
    command.extend([
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))'",
        *video_encode_quality,
        "-fpsmax",
        "60",
        "-g",
        "30",
        "-force_key_frames",
        "expr:gte(t,n_forced*0.5)",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-movflags",
        "+faststart",
        str(output),
    ])
    return command


def _run_proxy_process(
    command: list[str],
    *,
    cancel_event: threading.Event | None = None,
    timeout_sec: float = 3600,
) -> subprocess.CompletedProcess[str]:
    """Run FFmpeg while allowing asset/project deletion to stop it cleanly."""
    if cancel_event is not None and cancel_event.is_set():
        return subprocess.CompletedProcess(command, 130, "", "cancelled")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + max(1.0, float(timeout_sec))
    while True:
        try:
            stdout, stderr = process.communicate(timeout=0.2)
            return subprocess.CompletedProcess(command, int(process.returncode or 0), stdout, stderr)
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
            return subprocess.CompletedProcess(command, 130 if cancelled else 124, stdout, stderr or reason)


def create_browser_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    video_encode_quality: list[str],
    duration_sec: float | None = None,
    cancel_event: threading.Event | None = None,
    max_edge: int = 1280,
) -> Path | None:
    """Create an MP4 preview for containers that ordinary browser video cannot decode."""
    if not asset_needs_browser_proxy(source):
        return None
    output = preview_proxy_path_for_asset(source)
    with _proxy_lock_for(output):
        if output.is_file():
            return output
        temporary = output.with_name(f"{output.stem}.{uuid.uuid4().hex}.tmp.mp4")
        try:
            result = _run_proxy_process(
                preview_proxy_command(
                    ffmpeg_bin=ffmpeg_bin,
                    source=source,
                    output=temporary,
                    video_encode_quality=video_encode_quality,
                    duration_sec=duration_sec,
                    max_edge=max_edge,
                ),
                cancel_event=cancel_event,
            )
            if result.returncode != 0 or not temporary.is_file():
                if cancel_event is not None and cancel_event.is_set():
                    temporary.unlink(missing_ok=True)
                    return None
                tail = (result.stderr or result.stdout or "").strip()[-600:]
                logger.warning("LiteCut preview proxy failed for %s: %s", source.name, tail)
                temporary.unlink(missing_ok=True)
                return None
            temporary.replace(output)
            return output
        except Exception:
            logger.warning("LiteCut preview proxy failed for %s", source.name, exc_info=True)
            temporary.unlink(missing_ok=True)
            return None


def alpha_preview_proxy_command(*, ffmpeg_bin: Path, source: Path, output: Path, duration_sec: float | None = None, max_edge: int = 1280) -> list[str]:
    edge = max(360, min(2160, int(max_edge or 1280)))
    command = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source)]
    if duration_sec is not None and duration_sec > 0:
        command.extend(["-t", f"{min(600.0, float(duration_sec)):.6f}"])
    command.extend([
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))',format=yuva420p",
        "-c:v", "libvpx-vp9",
        "-pix_fmt", "yuva420p",
        "-auto-alt-ref", "0",
        "-deadline", "good",
        "-cpu-used", "5",
        "-row-mt", "1",
        "-b:v", "0",
        "-crf", "28",
        "-fpsmax", "30",
        "-metadata:s:v:0", "alpha_mode=1",
        "-c:a", "libopus",
        "-b:a", "128k",
        str(output),
    ])
    return command


def create_alpha_browser_preview_proxy(
    source: Path,
    *,
    ffmpeg_bin: Path,
    duration_sec: float | None = None,
    cancel_event: threading.Event | None = None,
    max_edge: int = 1280,
) -> Path | None:
    """Create a browser-decodable VP9 WebM proxy while preserving MOV alpha."""
    output = alpha_preview_proxy_path_for_asset(source)
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
) -> Path | None:
    """Return an alpha-preserving browser proxy when ``source`` is an alpha MOV."""
    if source.suffix.lower() != ".mov":
        return None
    existing = alpha_preview_proxy_path_for_asset(source)
    if existing.is_file():
        return existing
    try:
        from ..video_composer import probe_video_audio_summary, resolve_ffprobe_binary

        info = probe_video_audio_summary(source, resolve_ffprobe_binary(ffmpeg_bin))
        if not info.get("has_alpha"):
            return None
        if cancel_event is not None and cancel_event.is_set():
            return None
        return create_alpha_browser_preview_proxy(
            source,
            ffmpeg_bin=ffmpeg_bin,
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
