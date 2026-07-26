"""Disk cache for per-round radar replay frames (JSON gzip MVP)."""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

REPLAY_FRAMES_CACHE_VERSION = 1


def _cache_root() -> Path:
    try:
        from app.env_utils import get_data_dir

        root = get_data_dir() / "replay-frames"
    except Exception:
        root = Path.cwd() / "data" / "replay-frames"
    root.mkdir(parents=True, exist_ok=True)
    return root


def demo_fingerprint(demo_path: str) -> dict[str, Any] | None:
    try:
        path = Path(demo_path).resolve()
        stat = path.stat()
    except OSError:
        return None
    return {
        "path": str(path),
        "size": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
    }


def frames_cache_key(
    demo_path: str,
    *,
    round_number: int | None,
    start_tick: int,
    end_tick: int,
    fps: float,
    transform_version: int = 1,
) -> str | None:
    fp = demo_fingerprint(demo_path)
    if not fp:
        return None
    raw = (
        f"{REPLAY_FRAMES_CACHE_VERSION}|{fp['path']}|{fp['size']}|{fp['mtime_ns']}|"
        f"{round_number}|{start_tick}|{end_tick}|{fps}|{transform_version}"
    )
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:40]


def load_frames(cache_key: str) -> dict[str, Any] | None:
    path = _cache_root() / f"{cache_key}.json.gz"
    if not path.is_file():
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay frames cache load failed: %s", exc)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload, dict) or payload.get("version") != REPLAY_FRAMES_CACHE_VERSION:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload.get("frames"), list):
        return None
    return payload


def save_frames(
    cache_key: str,
    *,
    frames: list[dict[str, Any]],
    fps: float,
    start_tick: int,
    end_tick: int,
    map_transform: dict[str, Any] | None,
    effect_tracks: list[dict[str, Any]] | None = None,
    effect_capabilities: dict[str, Any] | None = None,
    effect_warnings: list[str] | None = None,
    effect_parse_ms: float | None = None,
    effect_tracks_version: int = 1,
    demo_fingerprint_meta: dict[str, Any] | None = None,
) -> None:
    path = _cache_root() / f"{cache_key}.json.gz"
    tmp = path.with_name(f"{path.name}.partial")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": REPLAY_FRAMES_CACHE_VERSION,
        "generated_at": time.time(),
        "frames": frames,
        "fps": fps,
        "start_tick": start_tick,
        "end_tick": end_tick,
        "map_transform": map_transform,
        "effect_tracks": list(effect_tracks or []),
        "effect_capabilities": effect_capabilities or {},
        "effect_warnings": list(effect_warnings or []),
        "effect_parse_ms": effect_parse_ms,
        "effect_tracks_version": effect_tracks_version,
        "demo_fingerprint": demo_fingerprint_meta,
    }
    try:
        with gzip.open(tmp, "wt", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        tmp.replace(path)
        logger.info(
            "replay frames cache saved key=%s frames=%s bytes=%s",
            cache_key,
            len(frames),
            path.stat().st_size,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay frames cache save failed: %s", exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
