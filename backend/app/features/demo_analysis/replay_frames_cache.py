"""Disk cache for per-round radar replay frames (JSON gzip MVP)."""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from .replay_cache_storage import (
    replay_cache_namespace_root,
    replay_cache_namespace_roots,
)
from .replay_cache_owners import invalidate_owner_index, register_replay_cache_entry

logger = logging.getLogger(__name__)

REPLAY_FRAMES_CACHE_VERSION = 1


def _cache_root() -> Path:
    return replay_cache_namespace_root("frames")


def _cache_roots() -> tuple[Path, ...]:
    primary = _cache_root()
    roots = [primary]
    for candidate in replay_cache_namespace_roots("frames", create_primary=False):
        if candidate not in roots:
            roots.append(candidate)
    return tuple(roots)


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
    path = next(
        (root / f"{cache_key}.json.gz" for root in _cache_roots() if (root / f"{cache_key}.json.gz").is_file()),
        None,
    )
    if path is None:
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


def _normalized_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


def remove_frames_for_demos(
    demo_paths: list[str],
    *,
    register_survivors: bool = False,
) -> dict[str, int]:
    """Remove several Demo owners while inflating legacy payloads only once."""
    wanted = {_normalized_path(path) for path in demo_paths}
    removed_files = 0
    removed_bytes = 0
    seen: set[str] = set()
    for root in _cache_roots():
        if not root.is_dir():
            continue
        for path in root.glob("*.json.gz"):
            path_key = _normalized_path(str(path))
            if path_key in seen:
                continue
            seen.add(path_key)
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    payload = json.load(handle)
                fingerprint = payload.get("demo_fingerprint") if isinstance(payload, dict) else None
                cached_path = fingerprint.get("path") if isinstance(fingerprint, dict) else None
                if not cached_path:
                    continue
                if _normalized_path(str(cached_path)) not in wanted:
                    if register_survivors:
                        register_replay_cache_entry(
                            "frames",
                            str(cached_path),
                            path.name.removesuffix(".json.gz"),
                            (path,),
                        )
                    continue
                size = int(path.stat().st_size)
                path.unlink(missing_ok=True)
                removed_files += 1
                removed_bytes += size
            except Exception as exc:  # noqa: BLE001 - cleanup is best effort
                logger.warning("replay frames cache cleanup failed for %s: %s", path, exc)
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


def remove_frames_for_demo(demo_path: str) -> dict[str, int]:
    """Remove legacy per-round payloads belonging to one Demo."""
    return remove_frames_for_demos([demo_path])


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
        fingerprint_path = (
            demo_fingerprint_meta.get("path")
            if isinstance(demo_fingerprint_meta, dict)
            else None
        )
        if fingerprint_path:
            try:
                register_replay_cache_entry(
                    "frames",
                    str(fingerprint_path),
                    cache_key,
                    (path,),
                )
            except OSError as exc:
                invalidate_owner_index()
                logger.warning("replay frames owner index update failed: %s", exc)
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
